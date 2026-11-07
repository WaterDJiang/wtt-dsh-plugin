import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { WorkbenchService } from '../src/service.mjs';
import { slideTree } from '../src/slide-projects.mjs';
import { localEditorUrl, configureEditorHtml, editorParentOrigin, configuredEditorPolicy, slidesRuntimeAvailable } from '../src/baoyu-runtime.mjs';

const SLIDES_SKIP = slidesRuntimeAvailable() ? false : '需要本机安装 dsh-claude-slides（宝玉幻灯片插件）；按 README 干净检出并安装后运行';

function writeEngineering(root) {
  mkdirSync(path.join(root, 'project/slides'), { recursive: true });
  writeFileSync(path.join(root, 'project/deck.json'), JSON.stringify({ v: 4, createdOnFiles: { v: 1, at: new Date().toISOString() }, title: '宝玉两页技术验收',
    order: ['cover', 'practice'], cover: 'cover', lists: 'css', faces: {}, sections: {}, designSystems: [] }));
  for (const [id, title] of [['cover', '技术验收封面'], ['practice', '练习与讲师备注']]) writeFileSync(path.join(root, `project/slides/${id}.html`),
    `<section id="${id}" style="background:#ffffff;font-family:Arial;color:#222222"><h1 style="position:absolute;left:120px;top:120px;width:1400px;height:200px;font-size:64px">${title}</h1><aside>本页讲师备注</aside></section>`);
}
async function fixture(t) {
  const workspaceRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-slides-'))), service = new WorkbenchService({ workspaceRoot });
  t.after(() => { service.close(); rmSync(workspaceRoot, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '宝玉技术验收，不是模型输出', operationId: randomUUID() });
  const source = service.canvas.getBoard(requirement.id).nodes[0];
  const input = { requirementId: requirement.id, instruction: '人工两页工程，用于验证宝玉集成', selectedCardIds: [source.id],
    outputType: 'pptx', pptEngine: 'baoyu', generation: { mode: 'new' }, operationId: randomUUID() };
  const created = service.createTask(input), sessionId = `technical:${created.task.id}`;
  service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const root = path.join(workspaceRoot, service.slides.rootForTask(created.task)); writeEngineering(root);
  const attached = await service.slides.attach({ taskId: created.task.id, sessionId });
  return { service, workspaceRoot, requirement, source, input, created, sessionId, root, attached };
}
function exportedPpt(root, label = '技术验收') {
  mkdirSync(path.join(root, 'exports'), { recursive: true });
  const target = path.join(root, 'exports', `${label}.pptx`);
  const result = spawnSync('python3', ['-B', '-c', `from pptx import Presentation
from pptx.util import Inches
import sys
p=Presentation()
for title in ['技术验收封面','练习与讲师备注']:
 s=p.slides.add_slide(p.slide_layouts[6]); s.shapes.add_textbox(Inches(1),Inches(1),Inches(8),Inches(1)).text=title
p.save(sys.argv[1])`, target], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return target;
}

test('编辑 URL 和启动配置只接受当前回环来源，不能注入脚本或借任意 URL 代理', () => {
  assert.equal(localEditorUrl('http://127.0.0.1:39000/slides/testgrant/').port, '39000');
  for (const value of ['https://evil.test/slides/grant/', 'http://127.0.0.1:23/admin/', 'http://x@127.0.0.1:23/slides/grant/', 'file:///tmp/']) assert.throws(() => localEditorUrl(value));
  const configured = configureEditorHtml('<head><script id="appifact-flags"></script></head>', 'http://127.0.0.1:3087');
  assert.match(configured, /__FRAME_PREAMBLE/); assert.match(configured, /appifact_extra_export_formats/);
  assert.throws(() => configureEditorHtml('<head></head>', 'http://127.0.0.1:3087'), /协议已变化/);
  assert.throws(() => configureEditorHtml('<head></head>', 'https://evil.test'), /本机/);
  assert.equal(editorParentOrigin(new Request('http://dsh.internal/api/workbench', { headers: { Host: '127.0.0.1:3087', Origin: 'http://127.0.0.1:3087' } })), 'http://127.0.0.1:3087');
  assert.throws(() => editorParentOrigin(new Request('http://dsh.internal/api', { headers: { Host: '127.0.0.1:3087', Origin: 'https://evil.test' } })), /来源不一致/);
});

test('真实编辑代理保留 CSP，只有入口 HTML 获得精确脚本哈希；课件 HTML 原样读取且拒绝外部来源', { skip: SLIDES_SKIP }, async t => {
  const f = await fixture(t), opened = await f.service.slides.open({ projectId: f.attached.project.id, requirementId: f.requirement.id }, 'http://127.0.0.1:3087');
  const entry = await fetch(opened.editor.url), html = await entry.text(), csp = entry.headers.get('content-security-policy');
  assert.equal(entry.status, 200); assert.match(html, /__wtt_slides_command/);
  assert.match(csp, /script-src/); assert.match(csp, /sha256-/); assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  const origin = new URL(opened.editor.url).origin;
  const cookie = entry.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const slide = await fetch(new URL('project/slides/cover.html', opened.editor.url), { headers: { Origin: origin, Cookie: cookie } });
  assert.equal(slide.status, 200); assert.equal(await slide.text(), readFileSync(path.join(f.root, 'project/slides/cover.html'), 'utf8'));
  assert.equal((await fetch(opened.editor.url, { headers: { Origin: 'https://evil.test' } })).status, 403);
  const configured = configuredEditorPolicy("default-src 'self'; script-src 'self' 'sha256-existing'; frame-src 'self'", 'http://127.0.0.1:3087');
  assert.match(configured, /sha256-existing/); assert.match(configured, /frame-src 'self'/);
});

test('新课件冻结宝玉引擎；原任务重放不换引擎，登记工程不制造正式版本', { skip: SLIDES_SKIP }, async t => {
  const f = await fixture(t), { service, created, attached } = f;
  assert.equal(service.tasks.get(created.task.id).input.pptEngine, 'baoyu');
  assert.match(created.prepared.prompt, /course_attach_slide_project/);
  assert.match(created.prepared.prompt, /claude-slides/);
  assert.doesNotMatch(created.prepared.prompt, /正式课件复制／导出到 delivery/);
  assert.throws(() => service.createTask({ ...f.input, pptEngine: 'native' }), /不同内容/);
  const node = service.canvas.getBoard(f.requirement.id).nodes.find(node => node.outputCard);
  assert.equal(node.kind, 'generation'); assert.equal(node.outputCard.versions.length, 0);
  assert.equal(node.slideProject.id, attached.project.id);
  await assert.rejects(service.slides.attach({ taskId: created.task.id, sessionId: 'wrong' }), /原会话/);
  assert.throws(() => service.slides.preparePublish({ projectId: attached.project.id, requirementId: randomUUID(), operationId: randomUUID() }), /不属于/);
  assert.equal(service.createTask({ ...f.input, operationId: randomUUID(), pptEngine: 'native' }).task.input.pptEngine, 'native');
});

test('工程封面按项目与当前修订读取，不启动编辑器、不导出、不创建正式版本', { skip: SLIDES_SKIP }, async t => {
  const f = await fixture(t), data = { projectId: f.attached.project.id, requirementId: f.requirement.id };
  const node = f.service.canvas.getBoard(f.requirement.id).nodes.find(item => item.slideProject);
  f.service.slides.runtime.open = () => { throw new Error('封面读取不应启动编辑器'); };
  const cover = f.service.slides.cover({ ...data, revision: node.slideProject.coverRevision });
  assert.equal(cover.projectId, data.projectId); assert.equal(cover.pageCount, 2);
  assert.match(cover.document, /技术验收封面/); assert.doesNotMatch(cover.document, /本页讲师备注/);
  assert.equal(node.outputCard.versions.length, 0);
  assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM output_card_versions WHERE card_id=?').get(node.outputCard.id).n, 0);
  assert.throws(() => f.service.slides.cover({ ...data, requirementId: randomUUID() }), /不属于/);
});

test('工程拒绝链接；外改和旧导出不发布成功版本', { skip: SLIDES_SKIP }, async t => {
  const f = await fixture(t), data = { projectId: f.attached.project.id, requirementId: f.requirement.id };
  symlinkSync('/etc/hosts', path.join(f.root, 'project/外部链接'));
  assert.throws(() => slideTree(path.join(f.root, 'project')), /符号链接/);
  rmSync(path.join(f.root, 'project/外部链接'));
  exportedPpt(f.root);
  const intent = f.service.slides.preparePublish({ ...data, operationId: randomUUID() });
  await assert.rejects(f.service.slides.publish({ ...data, ...intent }, { timeout: 1 }), /等待宝玉导出超时/);
  exportedPpt(f.root, '无完成回执');
  await assert.rejects(f.service.slides.publish({ ...data, ...intent }, { timeout: 1 }), /等待宝玉导出超时/);
  writeFileSync(path.join(f.root, 'project/slides/cover.html'), '<section id="cover" style="background:#ffffff"><h1>改动</h1></section>');
  await assert.rejects(f.service.slides.publish({ ...data, ...intent }, { timeout: 1 }), /草稿或基础版本已变化/);
  assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM slide_project_versions').get().n, 0);
});

test('批注发送失败后持久保留，恢复原会话后只重送一次；跨工程回传被阻止', { skip: SLIDES_SKIP }, async t => {
  const f = await fixture(t), data = { projectId: f.attached.project.id, requirementId: f.requirement.id };
  f.service.slides.runtime.watch = () => {};
  f.service.slides.deliverComments = async () => { throw new Error('技术测试：会话暂不可用'); };
  const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: '技术批注，请保留此原文' }] };
  await f.service.slides.queueComments(f.sessionId, message, f.root);
  assert.equal(f.service.slides.status(data).pendingComments, 1);
  assert.match(f.service.slides.status(data).commentError, /会话暂不可用/);
  const reopened = new WorkbenchService({ workspaceRoot: f.workspaceRoot });
  let sent = 0;
  try {
    reopened.slides.deliverComments = async (sessionId, actual) => { assert.equal(sessionId, f.sessionId); assert.deepEqual(actual, message); sent++; };
    assert.equal(reopened.slides.status(data).pendingComments, 1);
    await reopened.slides.retryComments(data); await reopened.slides.retryComments(data);
    assert.equal(sent, 1); assert.equal(reopened.slides.status(data).pendingComments, 0);
  } finally { reopened.close(); }
  await assert.rejects(f.service.slides.queueComments('其他会话', { ...message, id: randomUUID() }, f.root), /绑定课程任务/);
});

