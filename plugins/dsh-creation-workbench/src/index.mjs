import { realpath } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ProjectRegistry } from './project-registry.mjs';
import { listProjectDirectory } from './project-directory.mjs';
import { registerWorkbenchSkills } from './skills.mjs';
import { IMPORT_MAX_BYTES } from './material-import.mjs';
import { createWorkbenchSkillCatalog } from './skill-catalog.mjs';
import { extractSkillNames } from './skill-commands.mjs';
import { importedFileResponse } from './media-response.mjs';
import { createArtifactPreview } from './artifact-preview.mjs';
import { createNativeTaskStateTracker } from './native-task-state.mjs';
import { createTaskControl } from './task-control.mjs';
import { readReviewImage } from './review-image.mjs';
import { editorParentOrigin } from './baoyu-runtime.mjs';
import { createProductionObserver } from './production-control.mjs';
import { DocumentPreview } from './document-preview.mjs';

export { Config } from './media-service-config.mjs';
import { Config as MediaConfig } from './media-service-config.mjs';
import { createMediaServiceAccess } from './media-service-host.mjs';
import { mediaServiceProfiles } from './media-service-settings.mjs';

export const name = 'wtt-creation-workbench';
export const inject = ['connection', 'tools', 'skills', 'agents', 'sessionQuery'];

