import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkbenchService, runProcess } from '../src/service.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-artifact-')));
  const service = new WorkbenchService({ workspaceRoot: root });
  const requirement = service.store.createRequirement({ title: '文件产物技术验收', operationId: randomUUID() });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const create = (outputType, outputPosition = { x: 900, y: 240 }) => {
    const source = service.canvas.getBoard(requirement.id).nodes[0];
    const refs = [{ cardId: source.id, hash: source.sourceHash }];
    const task = service.tasks.create({ requirementId: requirement.id, instruction: `技术验收 ${outputType}`, selectedCardIds: [source.id],
      sourceRefs: refs, outputType, outputPosition, operationId: randomUUID() }, { requirement: { id: requirement.id, title: requirement.title },
      sources: [{ cardId: source.id, title: source.title, kind: source.kind, hash: source.sourceHash, content: source.content }],
      instruction: '技术验收，不是模型生成', sourceRefs: refs, outputType, outputPosition });
    const sessionId = `technical-session-${task.id}`;
    service.tasks.bindSession({ taskId: task.id, sessionId });
    const directory = path.join(root, 'courses', requirement.id, 'tasks', task.id);
    mkdirSync(path.join(directory, 'delivery'), { recursive: true });
    const input = (name, kind = outputType) => ({ taskId: task.id, kind, title: `${kind} 技术验收`, path: path.join(directory, name), operationId: randomUUID() });
    const register = (value, extra = {}) => service.tasks.files.register(value, { sessionId, ...extra });
    return { task, sessionId, directory, input, register };
  };
  return { root, service, requirement, create };
}

async function documents(directory) {
  await runProcess('python3', ['-c', String.raw`
import sys
from pathlib import Path
from pptx import Presentation
from pptx.util import Inches
from docx import Document
from PIL import Image
import fitz
p=Path(sys.argv[1]);p.mkdir(parents=True,exist_ok=True)
deck=Presentation();slide=deck.slides.add_slide(deck.slide_layouts[6]);shape=slide.shapes.add_textbox(Inches(1),Inches(1),Inches(7),Inches(2));shape.text='Technical editable fixture';deck.save(p/'editable.pptx')
Image.new('RGB',(64,36),'white').save(p/'picture.png')
preview=Presentation();slide=preview.slides.add_slide(preview.slide_layouts[6]);slide.shapes.add_picture(str(p/'picture.png'),0,0,width=preview.slide_width,height=preview.slide_height);preview.save(p/'picture-only.pptx')
doc=Document();doc.add_paragraph('Technical script fixture');doc.save(p/'script.docx')
pdf=fitz.open();page=pdf.new_page();page.insert_text((72,72),'Technical exercise fixture');pdf.save(p/'exercise.pdf')
`, directory]);
}

test('real CSV registration, exact downloads, frozen operation replay and output status survive restart', async t => {
  const { root, service, requirement, create } = fixture(t);
  const { task, input, register, sessionId } = create('exercise');
  const values = input('delivery/材料一.csv'); const original = '任务,结果\n识别需求,完成\n';
  writeFileSync(values.path, original);
  const file = await register(values);
  assert.equal(file.kind, 'exercise'); assert.equal(file.validation.format, 'csv'); assert.equal(file.validation.role, 'delivery');
  assert.equal(file.byteSize, Buffer.byteLength(original)); assert.equal(file.status, 'ready');
  assert.equal((await service.tasks.files.download(file.id)).bytes.toString('utf8'), original);
  assert.equal(service.tasks.get(task.id).files[0].id, file.id);
  assert.equal(service.tasks.get(task.id).status, 'output');
  assert.equal(service.tasks.setDispatch({ taskId: task.id, status: 'failed', error: '迟到的发送错误' }).status, 'output');
  await assert.rejects(service.tasks.files.register(values, { sessionId: 'another-session' }), /未绑定当前会话/);
  await assert.rejects(register({ ...values, operationId: randomUUID() }), /不能覆盖旧记录/);
  await assert.rejects(register({ ...values, title: '不同标题' }), /操作标识已用于不同内容/);
  writeFileSync(values.path, original + '外部,修改\n');
  const replayed = await register(values);
  assert.equal(replayed.id, file.id); assert.equal(replayed.hash, file.hash); assert.equal(replayed.status, 'changed');
  await assert.rejects(service.tasks.files.download(file.id), /外改|外部修改/);
  writeFileSync(values.path, original);
  service.close();
  const restarted = new WorkbenchService({ workspaceRoot: root });
  try {
    assert.equal(restarted.tasks.get(task.id).files[0].id, file.id);
    const board = restarted.canvas.getBoard(requirement.id);
    const node = board.nodes.find(node => node.id === `artifact:${file.id}`);
    assert.equal(node.kind, 'artifact'); assert.equal(node.artifactKind, 'exercise'); assert.equal(node.sourceHash, file.hash);
    assert.equal(node.content, original); assert.deepEqual(node.position, { x: 900, y: 240 });
    assert.ok(board.edges.find(edge => edge.source === `requirement:${requirement.id}` && edge.target === node.id && edge.provenance));
  } finally { restarted.close(); }
});

