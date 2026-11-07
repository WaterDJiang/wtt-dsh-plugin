import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { WorkbenchService } from '../src/service.mjs';
import { deliverableName } from '../src/deliverable-files.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-deliverables-'))), revealed = [];
  const service = new WorkbenchService({ workspaceRoot: root, revealDeliverableFile: file => { revealed.push(file); } });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const create = (title = '同名课程') => service.store.createRequirement({ title, background: '技术验收，不发送模型请求', operationId: randomUUID() });
  const requirement = create();
  const outline = (req = requirement) => service.store.saveOutline({ requirementId: req.id, markdown: '# 课程大纲\n\n原内容保留。', operationId: randomUUID() });
  async function file(title, content, generation = { mode: 'new' }, name = 'body.md', kind = 'text') {
    const created = service.createTask({ requirementId: requirement.id, outputType: kind, instruction: '独立技术文件', sourceRefs: [], selectedCardIds: [], selectedSkills: [], generation, operationId: randomUUID() });
    const relative = `${created.prepared.deliveryDirectory}/${name}`;
    if (Buffer.isBuffer(content)) writeFileSync(path.join(root, relative), content);
    else writeFileSync(path.join(root, relative), content);
    const sessionId = `session:${created.task.id}`;
    service.tasks.bindSession({ taskId: created.task.id, sessionId });
    const registered = await service.tasks.files.register({ taskId: created.task.id, title, path: relative, kind, operationId: randomUUID() }, { sessionId });
    return { registered, created };
  }
  return { root, service, requirement, revealed, create, outline, file };
}

test('saved outline automatically creates an independent same-name file, without adding business versions', t => {
  const { root, service, requirement, outline } = fixture(t), version = outline();
  const info = service.deliverables.info(`outline:${version.id}`);
  assert.equal(info.status, 'ready'); assert.equal(info.fileName, '大纲 v1.md');
  assert.match(info.path, /产物\/同名课程\/大纲 v1\/V001\/大纲 v1\.md$/u);
  assert.equal(sha(readFileSync(path.join(root, info.path))), version.hash);
  assert.notEqual(statSync(path.join(root, info.path)).ino, statSync(path.join(root, version.markdownPath)).ino);
  const again = service.deliverables.sync(requirement.id);
  assert.equal(again.ready, 1); assert.equal(service.store.getRequirement(requirement.id).versions.length, 1);
  assert.equal(again.files[0].path, info.path);
});

test('real Word bytes and original outline remain bound to the right version', t => {
  const { root, service, outline } = fixture(t), version = outline();
  const relative = path.posix.join(path.posix.dirname(version.markdownPath), 'outline.docx');
  const result = spawnSync('python3', ['-c', 'from docx import Document; import sys; d=Document(); d.add_paragraph("技术验收正文"); d.save(sys.argv[1])', path.join(root, relative)]);
  assert.equal(result.status, 0, result.stderr?.toString());
  service.store.markWordExport({ versionId: version.id, relativePath: relative });
  const info = service.deliverables.info(`word:${version.id}`);
  assert.equal(info.status, 'ready'); assert.equal(info.version, 1); assert.equal(info.fileName, 'Word · 大纲 v1.docx');
  assert.deepEqual(readFileSync(path.join(root, info.path)), readFileSync(path.join(root, relative)));
});

test('PPT V1/V2 and Finder locations follow exact source references, old files remain', async t => {
  const { root, service, requirement, file, revealed, create } = fixture(t);
  const sample = path.join(root, 'sample.pptx');
  const made = spawnSync('python3', ['-c', 'from pptx import Presentation; from pptx.util import Inches; import sys; p=Presentation(); s=p.slides.add_slide(p.slide_layouts[6]); s.shapes.add_textbox(Inches(1),Inches(1),Inches(6),Inches(2)).text="原生技术课件"; p.save(sys.argv[1])', sample]);
  assert.equal(made.status, 0, made.stderr?.toString());
  const bytes = readFileSync(sample), first = await file('课件初稿', bytes, undefined, 'one.pptx', 'pptx');
  const firstNode = service.canvas.getBoard(requirement.id).nodes.find(node => node.outputCard?.id === first.created.task.outputCardId);
  const firstPath = service.deliverables.info(`artifact:${first.registered.id}`).path;
  const revised = spawnSync('python3', ['-c', 'from pptx import Presentation; import sys; p=Presentation(sys.argv[1]); p.slides[0].shapes[0].text="修订后的第二版"; p.save(sys.argv[1])', sample]);
  assert.equal(revised.status, 0);
  const second = await file('课件精修', readFileSync(sample), { mode: 'revise', cardId: firstNode.outputCard.id, baseVersionId: firstNode.outputCard.versionId }, 'two.pptx', 'pptx');
  const a = service.deliverables.info(`artifact:${first.registered.id}`), b = service.deliverables.info(`artifact:${second.registered.id}`);
  assert.match(a.path, /课件精修\/V001\/课件初稿\.pptx$/u); assert.match(b.path, /课件精修\/V002\/课件精修\.pptx$/u);
  assert.notEqual(a.hash, b.hash);
  assert.equal(service.cards.describe({ requirementId: requirement.id, cardId: firstNode.outputCard.id, versionId: firstNode.outputCard.versionId }).node.delivery.path, a.path);
  assert.deepEqual(readFileSync(path.join(root, firstPath)), bytes);
  assert.equal(sha(readFileSync(path.join(root, first.registered.path))), first.registered.hash);
  await service.deliverables.open({ requirementId: requirement.id, sourceRef: a.sourceRef });
  await service.deliverables.open({ requirementId: requirement.id, sourceRef: b.sourceRef });
  assert.deepEqual(revealed, [path.join(root, a.path), path.join(root, b.path)]);
  await assert.rejects(service.deliverables.open({ requirementId: create('另一个需求').id, sourceRef: a.sourceRef }), /不属于/u);
  assert.equal(revealed.length, 2);
});

