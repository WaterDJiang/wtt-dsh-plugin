import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';
import { inspectMaterialImport, IMPORT_MAX_BYTES } from '../src/material-import.mjs';

function fixture(t, config = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wtt-media-import-')));
  const service = new WorkbenchService({ workspaceRoot: root, ...config });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '媒体导入技术验收', operationId: randomUUID() });
  const imported = (filename, bytes, extra = {}) => service.importMaterial({ requirementId: requirement.id,
    filename, bytes, operationId: randomUUID(), ...extra });
  return { root, service, requirement, imported };
}

function video(root, extension, { format, audioOnly = false } = {}) {
  const file = path.join(root, `${randomUUID()}.${extension}`);
  const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', audioOnly ? 'sine=duration=0.2' : 'color=c=blue:s=64x64:d=0.2:r=5',
    ...(audioOnly ? ['-c:a', 'aac'] : ['-an', '-c:v', ['webm', 'mkv'].includes(extension) ? 'libvpx-vp9' : 'libx264', '-pix_fmt', 'yuv420p']),
    ...(format ? ['-f', format] : []), file], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return readFileSync(file);
}

test('real MP4 and WebM videos retain exact originals and persisted container/stream metadata without claiming transcription', async t => {
  const { root, service, requirement, imported } = fixture(t);
  const ids = [];
  for (const extension of ['mp4', 'webm']) {
    const bytes = video(root, extension);
    const result = await imported(`课程视频.${extension}`, bytes);
    const metadata = result.material.importedFile;
    assert.equal(metadata.mime, `video/${extension}`);
    assert.equal(metadata.extractionStatus, 'unparsed');
    assert.match(metadata.extractionError, /未转写.*未|未转写音频或解析画面/);
    assert.equal(metadata.media.kind, 'video');
    assert.equal(metadata.media.validated, true);
    assert.equal(metadata.media.container, extension);
    assert.equal(metadata.media.width, 64);
    assert.equal(metadata.media.height, 64);
    assert.equal(metadata.media.browserCompatible, true);
    assert.ok(metadata.media.durationSeconds > 0);
    assert.deepEqual(service.canvas.readImportedFile(result.material.id, { preview: true }).bytes, bytes);
    assert.equal(result.board.nodes.find(node => node.refId === result.material.id).importedFile.media.validated, true);
    ids.push(result.material.id);
  }
  const reopened = new WorkbenchService({ workspaceRoot: root });
  try {
    const board = reopened.canvas.getBoard(requirement.id);
    for (const id of ids) assert.equal(board.nodes.find(node => node.refId === id).importedFile.media.validated, true);
  } finally { reopened.close(); }
  assert.equal(inspectMaterialImport({ filename: 'limit.mp4', bytes: Buffer.alloc(IMPORT_MAX_BYTES) }).byteSize, IMPORT_MAX_BYTES);
  assert.throws(() => inspectMaterialImport({ filename: 'limit.webm', bytes: Buffer.alloc(IMPORT_MAX_BYTES + 1) }), error => error.status === 413);
  assert.throws(() => inspectMaterialImport({ filename: 'empty.mp4', bytes: Buffer.alloc(0) }), /不能为空/);
});

test('renamed MOV/MKV, damaged files and audio-only MP4 remain downloadable originals but cannot pretend to be previewable video', async t => {
  const { root, service, imported } = fixture(t);
  const cases = [
    ['renamed.mp4', video(root, 'mov', { format: 'mov' })],
    ['renamed.webm', video(root, 'mkv', { format: 'matroska' })],
    ['audio.mp4', video(root, 'mp4', { audioOnly: true })],
    ['broken.mp4', Buffer.from('<html>not video</html>')],
  ];
  for (const [filename, bytes] of cases) {
    const { material } = await imported(filename, bytes);
    assert.equal(material.importedFile.mime, 'application/octet-stream');
    assert.equal(material.importedFile.media.validated, false);
    assert.equal(material.extracted, false);
    assert.match(material.importedFile.extractionError, /未包含有效的视频流|扩展名不符|文件损坏/);
    assert.deepEqual(service.canvas.readImportedFile(material.id).bytes, bytes);
    assert.throws(() => service.canvas.readImportedFile(material.id, { preview: true }), /图片或视频可预览/);
  }
});