test('PPT uses actual package parsing and the existing native-editability gate, which Board does not rerun', async t => {
  const { root, service, requirement, create } = fixture(t);
  const { input, register, directory } = create('pptx');
  const fixtures = path.join(root, 'formats'); await documents(fixtures);
  const values = input('delivery/正式课件.pptx'); cpSync(path.join(fixtures, 'editable.pptx'), values.path);
  const instrumented = path.join(root, 'instrumented-builder'), counter = path.join(root, 'validation-count.txt');
  mkdirSync(path.join(instrumented, 'scripts'), { recursive: true });
  const actual = path.join(os.homedir(), '.codex/skills/wtt-course-pptx-builder/scripts/validate_pptx_editability.py');
  writeFileSync(path.join(instrumented, 'scripts/validate_pptx_editability.py'), `import runpy\nfrom pathlib import Path\nPath(${JSON.stringify(counter)}).open('a').write('checked\\n')\nrunpy.run_path(${JSON.stringify(actual)},run_name='__main__')\n`);
  const file = await register(values, { pptSkillDir: instrumented });
  assert.equal(file.validation.editability.ok, true); assert.ok(file.validation.editability.totals.editable_leaf_objects > 0);
  for (let index = 0; index < 3; index++) service.canvas.getBoard(requirement.id);
  assert.equal(readFileSync(counter, 'utf8'), 'checked\n');
  const node = service.canvas.getBoard(requirement.id).nodes.find(node => node.refId === file.id);
  assert.equal(node.extracted, false); assert.match(node.content, /未提取正文/);
  const preview = input('delivery/deck_preview_noneditable.pptx'); cpSync(values.path, preview.path);
  await assert.rejects(register(preview), /视觉预览/);
  const pictures = input('delivery/图片式课件.pptx'); cpSync(path.join(fixtures, 'picture-only.pptx'), pictures.path);
  await assert.rejects(register(pictures), /picture-only slide ratio|原生可编辑性/);
  assert.equal(service.tasks.files.list(requirement.id).length, 1);
});