test('a fatal index failure cannot roll back the saved output and remains visible to UI and Agent', async t => {
  const { service, requirement, outline } = fixture(t);
  service.deliverables.sync = () => { throw new Error('索引写入失败'); };
  const version = outline(), ref = `outline:${version.id}`;
  assert.equal(service.store.getRequirement(requirement.id).versions.length, 1);
  assert.equal(service.canvas.getBoard(requirement.id).nodes.find(node => node.refId === version.id).delivery.error, '索引写入失败');
  await assert.rejects(service.deliverables.open({ requirementId: requirement.id, sourceRef: ref }), /索引写入失败/u);
});

test('registered file locations survive service restart', t => {
  const { root, service, outline } = fixture(t), version = outline();
  const before = service.deliverables.info(`outline:${version.id}`);
  service.close(); const next = new WorkbenchService({ workspaceRoot: root });
  try { const restored = next.deliverables.info(before.sourceRef); assert.equal(restored.path, before.path); assert.equal(restored.status, 'ready'); }
  finally { next.close(); }
});

test('legacy outline folder follows the projected card version, not its global course number', t => {
  const { service, requirement, outline } = fixture(t);
  outline(); const second = outline();
  const card = service.canvas.getBoard(requirement.id).nodes.find(node => node.refId === second.id && node.kind === 'outline');
  assert.equal(service.deliverables.info(`outline:${second.id}`).version, card.outputCard.number);
  assert.match(service.deliverables.info(`outline:${second.id}`).path, /\/大纲 v2\/V001\//u);
  assert.equal(service.store.getRequirement(requirement.id).versions.length, 2);
});

test('edited copy is preserved, is never republished under a different name, and can be repaired explicitly', t => {
  const { root, service, requirement, outline } = fixture(t), v = outline(), ref = `outline:${v.id}`;
  const info = service.deliverables.info(ref), target = path.join(root, info.path);
  writeFileSync(target, '用户自行修改的副本');
  const result = service.deliverables.sync(requirement.id);
  assert.equal(result.failed, 1); assert.match(result.files[0].error, /副本已被修改/u);
  assert.equal(readFileSync(target, 'utf8'), '用户自行修改的副本');
  assert.equal(sha(readFileSync(path.join(root, v.markdownPath))), v.hash);
  writeFileSync(target, readFileSync(path.join(root, v.markdownPath)));
  assert.equal(service.deliverables.sync(requirement.id).ready, 1);
});

test('missing or changed original never creates a successful copy or Finder action', async t => {
  const { root, service, requirement, outline, revealed } = fixture(t), v = outline();
  writeFileSync(path.join(root, v.markdownPath), '外部改写的原文');
  assert.equal(service.deliverables.sync(requirement.id).failed, 1);
  await assert.rejects(service.deliverables.open({ requirementId: requirement.id, sourceRef: `outline:${v.id}` }), /原产物/u);
  assert.equal(revealed.length, 0);
  unlinkSync(path.join(root, v.markdownPath));
  assert.equal(service.deliverables.sync(requirement.id).failed, 1);
});

test('symlink directories and destination links cannot write outside the project; original save still succeeds', t => {
  const { root, service, requirement, outline } = fixture(t);
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-delivery-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(root, '产物'));
  const v = outline();
  assert.match(service.deliverables.info(`outline:${v.id}`).error, /符号链接/u);
  assert.deepEqual(readdirSync(outside), []); assert.equal(service.store.getRequirement(requirement.id).versions.length, 1);
  unlinkSync(path.join(root, '产物')); service.deliverables.sync(requirement.id);
  const target = path.join(root, service.deliverables.info(`outline:${v.id}`).path), secret = path.join(outside, 'secret.md');
  writeFileSync(secret, '不允许修改'); unlinkSync(target); symlinkSync(secret, target);
  assert.equal(service.deliverables.sync(requirement.id).failed, 1); assert.equal(readFileSync(secret, 'utf8'), '不允许修改');
});