test('真实格式文件绑定工程快照与同卡递增版本；重放幂等，旧版与草稿隔离', { skip: SLIDES_SKIP }, async t => {
  const f = await fixture(t), { service } = f, data = { projectId: f.attached.project.id, requirementId: f.requirement.id };
  const save = async label => {
    const intent = service.slides.preparePublish({ ...data, operationId: randomUUID() }); const exported = exportedPpt(f.root, label);
    service.slides.recordExport(f.root, { name: path.basename(exported), path: exported, bytes: readFileSync(exported).length });
    const result = await service.slides.publish({ ...data, ...intent });
    assert.equal((await service.slides.publish({ ...data, ...intent })).artifact.id, result.artifact.id);
    return result;
  };
  const v1 = await save('第一份'), original = readFileSync(path.join(f.workspaceRoot, v1.engineeringPath, 'slides/cover.html'), 'utf8');
  assert.equal(v1.descriptor.version.number, 1); assert.equal(v1.artifact.validation.status, 'passed');
  assert.equal(v1.descriptor.editor.recorded, true); assert.equal(v1.descriptor.editor.instruction, f.input.instruction);
  assert.deepEqual(v1.descriptor.editor.references.map(source => source.cardId), [f.source.id]);
  assert.equal(v1.artifact.delivery.status, 'ready'); assert.ok(!v1.deliveryWarning, v1.deliveryWarning);
  assert.equal(readFileSync(path.join(f.workspaceRoot, path.dirname(v1.artifact.delivery.path), '课件工程/project/slides/cover.html'), 'utf8'), original);
  writeFileSync(path.join(f.root, 'project/slides/cover.html'), original.replace('技术验收封面', '技术验收封面第二版'));
  const v2 = await save('第二份');
  assert.equal(v2.descriptor.card.id, v1.descriptor.card.id); assert.equal(v2.descriptor.version.number, 2);
  assert.equal(v2.descriptor.version.baseVersionId, v1.descriptor.version.id);
  for (const saved of [v1, v2]) {
    const manifest=service.outcomes.manifest({requirementId:f.requirement.id,cardId:saved.descriptor.card.id,versionId:saved.descriptor.version.id});
    assert.equal(manifest.slideProject.artifactId,saved.artifact.id);
    assert.equal(manifest.slideProject.artifactHash,saved.artifact.hash);
  }
  assert.equal(readFileSync(path.join(f.workspaceRoot, v1.engineeringPath, 'slides/cover.html'), 'utf8'), original);
  // A historical engineering branch does not overwrite the current working directory.
  const runtimeOpen = service.slides.runtime.open.bind(service.slides.runtime);
  service.slides.runtime.open = async () => ({ url: 'http://127.0.0.1:1/slides/unit-only/' });
  t.after(() => { service.slides.runtime.open = runtimeOpen; });
  const branch = await service.slides.open({ ...data, versionId: v1.descriptor.version.id }, 'http://127.0.0.1:3087');
  assert.notEqual(branch.project.rootPath, f.attached.project.rootPath);
  assert.equal(slideTree(path.join(f.workspaceRoot, branch.project.rootPath, 'project')).hash, service.store.db.prepare('SELECT tree_hash FROM slide_project_versions WHERE artifact_id=?').get(v1.artifact.id).tree_hash);
  const intent = service.slides.preparePublish({ projectId: branch.project.id, requirementId: f.requirement.id, operationId: randomUUID() });
  const branchRoot = path.join(f.workspaceRoot, branch.project.rootPath), exported = exportedPpt(branchRoot, '旧版另存');
  service.slides.recordExport(branchRoot, { name: path.basename(exported), path: exported, bytes: readFileSync(exported).length });
  const v3 = await service.slides.publish({ projectId: branch.project.id, requirementId: f.requirement.id, ...intent });
  assert.equal(v3.descriptor.version.number, 3); assert.equal(v3.descriptor.version.baseVersionId, v1.descriptor.version.id);
  const regenerated = service.createTask({ ...f.input, operationId: randomUUID(), generation: { mode: 'revise', cardId: v1.descriptor.card.id, baseVersionId: v1.descriptor.version.id } });
  assert.equal(regenerated.task.input.revision.engineering.path, v1.engineeringPath);
  assert.equal(regenerated.task.input.revision.engineering.hash, service.slides.sourceForArtifact(v1.artifact.id).hash);
  writeFileSync(path.join(f.workspaceRoot, v1.engineeringPath, 'slides/cover.html'), original.replace('技术验收封面', '外部修改'));
  await assert.rejects(service.slides.open({ ...data, versionId: v1.descriptor.version.id }, 'http://127.0.0.1:3087'), /外部修改/);
  writeFileSync(path.join(f.workspaceRoot, v2.artifact.path), '已外改的 PPTX');
  assert.throws(() => service.slides.preparePublish({ ...data, operationId: randomUUID() }), /外部修改/);
});