test('PDF, DOCX, script text and intermediate formats are real files rather than renamed placeholders', async t => {
  const { root, service, create } = fixture(t);
  const fixtures = path.join(root, 'formats'); await documents(fixtures);
  const exercise = create('exercise'), script = create('script'), ppt = create('pptx');
  const pdf = exercise.input('delivery/练习.pdf'); cpSync(path.join(fixtures, 'exercise.pdf'), pdf.path);
  assert.equal((await exercise.register(pdf)).validation.pages, 1);
  const doc = script.input('delivery/讲稿.docx'); cpSync(path.join(fixtures, 'script.docx'), doc.path);
  assert.equal((await script.register(doc)).validation.format, 'docx');
  const markdown = script.input('delivery/讲稿.md'); writeFileSync(markdown.path, '# 技术验收讲稿\n不是模型生成。');
  const text = await script.register(markdown);
  assert.equal(service.canvas.resolveTextSource(text.requirementId, `artifact:${text.id}`).content, '# 技术验收讲稿\n不是模型生成。');
  const quote = '技术验收讲稿';
  const excerpt = service.canvas.addExcerpt({ requirementId: text.requirementId, sourceCardId: `artifact:${text.id}`, sourceHash: text.hash,
    start: 2, end: 2 + quote.length, quote, title: '脚本中的冻结摘录', operationId: randomUUID() });
  writeFileSync(markdown.path, '# 外改后的讲稿');
  const frozen = service.canvas.getBoard(text.requirementId).nodes.find(node => node.id === `material:${excerpt.material.id}`);
  assert.equal(frozen.content, quote); assert.equal(frozen.status, 'ready'); assert.notEqual(frozen.excerptInfo.sourceStatus, 'ready');
  assert.throws(() => service.canvas.validateSourceRefs(text.requirementId, [{ cardId: `artifact:${text.id}`, hash: text.hash }]), /来源文件不可用或已外改/);
  const story = ppt.input('course-handoff/pages.jsonl', 'storyboard'); mkdirSync(path.dirname(story.path), { recursive: true }); writeFileSync(story.path, '{"page_id":"P001"}\n');
  assert.equal((await ppt.register(story)).validation.role, 'intermediate');
  for (const [owner, name, content, kind] of [
    [exercise, 'delivery/fake.pdf', 'not pdf', 'exercise'],
    [exercise, 'delivery/fake.csv', '%PDF-1.4\n1 0 obj', 'exercise'],
    [exercise, 'delivery/internal.md', '# 内部制作稿', 'exercise'],
    [script, 'delivery/fake.docx', 'not docx', 'script'],
    [script, 'delivery/invalid.md', Buffer.from([0xff, 0xfe, 0]), 'script'],
    [ppt, 'broken.jsonl', '{not json}', 'storyboard'],
  ]) {
    const value = owner.input(name, kind); writeFileSync(value.path, content);
    await assert.rejects(owner.register(value));
  }
});

test('model SVG and HTML support files keep exact bytes, mirrored files and immutable hashes', async t => {
  const { root, service, requirement, create } = fixture(t);
  const owner = create('text');
  for (const [name, body, format] of [
    ['模型.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text x="5" y="20">课程模型</text></svg>', 'svg'],
    ['模型.html', '<!doctype html><html lang="zh"><body><button>课程节点</button><script>window.example=1</script></body></html>', 'html'],
  ]) {
    const value = owner.input(`delivery/${name}`, 'support'); writeFileSync(value.path, body);
    const file = await owner.register({ ...value, primary: false });
    assert.equal(file.validation.format, format); assert.equal(file.validation.presentation, 'download-only');
    assert.equal(file.validation.rendered, false); assert.equal(file.validation.role, 'intermediate');
    assert.equal((await service.tasks.files.download(file.id)).bytes.toString(), body);
    assert.equal(readFileSync(path.join(root, file.delivery.path), 'utf8'), body);
    assert.equal(service.canvas.getBoard(requirement.id).nodes.find(n => n.refId === file.id).extracted, false);
    writeFileSync(value.path, body + '\nchanged');
    await assert.rejects(service.tasks.files.download(file.id), /外部修改|外改/);
  }
});

test('model support rejects disguised, malformed, entity-bearing and incomplete documents', async t => {
  const { create } = fixture(t), owner = create('text');
  for (const [name, body] of [
    ['伪模型.svg', '# Markdown is not SVG'],
    ['坏模型.svg', '<svg><text></svg>'],
    ['实体.svg', '<!DOCTYPE svg [<!ENTITY label "example">]><svg>&label;</svg>'],
    ['错误根.svg', '<html><body>not SVG</body></html>'],
    ['片段.html', '<button>not a standalone model</button>'],
    ['伪PDF.html', '%PDF-1.7\n<html><body>not HTML</body></html>'],
    ['二进制.html', Buffer.from([0xff, 0xfe, 0])],
    ['过大.html', Buffer.alloc(20 * 1024 * 1024 + 1, 32)],
  ]) {
    const value = owner.input(`delivery/${name}`, 'support'); writeFileSync(value.path, body);
    await assert.rejects(owner.register(value));
  }
});

