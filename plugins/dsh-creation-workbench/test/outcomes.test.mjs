import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';
import { createPreviewSessionAcquirer } from '../src/session.mjs';
import { slidesRuntimeAvailable } from '../src/baoyu-runtime.mjs';

const SLIDES_SKIP = slidesRuntimeAvailable() ? false : '需要本机安装 dsh-claude-slides（宝玉幻灯片插件）；按 README 干净检出并安装后运行';

function python(code, args) {
  const result = spawnSync('python3', ['-B', '-c', code, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
function ppt(file, title = '真实原生课件') {
  mkdirSync(path.dirname(file), { recursive: true });
  python(`from pptx import Presentation
from pptx.util import Inches
import sys
p=Presentation();s=p.slides.add_slide(p.slide_layouts[6]);s.shapes.add_textbox(Inches(1),Inches(1),Inches(8),Inches(1)).text=sys.argv[2];p.save(sys.argv[1])`, [file, title]);
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cw50-outcomes-')));
  const opened = [];
  const service = new WorkbenchService({ workspaceRoot: root, documentStabilityMs: 0, openDocumentApplication: async file => opened.push(file) });
  const canvas = service.store.createRequirement({ title: '技术验收', operationId: randomUUID() });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, service, canvas, opened };
}
async function oldTask(f) {
  const created = f.service.createTask({ requirementId: f.canvas.id, outputType: 'pptx', pptEngine: 'baoyu', selectedSkills: [],
    instruction: '不调用模型的工程／PPTX适配验收', selectedCardIds: [], generation: { mode: 'new' }, operationId: randomUUID() });
  const sessionId = `technical:${created.task.id}`;
  f.service.tasks.bindSession({ taskId: created.task.id, sessionId });
  const root = path.join(f.root, f.service.slides.rootForTask(created.task), 'project');
  mkdirSync(path.join(root, 'slides'), { recursive: true });
  writeFileSync(path.join(root, 'deck.json'), JSON.stringify({ v: 4, createdOnFiles: { v: 1, at: new Date().toISOString() },
    order: ['cover'], cover: 'cover', lists: 'css', faces: {}, sections: {}, designSystems: [], title: '旧网页工程' }));
  writeFileSync(path.join(root, 'slides/cover.html'), '<section id="cover" style="background:#ffffff;font-family:Arial"><h1 style="position:absolute;left:100px;top:100px;width:1200px;height:200px;font-size:64px">旧网页工程</h1></section>');
  await f.service.slides.attach({ taskId: created.task.id, sessionId });
  const relative = `${created.prepared.deliveryDirectory}/新版课件.pptx`;
  ppt(path.join(f.root, relative));
  const file = await f.service.tasks.files.register({ taskId: created.task.id, kind: 'support', presentation: 'attachment',
    title: 'Builder输出', path: relative, operationId: randomUUID() }, { sessionId });
  return { created, file, sessionId, scope: { requirementId: f.canvas.id, cardId: created.task.outputCardId } };
}

test('旧宝玉任务的PPTX附件按真实格式打开，同卡网页入口保留，读取不改变版本或冻结输入', { skip: SLIDES_SKIP }, async t => {
  const f = fixture(t), { created, file, scope } = await oldTask(f);
  const before = f.service.store.db.prepare('SELECT input_json FROM course_tasks WHERE id=?').get(created.task.id).input_json;
  const manifest = f.service.outcomes.manifest(scope);
  assert.equal(manifest.selectedRef, `artifact:${file.id}`);
  assert.equal(manifest.files[0].format, 'pptx'); assert.equal(manifest.files[0].role, 'attachment');
  assert.ok(manifest.slideProject); assert.equal(manifest.versionId, null);
  const preview = f.service.outcomes.preview({ ...scope, sourceRef: manifest.selectedRef, hash: file.hash });
  assert.match(preview.path, /native-preview/); assert.equal(preview.hash, file.hash);
  assert.deepEqual(readFileSync(path.join(f.root, preview.path)), readFileSync(path.join(f.root, file.path)));
  const node = f.service.canvas.getBoard(f.canvas.id).nodes.find(node => node.outputCard?.id === scope.cardId);
  assert.equal(node.defaultOutcome.format, 'pptx'); assert.ok(node.slideProject);
  assert.equal(f.service.store.db.prepare('SELECT input_json FROM course_tasks WHERE id=?').get(created.task.id).input_json, before);
  assert.equal(f.service.store.db.prepare('SELECT count(*) AS n FROM output_card_versions WHERE card_id=?').get(scope.cardId).n, 0);
  const other = f.service.store.createRequirement({ title: '另一画布', operationId: randomUUID() });
  assert.throws(() => f.service.outcomes.read({ requirementId: other.id, sourceRef: manifest.selectedRef }), /不属于/);
  assert.throws(() => f.service.outcomes.preview({ ...scope, sourceRef: manifest.selectedRef, hash: 'a'.repeat(64) }), /版本已变化/);
  assert.throws(() => f.service.outcomes.documentScope({ ...scope, sourceRef: manifest.selectedRef, hash: file.hash, projectPath: file.path }), /不接收独立文件路径/);
  assert.throws(() => f.service.outcomes.documentScope({ ...scope, sourceRef: manifest.selectedRef }), /准确文件hash/);
  const unrelated = f.service.createTask({ requirementId: f.canvas.id, outputType: 'text', selectedSkills: [], instruction: '另一张卡', selectedCardIds: [], generation: { mode: 'new' }, operationId: randomUUID() });
  assert.throws(() => f.service.outcomes.manifest({ requirementId: f.canvas.id, cardId: unrelated.task.outputCardId, sourceRef: manifest.selectedRef }), /不属于当前卡片/);
  writeFileSync(path.join(f.root, file.path), '外部修改');
  assert.throws(() => f.service.outcomes.preview({ ...scope, sourceRef: manifest.selectedRef, hash: file.hash }), /变化|修改|缺失/);
});

test('PPTX附件在工作副本修改，明确保存后同卡首版／修订版归档，旧任务和原文件保留', { skip: SLIDES_SKIP }, async t => {
  const f = fixture(t), { created, file, scope } = await oldTask(f);
  const original = readFileSync(path.join(f.root, file.path));
  const frozen = f.service.tasks.get(created.task.id).input;
  let state = await f.service.externalDocuments.open({ ...scope, sourceRef: `artifact:${file.id}`, hash: file.hash, outcome: true });
  await f.service.externalDocuments.openApplication({ draftId: state.id });
  assert.equal(f.opened.length, 1); assert.notEqual(f.opened[0], path.join(f.root, file.path));
  ppt(f.opened[0], '修改后的课件');
  state = await f.service.externalDocuments.status({ draftId: state.id });
  assert.equal(state.dirty, true); assert.equal(state.previewSource.hash, state.hash);
  const operationId = randomUUID();
  const saved = await f.service.externalDocuments.saveVersion({ draftId: state.id, revision: state.revision, hash: state.hash, operationId });
  assert.equal(saved.cardId, scope.cardId);
  assert.equal(f.service.cards.describe({ ...scope, versionId: saved.versionId }).version.number, 1);
  assert.deepEqual(readFileSync(path.join(f.root, file.path)), original);
  assert.deepEqual(f.service.tasks.get(created.task.id).input, frozen);
  const replay = await f.service.externalDocuments.saveVersion({ draftId: state.id, revision: state.revision, hash: state.hash, operationId });
  assert.equal(replay.versionId, saved.versionId);
  const desc = f.service.cards.describe({ ...scope, versionId: saved.versionId });
  state = await f.service.externalDocuments.open({ ...scope, versionId: desc.version.id, sourceRef: desc.version.primaryRef, hash: desc.node.sourceHash, outcome: true });
  await f.service.externalDocuments.openApplication({ draftId: state.id }); ppt(f.opened.at(-1), '第三份内容');
  state = await f.service.externalDocuments.status({ draftId: state.id });
  const next = await f.service.externalDocuments.saveVersion({ draftId: state.id, revision: state.revision, hash: state.hash, operationId: randomUUID() });
  assert.equal(f.service.cards.describe({ ...scope, versionId: next.versionId }).version.number, 2);
  assert.equal(f.service.outcomes.manifest({ ...scope, versionId: saved.versionId }).selectedRef, desc.version.primaryRef);
});

test('普通HTML走文件预览、保留依赖目录，文件树边界和链接不可越界', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, '页面.html'), '<!doctype html><h1>本地网页</h1>');
  const source = f.service.outcomes.preview({ projectPath: '页面.html' });
  assert.equal(source.format, 'html'); assert.equal(source.path, '页面.html'); assert.equal(source.slideProject, undefined);
  assert.throws(() => f.service.outcomes.preview({ projectPath: '../elsewhere' }), /当前项目/);
  symlinkSync(path.join(f.root, '页面.html'), path.join(f.root, 'link.html'));
  assert.throws(() => f.service.outcomes.preview({ projectPath: 'link.html' }), /链接/);
});

