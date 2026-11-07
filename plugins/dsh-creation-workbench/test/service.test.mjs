import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkbenchService, runProcess } from '../src/service.mjs';

const SOURCE = [
  '# 从需求到课程大纲',
  '',
  '## 一、识别学员场景',
  '',
  '关键正文甲：先明确学员需要完成的真实工作，再选择课程内容。',
  '',
  '- 检查目标是否可观察。',
  '',
  '## 二、设计实践任务',
  '',
  '关键正文乙：每个任务同时提供材料、操作要求与练后判断。',
  '',
  '| 阶段 | 核对依据 |',
  '| --- | --- |',
  '| 需求澄清 | 学员任务与业务约束 |',
  '| 课程交付 | 目标覆盖与材料完整 |',
  '',
].join('\n');

function fixture(t, config = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'wtt-service-test-'));
  const service = new WorkbenchService({ ...config, workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({
    title: '需求分析与课程设计', audience: '课程开发人员',
    background: '整理培训需求并形成可审阅的大纲', operationId: randomUUID(),
  });
  const save = (markdown = SOURCE) => service.store.saveOutline({
    requirementId: requirement.id, markdown, operationId: randomUUID(),
  });
  return { root, service, requirement, save };
}

async function wordTexts(service, absolutePath) {
  const script = [
    'import json,sys,zipfile',
    'from docx import Document',
    'p=sys.argv[1]',
    'z=zipfile.ZipFile(p)',
    'assert z.testzip() is None',
    'assert "word/document.xml" in z.namelist()',
    'd=Document(p)',
    'paragraphs=[p.text for p in d.paragraphs]',
    'cells=[c.text for t in d.tables for r in t.rows for c in r.cells]',
    'print(json.dumps({"paragraphs":paragraphs,"cells":cells},ensure_ascii=False))',
  ].join('\n');
  return JSON.parse(await runProcess(service.python, ['-c', script, absolutePath]));
}

test('real local converter produces readable Word with Chinese chapter, paragraph and table content', async (t) => {
  const { root, service, save } = fixture(t);
  const dependencies = await service.dependencies();
  assert.equal(dependencies.word, true, '本机真实 Word Skill 必须可用');
  const version = save();
  const result = await service.exportWord({ versionId: version.id });
  assert.equal(result.id, version.id);
  assert.equal(result.wordPath, path.posix.join(path.posix.dirname(version.markdownPath), 'outline.docx'));
  const text = await wordTexts(service, path.join(root, result.wordPath));
  const paragraphs = text.paragraphs.join('\n');
  assert.ok(paragraphs.includes('从需求到课程大纲'), paragraphs);
  assert.ok(paragraphs.includes('一、识别学员场景'), paragraphs);
  assert.ok(paragraphs.includes('二、设计实践任务'), paragraphs);
  assert.ok(paragraphs.indexOf('一、识别学员场景') < paragraphs.indexOf('二、设计实践任务'));
  assert.ok(paragraphs.includes('关键正文甲：先明确学员需要完成的真实工作，再选择课程内容。'));
  assert.ok(paragraphs.includes('关键正文乙：每个任务同时提供材料、操作要求与练后判断。'));
  assert.ok(paragraphs.includes('检查目标是否可观察。'));
  assert.ok(text.cells.includes('学员任务与业务约束'));
  assert.ok(text.cells.includes('目标覆盖与材料完整'));
  const locked = readFileSync(path.join(root, version.markdownPath), 'utf8');
  assert.equal(locked, SOURCE);
  assert.equal(createHash('sha256').update(locked).digest('hex'), result.hash);
});

test('concurrent and repeated exports reuse one immutable version and existing Word bytes', async (t) => {
  const { root, service, requirement, save } = fixture(t);
  const version = save();
  const [a, b] = await Promise.all([
    service.exportWord({ versionId: version.id }),
    service.exportWord({ versionId: version.id }),
  ]);
  assert.equal(a.wordPath, b.wordPath);
  const output = path.join(root, a.wordPath);
  const original = readFileSync(output);
  const before = statSync(output, { bigint: true }).mtimeNs;
  const replay = await service.exportWord({ versionId: version.id });
  assert.equal(replay.id, version.id);
  assert.deepEqual(readFileSync(output), original);
  assert.equal(statSync(output, { bigint: true }).mtimeNs, before);
  assert.equal(service.store.getRequirement(requirement.id).versions.length, 1);
  assert.deepEqual(readdirSync(path.dirname(output)).sort(), ['outline.docx', 'outline.md']);
});

test('external Markdown edits are refused, and a separately saved new version can export', async (t) => {
  const { root, service, save } = fixture(t);
  const v1 = save();
  writeFileSync(path.join(root, v1.markdownPath), '# 用户在文件夹中修改过的正文\n');
  await assert.rejects(service.exportWord({ versionId: v1.id }), /大纲文件已被外部修改/);
  assert.equal(service.store.getVersion(v1.id).wordPath, null);
  assert.equal(service.store.getVersion(v1.id).markdown, SOURCE);
  assert.deepEqual(readdirSync(path.dirname(path.join(root, v1.markdownPath))), ['outline.md']);
  const v2 = save('# 已另存的新版本\n\n新版本保留新的正文。\n');
  assert.equal(v2.number, 2);
  const exported = await service.exportWord({ versionId: v2.id });
  const text = await wordTexts(service, path.join(root, exported.wordPath));
  assert.ok(text.paragraphs.join('\n').includes('新版本保留新的正文。'));
});

test('missing converter fails visibly without registering a Word export or leaving pending files', async (t) => {
  const missingSkill = path.join(tmpdir(), `wtt-missing-skill-${randomUUID()}`);
  const { root, service, save } = fixture(t, { wordSkillDir: missingSkill });
  assert.equal((await service.dependencies()).word, false);
  const version = save();
  await assert.rejects(service.exportWord({ versionId: version.id }), /convert\.py|Word.*依赖|转换器/);
  assert.equal(service.store.getVersion(version.id).wordPath, null);
  assert.deepEqual(readdirSync(path.dirname(path.join(root, version.markdownPath))), ['outline.md']);
  await assert.rejects(service.download(version.id), /尚未导出/);
});

test('an unregistered existing Word file is retained and never silently adopted or overwritten', async (t) => {
  const { root, service, save } = fixture(t);
  const version = save();
  const output = path.join(root, path.dirname(version.markdownPath), 'outline.docx');
  writeFileSync(output, '用户已有文件，未经工作台验证');
  await assert.rejects(service.exportWord({ versionId: version.id }), /已存在但未登记/);
  assert.equal(readFileSync(output, 'utf8'), '用户已有文件，未经工作台验证');
  assert.equal(service.store.getVersion(version.id).wordPath, null);
});

test('a user file appearing during conversion is never overwritten when publishing Word', async (t) => {
  const { root, service, save } = fixture(t);
  const version = save();
  const output = path.join(root, path.dirname(version.markdownPath), 'outline.docx');
  const originalConverter = path.join(service.wordSkillDir, 'scripts/convert.py');
  const originalTemplate = path.join(service.wordSkillDir, 'assets/templates/kejiangtang_template.docx');
  const wrapperSkill = path.join(root, '.converter-race-fixture');
  mkdirSync(path.join(wrapperSkill, 'scripts'), { recursive: true });
  mkdirSync(path.join(wrapperSkill, 'assets/templates'), { recursive: true });
  symlinkSync(originalTemplate, path.join(wrapperSkill, 'assets/templates/kejiangtang_template.docx'));
  const wrapper = [
    'import pathlib,subprocess,sys',
    `subprocess.run([sys.executable,${JSON.stringify(originalConverter)},*sys.argv[1:]],check=True)`,
    `pathlib.Path(${JSON.stringify(output)}).write_text('USER_CREATED_DURING_EXPORT',encoding='utf8')`,
  ].join('\n');
  writeFileSync(path.join(wrapperSkill, 'scripts/convert.py'), wrapper, 'utf8');
  service.wordSkillDir = wrapperSkill;
  await assert.rejects(service.exportWord({ versionId: version.id }), /EEXIST|已存在|目标/);
  assert.equal(readFileSync(output, 'utf8'), 'USER_CREATED_DURING_EXPORT');
  assert.equal(service.store.getVersion(version.id).wordPath, null);
  assert.deepEqual(readdirSync(path.dirname(output)).sort(), ['outline.docx', 'outline.md']);
});

test('downloads bind to the requested version and return that version’s actual content', async (t) => {
  const { root, service, save } = fixture(t);
  const v1 = save('# 第一版课程\n\n只属于第一版的讲授内容。\n');
  const v2 = save('# 第二版课程\n\n只属于第二版的练习内容。\n');
  await service.exportWord({ versionId: v1.id });
  await assert.rejects(service.download(v2.id), /尚未导出/);
  const first = await service.download(v1.id);
  assert.equal(first.name, '课程大纲-v1.docx');
  const out1 = service.store.getVersion(v1.id).wordPath;
  assert.deepEqual(first.bytes, readFileSync(path.join(root, out1)));
  await service.exportWord({ versionId: v2.id });
  const second = await service.download(v2.id);
  assert.equal(second.name, '课程大纲-v2.docx');
  const out2 = service.store.getVersion(v2.id).wordPath;
  assert.deepEqual(second.bytes, readFileSync(path.join(root, out2)));
  const text1 = (await wordTexts(service, path.join(root, out1))).paragraphs.join('\n');
  const text2 = (await wordTexts(service, path.join(root, out2))).paragraphs.join('\n');
  assert.ok(text1.includes('只属于第一版的讲授内容。'));
  assert.ok(!text1.includes('只属于第二版的练习内容。'));
  assert.ok(text2.includes('只属于第二版的练习内容。'));
  assert.ok(!text2.includes('只属于第一版的讲授内容。'));
});

test('deleted Word artifacts produce a download error rather than substitute another version', async (t) => {
  const { root, service, save } = fixture(t);
  const version = save();
  const output = await service.exportWord({ versionId: version.id });
  rmSync(path.join(root, output.wordPath));
  await assert.rejects(service.download(version.id), /ENOENT|产物/);
  assert.equal(service.store.getVersion(version.id).wordPath, output.wordPath);
});