test('picture handouts can be support while the same deck still fails the formal PPT editability gate', async t => {
  const { root, create } = fixture(t), owner = create('text'), ppt = create('pptx');
  const samples = path.join(root, 'handout-formats'); await documents(samples);
  const handout = owner.input('delivery/学员手册.pptx', 'support'); cpSync(path.join(samples, 'picture-only.pptx'), handout.path);
  const file = await owner.register({ ...handout, primary: false });
  assert.equal(file.validation.pages, 1); assert.equal(file.validation.editabilityChecked, false);
  assert.equal(file.validation.presentation, 'download-only'); assert.equal(file.validation.editability, undefined);
  const main = ppt.input('delivery/正式课件.pptx'); cpSync(handout.path, main.path);
  await assert.rejects(ppt.register(main), /picture-only slide ratio|原生可编辑性/);
});

test('outline tasks register teacher manuscripts as support without mislabeling them as a text primary', async t => {
  const { create } = fixture(t), owner = create('outline');
  const value = owner.input('delivery/讲师大纲.md', 'text'); writeFileSync(value.path, '# 讲师用附属大纲\n保留机构版主产物。');
  await assert.rejects(owner.register({ ...value, primary: false }), /kind=support、primary=false/);
  const registered = await owner.register({ ...value, kind: 'support', primary: false });
  assert.equal(registered.kind, 'support'); assert.equal(registered.validation.role, 'intermediate');
});

test('task/session scopes, parent symlinks, immutable registration and transaction failures cannot manufacture files', async t => {
  const { root, service, requirement, create } = fixture(t);
  const first = create('script'), second = create('script');
  const outside = path.join(root, 'outside.md'); writeFileSync(outside, '# 外部文件');
  await assert.rejects(first.register({ ...first.input('delivery/a.md'), path: outside }), /本任务/);
  const wrong = second.input('delivery/属于另一任务.md'); writeFileSync(wrong.path, '# 另一个任务');
  await assert.rejects(first.register({ ...wrong, taskId: first.task.id }), /本任务/);
  const linked = first.input('delivery/link.md'); symlinkSync(outside, linked.path);
  await assert.rejects(first.register(linked), /符号链接/);
  const parentLink = path.join(first.directory, 'delivery', 'alias'); symlinkSync(root, parentLink, 'dir');
  await assert.rejects(first.register({ ...first.input('delivery/alias/outside.md') }), /符号链接/);
  const value = first.input('delivery/讲稿.md'); writeFileSync(value.path, '# 事务验收');
  service.store.db.exec("CREATE TRIGGER reject_file_operation BEFORE INSERT ON operations WHEN NEW.kind='register-artifact' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  await assert.rejects(first.register(value), /fixture rollback/);
  assert.equal(service.tasks.files.list(requirement.id).length, 0); assert.equal(existsSync(value.path), true);
  assert.equal(service.tasks.get(first.task.id).status, 'draft');
  service.store.db.exec('DROP TRIGGER reject_file_operation');
  const file = await first.register(value);
  rmSync(value.path);
  assert.equal(service.tasks.files.get(file.id).status, 'missing');
  await assert.rejects(service.tasks.files.download(file.id), /缺失/);
});

test('a file changed while the native PPT validator runs never becomes a registered artifact', async t => {
  const { root, service, requirement, create } = fixture(t);
  const owner = create('pptx');
  const fixtures = path.join(root, 'formats'); await documents(fixtures);
  const value = owner.input('delivery/验证期间变化.pptx'); cpSync(path.join(fixtures, 'editable.pptx'), value.path);
  const instrumented = path.join(root, 'changing-builder'); mkdirSync(path.join(instrumented, 'scripts'), { recursive: true });
  const actual = path.join(os.homedir(), '.codex/skills/wtt-course-pptx-builder/scripts/validate_pptx_editability.py');
  writeFileSync(path.join(instrumented, 'scripts/validate_pptx_editability.py'), `import runpy\nfrom pathlib import Path\ntry:\n runpy.run_path(${JSON.stringify(actual)},run_name='__main__')\nexcept SystemExit:\n Path(${JSON.stringify(value.path)}).write_bytes(b'changed during validation')\n raise\n`);
  await assert.rejects(owner.register(value, { pptSkillDir: instrumented }), /验证期间产物文件发生变化/);
  assert.equal(service.tasks.files.list(requirement.id).length, 0);
  assert.equal(service.store.db.prepare('SELECT * FROM operations WHERE id=?').get(value.operationId), undefined);
  assert.equal(service.tasks.get(owner.task.id).status, 'draft');
});