test('宿主文件预览独立保留会话，不查询模型、不提交、不改变当前聊天；跨项目会话拒绝', async () => {
  const calls = [], bindings = new Map();
  const ctx = { remote: {
    workspace: { create: async request => { calls.push('workspace'); return { ok: true, value: { workspace: { workspaceId: request.path } } }; } },
    session: { create: async () => { calls.push('create'); return { ok: true, value: { sessionId: 'preview' } }; },
      list: async () => ({ ok: true, value: { items: [{ sessionId: 'preview', cwd: '/project' }, { sessionId: 'other', cwd: '/other' }] } }) },
  }, sessions: { retain: id => { calls.push(`retain:${id}`); const ref = { sessionId: id, ready: Promise.resolve({ session: { getSnapshot: () => ({ openState: 'open' }) } }), release: () => calls.push('release') }; bindings.set(id, ref); return ref; } } };
  const acquire = createPreviewSessionAcquirer(ctx), project = { id: 'p', path: '/project' };
  (await acquire(project)).release(); (await acquire(project)).release();
  assert.equal(calls.filter(x => x === 'create').length, 1);
  await assert.rejects(acquire(project, 'other'), /另一个项目/);
  assert.equal(calls.filter(x => x === 'release').length, 3);
});

test('PPTX附件恢复原生文字／备注编辑，明确保存才成为同卡首版，旧工程和附件保留', { skip: SLIDES_SKIP }, async t => {
  const f = fixture(t), { created, file, scope } = await oldTask(f);
  const original = readFileSync(path.join(f.root,file.path)), input = f.service.tasks.get(created.task.id).input;
  const selection={...scope,artifactId:file.id,hash:file.hash,outcome:true};
  const opened=await f.service.deck.open(selection),slide=opened.document.slides[0];
  const edited=f.service.deck.saveDraft({draftId:opened.id,revision:opened.revision,pages:[{slideId:slide.id,changes:[{elementId:slide.elements.find(x=>x.editable).id,text:'在原编辑器修改附件'}],notes:'讲师备注修订'}]});
  assert.equal(f.service.store.db.prepare('SELECT count(*) n FROM output_card_versions WHERE card_id=?').get(scope.cardId).n,0);
  const operationId=randomUUID(),saved=await f.service.deck.saveVersion({draftId:edited.id,revision:edited.revision,operationId});
  assert.equal(saved.descriptor.card.id,scope.cardId);assert.equal(saved.descriptor.version.number,1);
  assert.deepEqual(readFileSync(path.join(f.root,file.path)),original);assert.deepEqual(f.service.tasks.get(created.task.id).input,input);
  assert.equal(f.service.tasks.files.list(f.canvas.id,created.task.id).find(x=>x.id===file.id).kind,'support');
  const replay=await f.service.deck.saveVersion({draftId:edited.id,revision:edited.revision,operationId});assert.equal(replay.artifact.id,saved.artifact.id);
});