export function apply(ctx, config = {}) {
  const mediaServiceAccess = createMediaServiceAccess(ctx, config);
  ctx.inject?.(['settings'], child => child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)));
  ctx.on?.('internal/config', function(_raw, next) {
    const raw = next();
    if (this === ctx.fiber) mediaServiceProfiles(MediaConfig(raw).mediaServices);
    return raw;
  });
  const taskRuntime = createNativeTaskStateTracker(ctx);
  const taskControl = createTaskControl(ctx, taskRuntime);
  const productionObserver = createProductionObserver(ctx);
  ctx.effect(() => () => productionObserver.close());
  const projects = new ProjectRegistry({ ...config, mediaServiceAccess,
    attachProduction: productionObserver.attach, readProductionUsage: productionObserver.read, refreshProductionUsage: productionObserver.refresh,
    deliverSlideComments: async (sessionId, message) => {
      const agent = ctx.get("agents")?.get(sessionId);
      if (!agent) throw new Error('原课程会话未恢复，批注保留在工程内；请恢复执行与确认后重新发送批注');
      if (agent.status === 'idle') agent.followup(message); else agent.inject(message);
    }, runtimeStateReader: (task, service) => {
      const state = taskRuntime.read(task, service), budget = service.production?.usage(task.id)?.budgetStop;
      return budget && state?.phase !== 'generating' ? { phase: 'idle', message: budget } : state;
    } });
  ctx.effect(() => () => taskRuntime.close());
  registerWorkbenchSkills(ctx, projects.get());
  const catalogReady = createWorkbenchSkillCatalog(ctx, { ...config });
  catalogReady.catch(() => {});
  let syncedServices = new WeakSet();
  const syncServiceSkills = async (service, force = false) => {
    if (!force && syncedServices.has(service)) return;
    await catalogReady;
    if (typeof ctx.skills?.get !== 'function') return;
    const names = ['wtt-markdown-to-docx', 'wtt-course-eight-steps-dev', 'wtt-course-pptx-generator', 'wtt-course-pptx-builder', 'wtt-course-exercise-builder', 'wtt-course-scriptwriter'];
    const skills = await Promise.all(names.map(name => ctx.skills.get(name, { cwd: service.workspaceRoot })));
    service.applyLocalSkillPaths(skills.filter(Boolean));
    syncedServices.add(service);
  };

  ctx.effect(() => () => { void catalogReady.then(catalog => catalog.close()).catch(() => {}); });
  ctx.effect(() => () => projects.close());
  const previews = new Map();
  const documentPreviews = new Map();
  const environmentFor = async service => {
    const result = service.environment();
    let preset;
    try { preset = await ctx.get('agentPresets')?.resolve('wtt-course-economy'); }
    catch (error) { result.checks.push({ name: '工作台节省预设', available: false, message: error.message }); return result; }
    result.checks.push({ name: '工作台节省预设', available: Boolean(preset && !preset.broken), message: preset?.broken || (preset ? '预设已注册，按模型窗口压力整理历史' : '找不到工作台节省预设，请检查插件加载') });
    return result;
  };
  const documentsFor = service => { if (!documentPreviews.has(service)) documentPreviews.set(service, new DocumentPreview(service)); return documentPreviews.get(service); };
  const previewFor = service => {
    if (!previews.has(service)) previews.set(service, createArtifactPreview(service));
    return previews.get(service);
  };
  ctx.effect(() => () => { for (const preview of previews.values()) preview.close(); previews.clear(); });
  async function verifyTaskSkills(service, taskId) {
    const refs = service.tasks.get(taskId).input.skillRefs || [];
    if (!refs.length) return;
    const current = await (await catalogReady).resolve(service.workspaceRoot, refs.map(ref => ref.name));
    const identity = async values => JSON.stringify(await Promise.all(values.map(async ref => [ref.name, ref.path ? await realpath(ref.path).catch(() => ref.path) : null, ref.hash])));
    if (await identity(current) !== await identity(refs)) throw new Error('Skill 已变化，旧任务输入已保留；请核对后新建任务。');
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/wtt-creation-workbench',
    methods: ['GET', 'HEAD', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
      try {
        const url = new URL(request.url);
        if ((request.method === 'GET' || request.method === 'HEAD') && url.searchParams.has('wordEditorAsset')) {
          const asset=url.searchParams.get('wordEditorAsset');
          if(!['html','js','css','license'].includes(asset))throw new Error('文档编辑器资源不存在');
          return Response.json({error:'文档已改为预览和本机应用编辑，请刷新工作台。'},{status:410,headers});
        }
        if (request.method === 'GET' && url.searchParams.has('directory')) return Response.json(listProjectDirectory(url.searchParams.get('directory')), { headers });
        if (request.method === 'GET' && url.searchParams.has('projects')) return Response.json(projects.list(), { headers });
        if (url.searchParams.getAll('projectId').length > 1) throw new Error('请求只能指定一个项目');
        const projectId = url.searchParams.has('projectId') ? url.searchParams.get('projectId') : undefined;
        if (request.method === 'GET' || request.method === 'HEAD') {
          const service = projects.get(projectId);
          await syncServiceSkills(service);
          if (url.searchParams.has('outcomes')) {
            if (!projectId) throw new Error('成果预览必须指定项目。');
            return Response.json(service.outcomes.manifest({ requirementId: url.searchParams.get('requirementId'), cardId: url.searchParams.get('outcomes'),
              versionId: url.searchParams.get('cardVersion') || undefined, sourceRef: url.searchParams.get('sourceRef') || undefined }), { headers });
          }
          if (url.searchParams.has('nativePreview')) {
            if (!projectId) throw new Error('文件预览必须指定项目。');
            return Response.json(service.outcomes.preview({ requirementId: url.searchParams.get('requirementId'),
              sourceRef: url.searchParams.get('nativePreview'), hash: url.searchParams.get('hash') || undefined,
              ...(url.searchParams.has('projectPath') ? { projectPath: url.searchParams.get('projectPath') } : {}) }), { headers });
          }
          if(url.searchParams.has('projectFilePages')){if(!projectId)throw new Error('文件预览必须指定项目');return Response.json(await service.projectFiles.documentPreview.get(url.searchParams.get('projectFilePages'),url.searchParams.get('hash')),{headers})}
          if(url.searchParams.has('projectFilePage')){if(!projectId)throw new Error('文件预览必须指定项目');const file=await service.projectFiles.documentPreview.page(url.searchParams.get('projectFilePage'),url.searchParams.get('hash'),Number(url.searchParams.get('page')));return new Response(request.method==='HEAD'?null:file.bytes,{headers:{...headers,'Content-Type':file.mime}})}
          if(url.searchParams.has('recycleEntries')){if(!projectId)throw new Error('回收站必须指定项目');return Response.json({entries:service.recycle.list()},{headers})}
          if(url.searchParams.has('projectFiles')){if(!projectId)throw new Error('文件树必须指定项目');return Response.json(service.projectFiles.list(url.searchParams.get('projectFiles')),{headers})}
          if(url.searchParams.has('projectReferenceSearch')){if(!projectId)throw new Error('搜索文件必须指定项目');return Response.json(service.projectFiles.searchReferences(url.searchParams.get('projectReferenceSearch')),{headers})}
          if(url.searchParams.has('reviewImage')){
            if(!projectId)throw new Error('候选图片预览必须指定项目');
            const file=await readReviewImage(service,url.searchParams.get('reviewImage'),url.searchParams.get('hash'));
            return importedFileResponse(file,{method:request.method,preview:true,headers});
          }
          if(url.searchParams.has('projectFilePreview')){if(!projectId)throw new Error('文件预览必须指定项目');return Response.json(await service.projectFiles.preview(url.searchParams.get('projectFilePreview')),{headers})}
          if(url.searchParams.has('projectFileText')){if(!projectId)throw new Error('文件预览必须指定项目');return Response.json(service.projectFiles.text({relative:url.searchParams.get('projectFileText'),page:Number(url.searchParams.get('page')||1)}),{headers})}
          if(url.searchParams.has('projectFileStat')){if(!projectId)throw new Error('文件预览必须指定项目');return Response.json(service.projectFiles.stat(url.searchParams.get('projectFileStat')),{headers})}
          if(url.searchParams.has('projectFileDownload')){
            if(!projectId)throw new Error('文件下载必须指定项目');
            const file=service.projectFiles.read(url.searchParams.get('projectFileDownload'),url.searchParams.get('hash'));
            const inline=url.searchParams.get('preview')==='1',info=inline?await service.projectFiles.preview(file.path):null;
            if(inline&&!(info?.mime?.startsWith('image/')&&info.media?.validated||info?.mime?.startsWith('video/')&&info.media?.validated||info?.mime==='application/pdf'))throw new Error('此格式请下载查看');
            if(inline&&info?.mime==='application/pdf')return new Response(request.method==='HEAD'?null:file.bytes,{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Content-Security-Policy':"default-src 'none'; sandbox"}});
            return importedFileResponse({...file,mime:info?.mime||'application/octet-stream'},{method:request.method,range:request.headers.get('range'),preview:inline,headers});
          }

          if(url.searchParams.has('documentDownload')){
            if(!projectId)throw new Error('文档下载必须指定当前项目');
            const id=url.searchParams.get('documentDownload'),file=await service.documents.snapshot(id,Number(url.searchParams.get('revision')));
            const format=file.path.split('.').pop(),mime={docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pdf:'application/pdf',csv:'text/csv; charset=utf-8'}[format];
            if(!mime)throw new Error('文档格式不支持下载');
            const name=file.title.toLowerCase().endsWith(`.${format}`)?file.title:`${file.title}.${format}`;
            return importedFileResponse({...file,name,mime},{method:request.method,headers});
          }
          if (url.searchParams.has('documentDraftFile')) {
            if (!projectId) throw new Error('文档草稿必须指定当前项目');
            const file = await service.documents.snapshot(url.searchParams.get('documentDraftFile'), Number(url.searchParams.get('revision')));
            if(!file.path.endsWith('.docx'))throw new Error('此入口只读取Word草稿');
            return importedFileResponse({ ...file, name: file.path, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, { method: request.method, headers });
          }
          if (url.searchParams.has('environmentCheck')) return Response.json(await environmentFor(service), { headers });
          if (url.searchParams.has('documentDraftPage')) {
            if (!projectId) throw new Error('文档草稿预览必须指定当前项目');
            const file = await service.documents.previewPage({ draftId: url.searchParams.get('documentDraftPage'), revision: Number(url.searchParams.get('revision')), page: Number(url.searchParams.get('page')) });
            return importedFileResponse(file, { method: request.method, range: request.headers.get('range'), preview: true, headers });
          }
          if (url.searchParams.has('documentPreview') || url.searchParams.has('documentPreviewPage')) {
            if (!projectId) throw new Error('文档预览必须指定当前项目');
            const ref = url.searchParams.get('documentPreview') || url.searchParams.get('documentPreviewPage');
            const hash = url.searchParams.get('hash');
            if (url.searchParams.has('documentPreview')) return Response.json(await documentsFor(service).get(ref, hash), { headers });
            const file = await documentsFor(service).page(ref, hash, Number(url.searchParams.get('page')));
            return importedFileResponse(file, { method: request.method, range: request.headers.get('range'), preview: true, headers });
          }
          if (['assets', 'assetCourse', 'deliveryManifest'].some(key => url.searchParams.has(key)) && !projectId) throw new Error('资产看板必须指定当前项目');
          if (url.searchParams.has('assets')) return Response.json(service.assets.overview(), { headers });
          if (url.searchParams.has('assetCourse')) return Response.json(service.assets.course(url.searchParams.get('assetCourse')), { headers });
          if (url.searchParams.has('deliveryManifest')) return Response.json(service.assets.deliveryManifest(url.searchParams.get('deliveryManifest')), { headers });
          if (url.searchParams.has('productionPolicy')) return Response.json(service.production.policy(), { headers });
          if (url.searchParams.has('productionTask')) {
            const result = await service.production.refresh(url.searchParams.get('productionTask'));
            const task = service.tasks.get(result.taskId), agent = task.sessionId && ctx.get?.('agents')?.get(task.sessionId);
            if (agent && agent.session.header.cwd === service.workspaceRoot) {
              const registry = ctx.get('agentPresets')?.serviceFor(agent, 'skills') || ctx.get('skills');
              result.skillCheck = await Promise.all((task.input.skillRefs || []).map(async ref => {
                const actual = await registry.get(ref.name, { cwd: service.workspaceRoot, scope: agent });
                return { name: ref.name, expectedPath: ref.path, actualPath: actual?.path || null, matches: actual?.path && ref.path ? await realpath(actual.path).catch(() => actual.path) === await realpath(ref.path).catch(() => ref.path) : actual?.path === ref.path };
              }));
            }
            return Response.json(result, { headers });
          }
          if (url.searchParams.has('skills')) {
            const catalog = await (await catalogReady).list(service.workspaceRoot);
            return Response.json(catalog, { headers });
          }
          if (url.searchParams.has('mediaApiCapabilities')) return Response.json(await service.media.apiCapabilities(), { headers });
          if (url.searchParams.has('mediaCapabilities')) return Response.json(await service.media.capabilities(), { headers });
          if (url.searchParams.has('mediaJob')) return Response.json(service.media.get(url.searchParams.get('mediaJob')), { headers });
          if (url.searchParams.has('tasks')) return Response.json(service.tasks.list(url.searchParams.get('tasks')), { headers });
          if (url.searchParams.has('taskReview')) {
            if (!projectId) throw new Error('待审产物必须指定当前项目');
            return Response.json(service.reviewTaskOutputs({ taskId: url.searchParams.get('taskReview'), requirementId: url.searchParams.get('requirementId') }), { headers });
          }
          if (url.searchParams.has('task')) {
            const task = service.tasks.get(url.searchParams.get('task'));
            const result = task.kind === 'media' ? { ...task, mediaJob: service.media.get(task.id).job } : task;
            return Response.json(result, { headers });
          }
          if (url.searchParams.has('canvas')) return Response.json(service.canvas.getBoard(url.searchParams.get('canvas')), { headers });
          if (url.searchParams.has('outputDraft')) {
            if(!projectId)throw new Error('草稿操作必须指定当前项目');
            return Response.json(service.cards.describeDraft({requirementId:url.searchParams.get('requirementId'),cardId:url.searchParams.get('outputDraft')}),{headers});
          }
          if (url.searchParams.has('outputPending')) return Response.json(service.cards.describePending({
            requirementId: url.searchParams.get('requirementId'), cardId: url.searchParams.get('outputPending'),
          }), { headers });
          if (url.searchParams.has('outputCard')) return Response.json(await service.cards.describe({
            requirementId: url.searchParams.get('requirementId'), cardId: url.searchParams.get('outputCard'),
            ...(url.searchParams.has('cardVersion') ? { versionId: url.searchParams.get('cardVersion') } : {}),
          }), { headers });
          if (url.searchParams.has('pptProposal')) {
            if (!projectId) throw new Error('PPT 编辑请求必须指定当前项目');
            return Response.json(await service.deck.proposal({ taskId: url.searchParams.get('pptProposal') }), { headers });
          }
          if (url.searchParams.has('svgEditorPage')) {
            if(!projectId)throw new Error('SVG源文件预览必须指定项目');
            for(const key of ['svgEditorPage','sourceId','page'])if(url.searchParams.getAll(key).length!==1)throw new Error('SVG预览参数必须唯一且完整');
            const file=await service.svgEditor.readPage({draftId:url.searchParams.get('svgEditorPage'),sourceId:url.searchParams.get('sourceId'),page:Number(url.searchParams.get('page'))});
            return new Response(request.method==='HEAD'?null:file.bytes,{headers:{...headers,'Content-Type':'image/svg+xml; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"}});
          }
          if (url.searchParams.has('pptPreviewPage')) {
            if (!projectId) throw new Error('PPT 编辑请求必须指定当前项目');
            for (const key of ['pptPreviewPage', 'revision', 'page']) if (url.searchParams.getAll(key).length !== 1) throw new Error(`PPT 预览参数 ${key} 必须指定一次`);
            const file = await service.deck.readPreviewPage({ draftId: url.searchParams.get('pptPreviewPage'),
              revision: Number(url.searchParams.get('revision')), page: Number(url.searchParams.get('page')) });
            // SVG is served only by the strict source adapter, never by the general file-preview path.
            if (file.mime === 'image/svg+xml') return new Response(request.method === 'HEAD' ? null : file.bytes, {headers:{...headers,
              'Content-Type':'image/svg+xml; charset=utf-8','Content-Length':String(file.bytes.length),'X-Content-Type-Options':'nosniff',
              'Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",'Cache-Control':'no-store'}});
            return importedFileResponse(file, { method: request.method, range: request.headers.get('range'), preview: true, headers });
          }
          if (url.searchParams.has('artifactPreview')) return Response.json(await previewFor(service).get(url.searchParams.get('artifactPreview'), {
            ...(url.searchParams.has('hash') ? { hash: url.searchParams.get('hash') } : {}),
          }), { headers });
          if (url.searchParams.has('artifactPreviewPage')) {
            const file = await previewFor(service).readPage(url.searchParams.get('artifactPreviewPage'), Number(url.searchParams.get('page')), { hash: url.searchParams.get('hash') });
            return importedFileResponse(file, { method: request.method, range: request.headers.get('range'), preview: true, headers });
          }
          if (url.searchParams.has('artifact')) return Response.json(service.tasks.files.get(url.searchParams.get('artifact')), { headers });
          if (url.searchParams.has('materialFile')) {
            const preview = url.searchParams.get('preview') === '1';
            const file = service.canvas.readImportedFile(url.searchParams.get('materialFile'), { preview });
            return importedFileResponse(file, { method: request.method, range: request.headers.get('range'), preview, headers });
          }
          if (url.searchParams.has('downloadArtifact')) {
            const file = await service.tasks.files.download(url.searchParams.get('downloadArtifact'));
            return importedFileResponse(file, { method: request.method, range: request.headers.get('range'), preview: url.searchParams.get('preview') === '1', headers });
          }
          if (url.searchParams.has('download')) {
            const file = await service.download(url.searchParams.get('download'));
            return new Response(file.bytes.slice(), { headers: {
              ...headers,
              'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
            } });
          }
          if (url.searchParams.has('version')) {
            const version = service.store.getVersion(url.searchParams.get('version'));
            if (!version) throw new Error('大纲版本不存在');
            return Response.json(version, { headers });
          }
          if (url.searchParams.has('canvasWorkspace') && !projectId) throw new Error('打开画布必须指定当前项目');
          return Response.json(projects.snapshot(service, await service.snapshot({ openCanvas: url.searchParams.get('canvasWorkspace') === '1' })), { headers });
        }
        if (url.searchParams.has('saveWordDraft')) {
          if (!projectId || ['saveWordDraft','revision'].some(key=>url.searchParams.getAll(key).length!==1)) throw new Error('Word草稿必须指定当前项目和唯一修订号');
          if (Number(request.headers.get('content-length')) > IMPORT_MAX_BYTES) throw Object.assign(new Error('Word草稿不能超过20MiB'),{status:413});
          const bytes=new Uint8Array(await request.arrayBuffer());
          if(bytes.byteLength>IMPORT_MAX_BYTES)throw Object.assign(new Error('Word草稿不能超过20MiB'),{status:413});
          const result=await projects.get(projectId).documents.saveWordDraft({draftId:url.searchParams.get('saveWordDraft'),revision:Number(url.searchParams.get('revision')),bytes});
          return Response.json(result,{headers});
        }
        if(url.searchParams.has('svgEditorImage')){
          if(!projectId)throw new Error('SVG图片引用必须指定项目');
          for(const key of ['svgEditorImage','operationId','filename'])if(url.searchParams.getAll(key).length!==1)throw new Error('SVG图片引用参数不完整或重复');
          if(Number(request.headers.get('content-length'))>IMPORT_MAX_BYTES)throw Object.assign(new Error('引用图片不能超过20MiB'),{status:413});
          const bytes=new Uint8Array(await request.arrayBuffer());if(bytes.length>IMPORT_MAX_BYTES)throw Object.assign(new Error('引用图片不能超过20MiB'),{status:413});
          return Response.json(await projects.get(projectId).svgEditor.addImage({draftId:url.searchParams.get('svgEditorImage'),operationId:url.searchParams.get('operationId'),filename:url.searchParams.get('filename'),bytes}),{headers});
        }
        if (url.searchParams.has('importMaterial')) {
          for (const key of ['importMaterial', 'operationId', 'filename', 'x', 'y', 'associate']) {
            if (url.searchParams.getAll(key).length > 1) throw new Error(`导入参数 ${key} 只能指定一次`);
          }
          if (!projectId) throw new Error('电脑文件导入必须指定当前项目');
          const service = projects.get(projectId);
          if (Number(request.headers.get('content-length')) > IMPORT_MAX_BYTES) throw Object.assign(new Error('单个导入文件不能超过 20 MB'), { status: 413 });
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.byteLength > IMPORT_MAX_BYTES) throw Object.assign(new Error('单个导入文件不能超过 20 MB'), { status: 413 });
          const hasPosition = url.searchParams.has('x') || url.searchParams.has('y');
          if (hasPosition && (!url.searchParams.has('x') || !url.searchParams.has('y'))) throw new Error('导入位置必须同时提供 x 和 y');
          const result = await service.importMaterial({ requirementId: url.searchParams.get('importMaterial'),
            operationId: url.searchParams.get('operationId'), filename: url.searchParams.get('filename'), bytes,
            ...(url.searchParams.has('associate') ? { association: JSON.parse(url.searchParams.get('associate')) } : {}),
            ...(hasPosition ? { position: { x: Number(url.searchParams.get('x')), y: Number(url.searchParams.get('y')) } } : {}),
          }, { signal: request.signal });
          return Response.json(result, { headers });
        }
        const body = await request.text();
        if (Buffer.byteLength(body) > 1_500_000) throw new Error('请求内容过大');
        const { action, data } = JSON.parse(body);
        if(['document-external-open','document-external-status','document-open-application','document-reveal-file','document-external-save-version'].includes(action)&&!projectId)throw new Error('本机文档操作必须指定当前项目');
        if (action === 'open-project') return Response.json({ project: projects.open(data?.path) }, { headers });
        const service = projects.get(projectId);
        if (['inspect-task-control', 'stop-task-control'].includes(action)) {
          if (!projectId) throw new Error('任务控制必须指定当前项目');
          return Response.json(await taskControl[action === 'inspect-task-control' ? 'inspect' : 'stop'](service, data || {}), { headers });
        }
        await syncServiceSkills(service, ['create-task', 'prepare-course', 'course-outline-skill', 'prepare-canvas', 'export-word'].includes(action) || /^(ppt|slides|svg)-/.test(action));
        if (typeof action === 'string' && /^(ppt|slides|svg)-/.test(action) && !projectId) throw new Error('PPT 编辑请求必须指定当前项目');
        if (typeof action === 'string' && /^document-/.test(action) && !projectId) throw new Error('文档编辑请求必须指定当前项目');
        let result;
        if (action === 'select-capability-source') { if (!projectId) throw new Error('能力来源必须指定项目'); return Response.json(service.selectCapabilitySource(data), { headers }); }
        if (['save-business', 'record-receipt', 'reverse-receipt', 'review-output', 'select-delivery', 'save-production-policy', 'save-task-budget', 'save-checkpoint'].includes(action) && !projectId) throw new Error('资产与生产操作必须指定当前项目');
        if (action === 'save-business') return Response.json(service.assets.saveBusiness(data), { headers });
        if (action === 'record-receipt') return Response.json(service.assets.recordReceipt(data), { headers });
        if (action === 'reverse-receipt') return Response.json(service.assets.reverseReceipt(data), { headers });
        if (action === 'review-output') return Response.json(service.assets.review(data), { headers });
        if (action === 'select-delivery') return Response.json(service.assets.selectDelivery(data), { headers });
        if (action === 'save-production-policy') return Response.json(service.production.savePolicy(data), { headers });
        if (action === 'save-task-budget') return Response.json(service.production.setTaskBudget(data), { headers });
        if (action === 'save-checkpoint') return Response.json(service.production.checkpoint(data), { headers });
        if (['sync-deliverables', 'open-deliverable'].includes(action) && !projectId) throw new Error('产物整理与定位必须指定项目');
        if ((action?.startsWith('project-file-')||action?.startsWith('canvas-recycle-')) && !projectId) throw new Error('文件操作必须指定项目');
        if(action==='canvas-recycle-plan')result=service.recycle.plan(data||{});
        else if(action==='canvas-recycle-remove')result=service.recycle.remove(data||{});
        else if(action==='canvas-recycle-restore')result=service.recycle.restore(data||{});
        else if(action==='canvas-recycle-purge-plan')result=service.recycle.purgePlan(data||{});
        else if(action==='canvas-recycle-purge')result=service.recycle.purge(data||{});
        else if(action==='project-file-delete-plan')result=service.recycle.fileEntries.plan(data||{});
        else if(action==='project-file-delete')result=service.recycle.fileEntries.remove(data||{});
        else if (action === 'project-file-create') result = service.projectFiles.create(data || {});
        else if (action === 'project-file-reference') result = await service.projectFiles.reference(data || {});
        else if (action === 'project-file-reveal') result = await service.projectFiles.reveal(data || {});
        else if (action === 'project-file-open') result = await service.projectFiles.openExternal(data || {});
        else if (action === 'card-open-applications') result = await service.openCardApplications(data || {});
        else if (action === 'card-open-application') result = await service.openCardApplication(data || {});
        else if (action === 'material-version') result = service.canvas.materialVersion(data || {});
        else if (action === 'material-restore-project-file') result = service.canvas.restoreMaterialProjectFile(data || {});
        else if (action === 'sync-deliverables') result = service.deliverables.sync(data?.requirementId);
        else if (action === 'open-deliverable') result = await service.deliverables.open(data || {});
        else if (action === 'save-skill-settings') { result = await (await catalogReady).save(data, service.workspaceRoot); syncedServices = new WeakSet(); await syncServiceSkills(service); }
        else if (action === 'update-skill-preference') result = await (await catalogReady).updatePreference(data, service.workspaceRoot);
        else if (action === 'save-media-settings') result = await service.media.updateSettings(data);
        else if (action === 'generate-media-api') {
          if (data?.generationMethod !== 'api') throw new Error('API 生成方式无效');
          result = await service.media.create(data);
        }
        else if (action === 'generate-media') result = await service.media.create(data);
        else if (action === 'resume-media') result = service.media.resume(data.taskId);
        else if (['create-output-draft','save-output-draft'].includes(action)) {
          if(!projectId)throw new Error('草稿操作必须指定当前项目');
          result=action==='create-output-draft'?service.createOutputDraft(data):service.saveOutputDraft(data);
        }
        else if (['create-canvas','rename-canvas','save-canvas-background'].includes(action)) {
          if (!projectId) throw new Error('画布操作必须指定当前项目');
          result = action === 'create-canvas' ? service.store.createCanvas(data) : action === 'rename-canvas' ? service.store.renameCanvas(data) : service.store.saveCanvasBackground(data);
          if (action === 'save-canvas-background' && result.background.trim()) service.recycle.restoreNode(result.id, `requirement:${result.id}`);
        }
        else if (action === 'create') result = service.store.createRequirement(data);
        else if (action === 'rename-requirement') result = service.store.renameRequirement(data);
        else if (action === 'save-outline') result = service.store.saveOutline(data);
        else if (action === 'export-word') result = await service.exportWord(data, { signal: request.signal });
        else if (action === 'prepare-course') result = projects.prepared(service, service.prepareCourse(data));
        else if (action === 'course-outline-skill') result = service.courseOutlineSkill();
        else if (action === 'prepare-canvas') result = projects.prepared(service, service.prepareCanvas(data));
        else if (action === 'document-open') result = await service.documents.open(data);
        else if(action==='document-external-open')result=await service.externalDocuments.open(data);
        else if(action==='document-external-status')result=await service.externalDocuments.status(data);
        else if(action==='document-open-application')result=await service.externalDocuments.openApplication(data);
        else if(action==='document-reveal-file')result=await service.externalDocuments.reveal(data);
        else if(action==='document-external-save-version')result=await service.externalDocuments.saveVersion(data);
        else if (action === 'document-save-draft') result = await service.documents.saveDraft(data);
        else if (action === 'document-save-word-draft') result = await service.documents.saveWordDraft(data);
        else if (action === 'document-preview') result = await service.documents.previewDraft(data);
        else if (action === 'document-save-version') result = await service.documents.saveVersion(data);
        else if (action === 'document-create-rewrite') {
          const created = await service.documents.createRewrite(data);
          result = { ...created, prepared: projects.prepared(service, created.prepared) };
        }
        else if (action === 'save-card-text') result = service.canvas.saveCardText(data);
        else if (action === 'save-canvas') result = service.canvas.saveBoard(data);
        else if (action === 'save-canvas-viewport') result = service.canvas.saveViewport(data);
        else if (action === 'add-material') result = service.canvas.addMaterial(data);
        else if (action === 'snapshot-whiteboard') result = service.canvas.snapshotWhiteboard(data);
        else if (action === 'add-excerpt') result = service.canvas.addExcerpt(data);
        else if (action === 'slides-cover') result = service.slides.cover(data);
        else if (action === 'slides-status') result = service.slides.status(data);
        else if (action === 'slides-retry-comments') result = await service.slides.retryComments(data);
        else if (action === 'slides-open') result = await service.slides.open(data, editorParentOrigin(request));
        else if (action === 'slides-prepare-publish') result = service.slides.preparePublish(data);
        else if (action === 'slides-publish') result = await service.slides.publish(data, { signal: request.signal });
        else if (action === 'ppt-svg-discover') result = await service.svgDecks.discover(data);
        else if (action === 'ppt-open-svg') result = await service.svgDecks.open(data);
        else if (action === 'svg-editor-open') result = await service.svgEditor.open(data);
        else if (action === 'svg-editor-conversation') result = service.svgEditor.bindConversation(data);
        else if (action === 'svg-editor-state') result = service.svgEditor.status(data);
        else if (action === 'svg-editor-view') result = service.svgEditor.view(data);
        else if (action === 'svg-editor-text') result = await service.svgEditor.editText(data);
        else if (action === 'svg-editor-task') result = await service.svgEditor.createTask(data);
        else if (action === 'svg-editor-apply') result = service.svgEditor.apply(data);
        else if (action === 'svg-editor-end-turn') result = service.svgEditor.endTurn(data);
        else if (action === 'svg-editor-undo') result = await service.svgEditor.undo(data);
        else if (action === 'svg-editor-discard') result = service.svgEditor.discard(data);
        else if (action === 'svg-editor-legacy') result = await service.svgEditor.applyLegacy(data);
        else if (action === 'svg-editor-save') result = await service.svgEditor.save(data);
        else if (action === 'ppt-open') result = await service.deck.open(data);
        else if (action === 'ppt-save-draft') result = await service.deck.saveDraft(data);
        else if (action === 'ppt-preview') result = await service.deck.preview(data);
        else if (action === 'ppt-save-version') result = await service.deck.saveVersion(data);
        else if (action === 'ppt-create-ai') {
          const created = await service.deck.createAiTask(data);
          result = { ...created, prepared: projects.prepared(service, created.prepared) };
        }
        else if (action === 'ppt-confirm') result = await service.deck.confirm(data);
        else if (action === 'ppt-discard') result = await service.deck.discard(data);
        else if (action === 'create-task') {
          const names = extractSkillNames(data?.instruction || '');
          if (data?.selectedSkills !== undefined && JSON.stringify(data.selectedSkills) !== JSON.stringify(names)) throw new Error('Skill 选择与创作指令不一致，请重新选择');
          const skillRefs = names.length ? await (await catalogReady).resolve(service.workspaceRoot, names) : [];
          const created = service.createTask({ ...data, selectedSkills: names }, { skillRefs });
          result = { ...created, prepared: projects.prepared(service, created.prepared) };
        }
        else if (action === 'prepare-task') {
          if (!projectId) throw new Error('任务重试必须指定当前项目');
          await verifyTaskSkills(service, data.taskId);
          const prepared = service.prepareTask(data);
          result = { ...prepared, prepared: projects.prepared(service, prepared.prepared) };
        }
        else if (action === 'bind-task-session') { await verifyTaskSkills(service, data.taskId); result = service.tasks.bindSession(data); }
        else if (action === 'set-task-dispatch') { if (data.status === 'submitting') await verifyTaskSkills(service, data.taskId); result = service.tasks.setDispatch(data); }
        else if (action === 'bind-canvas-session') result = service.canvas.setSession(data);
        else throw new Error('不支持的工作台操作');
        return Response.json(result, { headers });
      } catch (error) {
        return Response.json({ error: error.message || '操作失败，请保留输入后重试' }, { status: error.status === 413 ? 413 : 400, headers });
      }
    },
  }));

  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  };
  const projectParameter = { type: 'string', description: '准备输入返回的 projectId；必须属于当前会话的原始项目目录' };
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_read_task_source',
    description: '按需读取当前任务已选中的冻结正文、注释或来源任务的配套文件路径与 hash。仅供该任务的主会话使用。',
    parameters: {
      projectId: projectParameter,
      taskId: { type: 'string', required: true },
      cardId: { type: 'string', required: true, description: '首条消息给出的引用 ID；修订基准用 revision' },
      field: { type: 'string', enum: ['content', 'annotation', 'files'], description: '默认正文，files 返回已选成果的配套文件清单' },
      offset: { type: 'number', description: '默认从开头读取；下一段使用返回的 nextOffset' },
    },
    output: textOutput,
    isConcurrencySafe: true,
    execute: async (args, execution) => {
      execution.signal.throwIfAborted();
      const service = projects.forExecution(args.projectId, execution);
      return JSON.stringify(service.readTaskSource(args, execution.agent?.id));
    },
  })));
  ctx.effect(()=>ctx.tools.register(defineTool({name:'course_get_svg_edit_context',description:'读取当前原生课件编辑会话唯一待执行修改的冻结资料：指定页SVG、选中对象、图片引用和候选提交约定。只读，不生成文件、不代替用户确认。',parameters:{projectId:projectParameter},output:textOutput,isConcurrencySafe:true,execute:async(args,execution)=>{execution.signal.throwIfAborted();const service=projects.forExecution(args.projectId,execution);if(!execution.agent?.id)throw new Error('必须由课件绑定的原生会话读取');return JSON.stringify(service.svgEditor.contextForSession(execution.agent.id));}})));
  ctx.effect(() => ctx.tools.register(defineTool({
    name:'course_propose_svg_edit',description:'为绑定的SVG源文件迭代任务提交整页重绘、所选对象修改、引用图片、增删页或重排候选。只生成待预览方案，用户应用后更新源稿草稿，不直接导出或发布PPT。',
    parameters:{projectId:projectParameter,taskId:{type:'string',required:true},summary:{type:'string',required:true,description:'简短中文变更说明'},operations:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{
      type:{type:'string',required:true,description:'replace-page / replace-element / update-notes / insert-page / delete-page / reorder-pages'},pageId:{type:'string'},svg:{type:'string',description:'完整安全SVG页面，仅用于替换或新增'},notes:{type:'string'},elementId:{type:'string'},svgFragment:{type:'string'},afterId:{type:'string',description:'新增页插在该页之后，省略表示开头'},pageIds:{type:'array',items:{type:'string'}}
    }}}},output:textOutput,isConcurrencySafe:false,
    execute:async(args,execution)=>{execution.signal.throwIfAborted();const service=projects.forExecution(args.projectId,execution);await syncServiceSkills(service);if(!execution.agent?.id)throw new Error('SVG候选必须来自任务绑定会话');
      const result=await service.svgEditor.propose({taskId:args.taskId,sessionId:execution.agent.id,summary:args.summary,operations:args.operations});
      const turn=result.turns.find(t=>t.taskId===args.taskId);return JSON.stringify({status:turn?.status,proposal:turn?.proposal,draftId:result.id,revision:result.revision,formalVersionSaved:false});},
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_propose_ppt_edit',
    description: '为已绑定的 PPT 局部修改任务提交指定页面文字与讲师备注的候选。仅生成待确认结果，不发布版本，不改原件；用户确认后才保存新版。',
    parameters: {
      projectId: projectParameter,
      taskId: { type: 'string', required: true },
      pages: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        slideId: { type: 'string', required: true, description: '任务快照中的实际页面 ID，保持原样' },
        changes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          elementId: { type: 'string', required: true, description: '任务允许修改的原生文字元素 ID' },
          text: { type: 'string', required: true, description: '该元素修改后的完整文字' },
        } } },
        notes: { type: 'string', description: '整页修改允许时可提交该页完整讲师备注；不修改则省略' },
      } } },
    },
    output: textOutput,
    isConcurrencySafe: false,
    execute: async (args, execution) => {
      execution.signal.throwIfAborted();
      const service = projects.forExecution(args.projectId, execution);
      await syncServiceSkills(service);
      if (!execution.agent?.id) throw new Error('PPT 修改候选必须由任务绑定的原生会话提交');
      return JSON.stringify(await service.deck.propose({ taskId: args.taskId, sessionId: execution.agent.id, pages: args.pages }));
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_attach_slide_project',
    description: '登记本任务固定 working/slides 目录内已完成检查的宝玉幻灯片工程草稿。仅绑定当前主会话，不发布正式 PPTX；用户可在课程白板右栏继续编辑、批注并导出保存版本。',
    parameters: { projectId: projectParameter, taskId: { type: 'string', required: true } },
    output: textOutput, isConcurrencySafe: false,
    execute: async (args, execution) => {
      execution.signal.throwIfAborted();
      const service = projects.forExecution(args.projectId, execution);
      await syncServiceSkills(service);
      return JSON.stringify(await service.slides.attach({ taskId: args.taskId, sessionId: execution.agent?.id }));
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_register_artifact',
    description: '登记本次任务目录内已真实生成并通过技术验证的文本、PPTX、图片、视频等成果。独立成果按任务规则自动建卡，原生主会话调用。',
    parameters: {
      projectId: projectParameter,
      taskId: { type: 'string', required: true },
      kind: { type: 'string', required: true, description: '按实际类型选择 text、pptx、storyboard、exercise、script、image、video 或 support。正式课件用 pptx 并保留原生编辑性验证；图片式预览用 support。' },
      title: { type: 'string', required: true },
      path: { type: 'string', required: true, description: '本项目 courses/<需求ID>/tasks/<任务ID>/ 内的真实文件路径；正式产物在 delivery/ 下' },
      operationId: { type: 'string', required: true, description: '本次登记的 UUID，失败重试原样复用' },
      primary: { type: 'boolean', description: '首个主文件为 true，复用原容器；其他独立成果省略。附件另用 presentation。' },
      presentation: { type: 'string', enum: ['attachment'], description: '仅需跟随主卡的附件传 attachment；独立成果省略。' },
    },
    output: textOutput,
    isConcurrencySafe: false,
    execute: async (args, execution) => {
      execution.signal.throwIfAborted();
      const service = projects.forExecution(args.projectId, execution);
      await syncServiceSkills(service);
      if (!execution.agent?.id) throw new Error('产物必须由任务绑定的原生会话登记');
      return JSON.stringify(await service.tasks.files.register(args, {
        sessionId: execution.agent.id, pythonExecutable: service.python, pptSkillDir: service.pptSkillDir,
      }));
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_register_artifacts',
    description: '一次登记同一主任务的 1–100 个真实成果文件，独立成果各建卡。成功项保留，失败项用原 operationId 重试。保留宝玉导出和局部 AI 确认。',
    parameters: {
      projectId: projectParameter,
      taskId: { type: 'string', required: true },
      files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        kind: { type: 'string', required: true, description: '按实际类型选择 text、pptx、storyboard、exercise、script、image、video 或 support' },
        title: { type: 'string', required: true },
        path: { type: 'string', required: true, description: '当前项目本任务内真实文件路径，正式交付在 delivery/' },
        operationId: { type: 'string', required: true, description: '该文件独立 UUID，失败重试复用原值' },
        primary: { type: 'boolean', description: '首个主文件为 true；其他独立成果省略，按实际成果数量自动扩卡' },
        presentation: { type: 'string', enum: ['attachment'], description: '仅需跟随主卡的附件用 attachment；独立成果省略。' },
      } } },
    },
    output: textOutput, isConcurrencySafe: false,
    execute: async (args, execution) => {
      execution.signal.throwIfAborted();
      const service = projects.forExecution(args.projectId, execution);
      await syncServiceSkills(service);
      if (!execution.agent?.id) throw new Error('产物必须由任务绑定的原生会话登记');
      return JSON.stringify(await service.tasks.files.registerBatch(args, {
        sessionId: execution.agent.id, signal: execution.signal,
        pythonExecutable: service.python, pptSkillDir: service.pptSkillDir,
      }));
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_list_requirements',
    description: '盘点当前项目的画布与已保存大纲版本。仅在需要盘点项目时调用；创作任务使用已选冻结引用。前端切项目不会改变会话项目。',
    parameters: { projectId: projectParameter },
    output: textOutput,
    execute: async (args, execution) => {
      execution.signal.throwIfAborted();
      const service = projects.forExecution(args.projectId, execution);
      await syncServiceSkills(service);
      return JSON.stringify(projects.snapshot(service, await service.snapshot()));
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_sync_deliverables',
    description: '按课程和白板版本名称整理当前项目已登记文件的独立副本。原文件与业务版本保留；返回每个文件的真实路径及失败原因，不生成内容。',
    parameters: { projectId: projectParameter, requirementId: { type: 'string', description: '可选；只整理指定画布，不指定时整理项目全部画布' } },
    output: textOutput,
    execute: async (args, execution) => {
      execution.signal.throwIfAborted();
      return JSON.stringify(projects.forExecution(args.projectId, execution).deliverables.sync(args.requirementId));
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_save_outline',
    description: '保存完整 Markdown 大纲为新版本。精简创作任务返回版本定位和 hash。相同 operationId 和内容重试不重复建版。保存不代表客户确认、发送或授课。',
    parameters: {
      projectId: projectParameter,
      requirementId: { type: 'string', required: true },
      markdown: { type: 'string', required: true },
      operationId: { type: 'string', required: true, description: '本次保存的 UUID；重试时复用同一个值' },
      sourceCardIds: { type: 'array', items: { type: 'string' }, description: '本次实际使用的来源卡片 id，画布发起时沿用所选卡片标识' },
      taskId: { type: 'string', description: '本次 AI 创作的任务标识；从任务发起时必须原样传入，以关联准确产物' },
      primary: { type: 'boolean', description: '大纲作为本次文本任务主产物可传 true；只作附属资料传 false。不会为同一任务重复创建卡片版本。' },
    },
    output: textOutput,
    isConcurrencySafe: false,
    execute: async (args, execution) => {
      execution.signal.throwIfAborted();
      const service = projects.forExecution(args.projectId, execution);
      await syncServiceSkills(service);
      const compactReceipt = args.taskId && execution.agent?.id &&
        service.tasks.get(args.taskId).input.contextVersion === 1;
      const version = service.store.saveOutline({ ...args, ...(execution.agent ? { executionSessionId: execution.agent.id } : {}) });
      if (!compactReceipt) return JSON.stringify(version);
      const { markdown: _markdown, ...receipt } = version;
      return JSON.stringify(receipt);
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_get_canvas',
    description: '盘点画布的全部素材、版本及来源关系。创作任务读取选中资料时用 course_read_task_source；仅需文件时按实际路径读取。',
    parameters: { projectId: projectParameter, requirementId: { type: 'string', required: true } },
    output: textOutput,
    execute: async ({ projectId, requirementId }, execution) => {
      execution.signal.throwIfAborted();
      const service = projects.forExecution(projectId, execution);
      return JSON.stringify(service.canvas.getBoard(requirementId));
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_get_delivery',
    description: '只读当前课程选定的准确交付版本、文件路径和hash，不读取收款资料，不代表已发送或客户确认。',
    parameters: { projectId: projectParameter, requirementId: { type: 'string', required: true } },
    output: textOutput,
    isConcurrencySafe: true,
    execute: async ({ projectId, requirementId }, execution) => {
      execution.signal.throwIfAborted();
      return JSON.stringify(projects.forExecution(projectId, execution).assets.deliveryManifest(requirementId));
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'course_add_material',
    description: '向指定画布保存一张新的文字素材卡或关联工作目录内的文件，保留原文件。使用新 operationId UUID，失败重试复用原值。',
    parameters: {
      projectId: projectParameter,
      requirementId: { type: 'string', required: true }, title: { type: 'string', required: true },
      content: { type: 'string' }, sourcePath: { type: 'string' }, operationId: { type: 'string', required: true },
      sourceRefs: { type: 'array', description: '打开创作框时冻结的真实来源；不传则为独立素材', items: {
        type: 'object', additionalProperties: false, properties: { cardId: { type: 'string', required: true }, hash: { type: 'string', required: true } },
      } },
    },
    output: textOutput,
    isConcurrencySafe: false,
    execute: async (args, execution) => {
      execution.signal.throwIfAborted();
      const service = projects.forExecution(args.projectId, execution);
      await syncServiceSkills(service);
      return JSON.stringify(service.canvas.addMaterial(args));
    },
  })));
}