test('old outputs, duplicate course/card titles and pre-existing user files retain independent paths', async t => {
  const { root, service, requirement, outline, create, file } = fixture(t);
  service.store.outputSaved = undefined;
  const v = outline(), relative = `产物/同名课程/大纲 v1/V001/大纲 v1.md`;
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), '原有文件');
  const old = service.deliverables.sync(requirement.id).files[0];
  assert.equal(old.status, 'ready'); assert.notEqual(old.path, relative); assert.equal(readFileSync(path.join(root, relative), 'utf8'), '原有文件');
  const second = create(); outline(second);
  const one = await file('同名文件', '# 一'), two = await file('同名文件', '# 二');
  const all = service.deliverables.sync(); assert.equal(all.failed, 0);
  const a = service.deliverables.info(`artifact:${one.registered.id}`), b = service.deliverables.info(`artifact:${two.registered.id}`);
  assert.notEqual(a.path, b.path); assert.notEqual(a.hash, b.hash);
  assert.equal(sha(readFileSync(path.join(root, v.markdownPath))), v.hash);
});

test('unsafe and long display names remain bounded readable file components', () => {
  for (const name of ['../../坏名字\\file:*?', 'CON', '.', '课'.repeat(300), 'e\u0301']) {
    const normalized = deliverableName(name); assert(normalized); assert(Buffer.byteLength(normalized) <= 120);
    assert(!/[\/\\:*?"<>|]/.test(normalized)); assert.equal(normalized.normalize('NFC'), normalized);
  }
});

test('registered Markdown attachments retain working relative links without altering either source', async t => {
  const { root, service, requirement, file } = fixture(t);
  const { registered, created } = await file('课堂讲义', '# 讲义\n\n[练习数据](materials/input.csv)');
  const relative = `${created.prepared.deliveryDirectory}/materials/input.csv`;
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); writeFileSync(path.join(root, relative), '项目,数量\n练习,1\n');
  const csv = await service.tasks.files.register({ taskId: created.task.id, title: '课程练习数据', path: relative, kind: 'text', primary: false, operationId: randomUUID() }, { sessionId: `session:${created.task.id}` });
  const main = service.deliverables.info(`artifact:${registered.id}`), attachment = service.deliverables.info(`artifact:${csv.id}`);
  const mirror = path.join(root, path.posix.dirname(main.path), 'materials/input.csv');
  assert.deepEqual(readFileSync(mirror), readFileSync(path.join(root, relative)));
  assert.equal(sha(readFileSync(path.join(root, main.path))), registered.hash);
  assert.equal(attachment.status, 'ready'); assert.equal(service.deliverables.sync(requirement.id).failed, 0);
  writeFileSync(mirror, '用户修改的附件');
  assert.equal(service.deliverables.sync(requirement.id).failed, 1);
  assert.equal(readFileSync(mirror, 'utf8'), '用户修改的附件');
});

test('an attachment before its primary has a real file but no fabricated successful version', async t => {
  const { root, service, requirement } = fixture(t);
  const task = service.createTask({ requirementId: requirement.id, outputType: 'text', instruction: '技术附件', selectedSkills: [], sourceRefs: [], selectedCardIds: [], generation: { mode: 'new' }, operationId: randomUUID() });
  const sessionId = `session:${task.task.id}`; service.tasks.bindSession({ taskId: task.task.id, sessionId });
  const relative = task.prepared.deliveryDirectory + '/attachment.md'; writeFileSync(path.join(root, relative), '真实附件');
  const attachment = await service.tasks.files.register({ taskId: task.task.id, title: '先保存的附件', kind: 'text', path: relative, primary: false, operationId: randomUUID() }, { sessionId });
  const info = service.deliverables.info(`artifact:${attachment.id}`);
  assert.equal(info.status, 'ready'); assert.equal(info.version, 0); assert.match(info.path, /\/制作中\//u);
  assert.equal(service.canvas.getBoard(requirement.id).nodes.find(node => node.outputCard?.id === task.task.outputCardId).outputCard.versions.length, 0);
});