test('missing ffprobe preserves the actual file and reports unavailable verification instead of claiming playback', async t => {
  const { root, service, imported } = fixture(t, { ffprobeExecutable: '/technical/absent-ffprobe' });
  const bytes = video(root, 'mp4');
  const { material } = await imported('缺依赖.mp4', bytes);
  assert.equal(material.importedFile.media.validated, false);
  assert.match(material.importedFile.extractionError, /ffprobe 不可用/);
  assert.deepEqual(service.canvas.readImportedFile(material.id).bytes, bytes);
});

test('card media imports store an editable manual association with frozen anchor hash, while reference imports remain independent', async t => {
  const { root, service, requirement, imported } = fixture(t);
  const bytes = video(root, 'mp4');
  const anchor = service.canvas.getBoard(requirement.id).nodes.find(node => node.kind === 'requirement');
  const association = { cardId: anchor.id, hash: anchor.sourceHash };
  const operationId = randomUUID();
  const result = await imported('卡边视频.mp4', bytes, { association, operationId });
  assert.deepEqual(result.material.association, { ...association, title: anchor.title });
  const node = result.board.nodes.find(node => node.refId === result.material.id);
  assert.ok(node.position.x > anchor.position.x);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM canvas_material_sources WHERE material_id=?').get(result.material.id).n, 0);
  const edge = result.board.edges.find(edge => edge.source === anchor.id && edge.target === node.id);
  assert.ok(edge && !edge.provenance);
  const independent = await imported('独立参考.mp4', bytes);
  assert.equal(independent.material.association, undefined);
  assert.equal(independent.board.edges.some(edge => edge.target === `material:${independent.material.id}`), false);
  const cleared = service.canvas.saveBoard({ requirementId: requirement.id, expectedRevision: independent.board.revision, edges: [] });
  assert.equal(cleared.edges.some(item => item.id === edge.id), false);
  const replay = await imported('卡边视频.mp4', bytes, { association, operationId, position: { x: 900, y: 800 } });
  assert.equal(replay.material.id, result.material.id);
  assert.equal(replay.board.edges.some(edge => edge.target === node.id), false);
  await assert.rejects(imported('卡边视频.mp4', bytes, { association: { ...association, hash: 'f'.repeat(64) }, operationId }), /不同文件或内容/);
  assert.deepEqual(readFileSync(path.join(root, result.material.importedFile.path)), bytes);
});

test('media anchor checks run inside registration after probing; changed and foreign anchors leave no false files or links', async t => {
  const { root, service, requirement, imported } = fixture(t);
  const bytes = video(root, 'mp4');
  const { material } = service.canvas.addMaterial({ requirementId: requirement.id, title: '冻结锚点', content: '原始锚点', operationId: randomUUID() });
  const operationId = randomUUID();
  const pending = imported('晚回执.mp4', bytes, { operationId, association: { cardId: `material:${material.id}`, hash: material.hash } });
  writeFileSync(path.join(root, material.path), '外部已改锚点');
  await assert.rejects(pending, /来源文件不可用或已外改/);
  assert.equal(existsSync(path.join(root, 'courses', requirement.id, 'imports', operationId)), false);
  const other = service.store.createRequirement({ title: '其他需求', operationId: randomUUID() });
  await assert.rejects(imported('跨需求.mp4', bytes, { association: { cardId: `requirement:${other.id}`, hash: 'a'.repeat(64) } }), /不属于当前需求/);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM canvas_imports').get().n, 0);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM canvas_material_associations').get().n, 0);
});
