import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pngResult = spawnSync('python3', ['-c', 'import io,sys; from PIL import Image; b=io.BytesIO(); Image.new("RGB",(3,2),(32,100,180)).save(b,format="PNG"); sys.stdout.buffer.write(b.getvalue())']);
assert.equal(pngResult.status, 0, pngResult.stderr.toString());
const png = pngResult.stdout;
const models = [
  { id: 'jimeng-5.0', type: 'image', requiresReference: false, maxReferences: 10, ratios: ['4:3', '16:9'], resolutions: ['2k'] },
  { id: 'jimeng-video-3.0', type: 'video', requiresReference: false, maxReferences: 2, ratios: ['4:3', '1:1'], resolutions: ['720p'], durations: [5, 10] },
  { id: 'seedance-2.0-mini', type: 'video', requiresReference: true, maxReferences: 9, ratios: ['4:3'], resolutions: ['720p'], durations: [4, 6] },
];

function provider(extra = {}) {
  const calls = { submit: [], query: [], download: [] };
  const fake = { calls,
    capabilities: async () => ({ endpoint: 'http://127.0.0.1:8000', credentialConfigured: true, healthy: true,
      modelDefaults: { image: 'jimeng-5.0', video: 'jimeng-video-3.0' }, models }),
    submit: async data => { calls.submit.push(data); return fake.onSubmit ? fake.onSubmit(data) : { resultBase64: png.toString('base64') }; },
    query: async id => { calls.query.push(id); return fake.onQuery ? fake.onQuery(id) : { status: 'succeeded', resultURL: 'https://media.example.test/result' }; },
    download: async url => { calls.download.push(url); return fake.onDownload ? fake.onDownload(url) : { bytes: png, mime: 'image/png' }; },
    close() {}, ...extra,
  };
  return fake;
}

function fixture(t, fake = provider(), options = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-media-generation-')));
  const service = new WorkbenchService({ workspaceRoot: root, mediaProvider: fake, mediaPollIntervalMs: 5, ...options });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '媒体任务只读模拟验收', background: '用图展示培训流程', operationId: randomUUID() });
  const source = service.canvas.getBoard(requirement.id).nodes.find(node => node.kind === 'requirement');
  const input = extra => ({ requirementId: requirement.id, selectedCardIds: [source.id], sourceRefs: [{ cardId: source.id, hash: source.sourceHash }],
    outputType: 'image', instruction: '画一张简洁的课程流程图', operationId: randomUUID(), outputPosition: { x: 740, y: 120 }, ...extra });
  return { root, service, requirement, source, input, fake };
}

async function until(service, taskId, predicate = value => value.job.status === 'succeeded') {
  const limit = Date.now() + 8000;
  let result;
  do {
    result = service.media.get(taskId);
    if (predicate(result)) return result;
    await new Promise(resolve => setTimeout(resolve, 8));
  } while (Date.now() < limit);
  assert.fail(`media timeout: ${JSON.stringify(result)}`);
}

test('cancelling queued work and pausing a blocked submission releases the queue and rejects late output', async t => {
  let resolveFirst;
  const fake = provider({ onSubmit: () => fake.calls.submit.length === 1
    ? new Promise(resolve => { resolveFirst = resolve; }) : { resultBase64: png.toString('base64') } });
  const { service, input } = fixture(t, fake);
  const first = await service.media.create(input());
  await until(service, first.task.id, value => value.job.status === 'submitting');
  const second = await service.media.create(input());
  assert.equal(service.media.pause(second.task.id).job.status, 'cancelled');
  assert.equal(service.media.pause(first.task.id).job.status, 'paused');
  const third = await service.media.create(input());
  await until(service, third.task.id);
  assert.equal(fake.calls.submit.length, 2, 'cancelled queue item must never submit');
  resolveFirst({ resultBase64: png.toString('base64') });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(service.media.get(first.task.id).job.status, 'paused');
  assert.equal(service.media.get(first.task.id).task.files.length, 0);
  assert.equal(service.media.get(second.task.id).task.files.length, 0);
});

test('a late provider acknowledgement is retained for manual lookup without resubmitting or resuming polling', async t => {
  let acknowledge;
  const fake = provider({ onSubmit: () => new Promise(resolve => { acknowledge = resolve; }) });
  const { service, root, input } = fixture(t, fake);
  const { task } = await service.media.create(input());
  await until(service, task.id, value => value.job.status === 'submitting');
  service.media.pause(task.id);
  acknowledge({ providerTaskId: 'synthetic-provider-id' });
  await until(service, task.id, value => value.job.providerTaskId === 'synthetic-provider-id');
  assert.equal(service.media.job(task.id).status, 'paused');
  assert.equal(service.media.job(task.id).canResume, true);
  assert.equal(fake.calls.query.length, 0);
  service.close();
  const reopened = new WorkbenchService({ workspaceRoot: root, mediaProvider: fake, mediaPollIntervalMs: 5 });
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(reopened.media.job(task.id).status, 'paused');
    assert.equal(fake.calls.query.length, 0, 'restart must not resume a paused task');
    reopened.media.resume(task.id);
    await until(reopened, task.id);
    assert.equal(fake.calls.submit.length, 1, 'resume must query the original provider task');
    assert.deepEqual(fake.calls.query, ['synthetic-provider-id']);
  } finally { reopened.close(); }
});

test('pausing a pending query ignores its late result and only an explicit resume may register output', async t => {
  let finishQuery;
  const fake = provider({ onSubmit: () => ({ providerTaskId: 'pending-query' }),
    onQuery: () => new Promise(resolve => { finishQuery = resolve; }) });
  const { service, input } = fixture(t, fake);
  const { task } = await service.media.create(input());
  await until(service, task.id, () => Boolean(finishQuery));
  service.media.pause(task.id);
  finishQuery({ status: 'succeeded', resultURL: 'https://media.example.test/late' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(service.media.job(task.id).status, 'paused');
  assert.equal(fake.calls.download.length, 0);
  assert.equal(service.media.get(task.id).task.files.length, 0);
  fake.onQuery = () => ({ status: 'succeeded', resultURL: 'https://media.example.test/resumed' });
  service.media.resume(task.id);
  await until(service, task.id);
  assert.equal(fake.calls.submit.length, 1);
  assert.equal(service.media.get(task.id).task.files.length, 1);
});

test('a download arriving after pause cannot write or register media bytes', async t => {
  let finishDownload;
  const fake = provider({ onSubmit: () => ({ resultURL: 'https://media.example.test/held' }),
    onDownload: () => new Promise(resolve => { finishDownload = resolve; }) });
  const { service, input } = fixture(t, fake);
  const { task } = await service.media.create(input());
  await until(service, task.id, () => Boolean(finishDownload));
  service.media.pause(task.id);
  finishDownload({ bytes: png, mime: 'image/png' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(service.media.job(task.id).status, 'paused');
  assert.equal(service.media.get(task.id).task.files.length, 0);
  assert.equal(service.store.db.prepare('SELECT downloaded_path FROM media_jobs WHERE task_id=?').get(task.id).downloaded_path, null);
  assert.equal(fake.calls.submit.length, 1);
});

test('image generation persists a separate task, one real validated delivery, immutable inputs and provenance', async t => {
  const { service, input, fake, requirement, source, root } = fixture(t);
  const args = input();
  const first = await service.media.create(args);
  assert.equal(first.task.kind, 'media');
  assert.equal(first.task.sessionId, null);
  assert.equal(first.task.input.media.model, 'jimeng-5.0');
  assert.match(first.task.input.effectivePrompt, /画一张简洁/);
  const repeated = await service.media.create(args);
  assert.equal(repeated.task.id, first.task.id);
  assert.throws(() => service.createTask({ ...args, media: { model: 'jimeng-5.0', ratio: '4:3', resolution: '2k' } }), /媒体.*生成入口/);
  const completed = await until(service, first.task.id);
  assert.equal(fake.calls.submit.length, 1);
  assert.equal(completed.task.status, 'output');
  assert.equal(completed.task.files.length, 1);
  const file = completed.task.files[0];
  assert.equal(file.kind, 'image');
  assert.equal(file.hash, sha(png));
  assert.equal(file.validation.media.width, 3);
  assert.deepEqual(readFileSync(path.join(root, file.path)), png);
  assert.match(file.path, new RegExp(`/tasks/${first.task.id}/delivery/`));
  assert.throws(() => service.tasks.bindSession({ taskId: first.task.id, sessionId: 'invented-native-session' }), /不绑定/);
  await assert.rejects(service.tasks.files.register({ taskId: first.task.id, kind: 'image', path: file.path, title: '绕过验证', operationId: randomUUID() },
    { sessionId: 'invented-native-session' }), /已有 AI 创作任务/);
  const board = service.canvas.getBoard(requirement.id), card = board.nodes.find(node => node.refId === file.id);
  assert.equal(card.kind, 'artifact');
  assert.equal(card.artifactKind, 'image');
  assert.equal(card.status, 'ready');
  assert.equal(card.generatedFile.sha256, sha(png));
  assert.equal(card.generatedFile.media.validated, true);
  assert.deepEqual(card.position, args.outputPosition);
  assert.ok(board.edges.some(edge => edge.provenance && edge.source === source.id && edge.target === card.id));
  assert.equal(completed.job.resultURL, undefined);
  assert.equal(completed.task.input.sessionId, undefined);
  await assert.rejects(service.media.create({ ...args, media: { model: 'jimeng-5.0', ratio: '16:9', resolution: '2k' } }), /不同内容/);
});

test('POST ambiguity and a restart during submitting stay unknown and are never resubmitted', async t => {
  let complete;
  const fake = provider({ onSubmit: () => new Promise(resolve => { complete = resolve; }) });
  const { service, root, input } = fixture(t, fake);
  const args = input(), created = await service.media.create(args);
  await until(service, created.task.id, value => value.job.status === 'submitting');
  assert.equal(fake.calls.submit.length, 1);
  service.close();
  const reopened = new WorkbenchService({ workspaceRoot: root, mediaProvider: fake, mediaPollIntervalMs: 5 });
  try {
    assert.equal(reopened.media.get(created.task.id).job.status, 'unknown');
    assert.equal(reopened.media.get(created.task.id).task.status, 'unknown');
    reopened.media.resume(created.task.id);
    assert.equal((await reopened.media.create(args)).task.id, created.task.id);
    complete({ resultBase64: png.toString('base64') });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(fake.calls.submit.length, 1);
    assert.equal(reopened.media.get(created.task.id).task.files.length, 0);
  } finally { reopened.close(); }
  const ambiguous = fixture(t, provider({ onSubmit: () => { throw Object.assign(new Error('提交结果未知'), { code: 'submission_unknown' }); } }));
  const task = await ambiguous.service.media.create(ambiguous.input());
  assert.equal((await until(ambiguous.service, task.task.id, value => value.job.status === 'unknown')).job.errorCode, 'submission_unknown');
  const unexpected = fixture(t, provider({ onSubmit: () => { throw new Error('unexpected adapter interruption'); } }));
  const interrupted = await unexpected.service.media.create(unexpected.input());
  assert.equal((await until(unexpected.service, interrupted.task.id, value => value.job.status === 'unknown')).job.errorCode, 'submission_unknown');
});

test('known video task id survives restart and only resumes GET; real video stream is checked before registration', async t => {
  let resolveQuery;
  const fake = provider({ onSubmit: () => ({ providerTaskId: 'provider-video-001' }), onQuery: () => new Promise(resolve => { resolveQuery = resolve; }) });
  const { service, input, root } = fixture(t, fake);
  const media = path.join(root, 'fixture.mp4');
  const rendered = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:d=0.2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', media]);
  assert.equal(rendered.status, 0, rendered.stderr.toString());
  const video = readFileSync(media);
  const created = await service.media.create(input({ outputType: 'video' }));
  await until(service, created.task.id, value => value.job.providerTaskId === 'provider-video-001');
  service.close();
  fake.onQuery = () => ({ status: 'succeeded', resultURL: 'https://media.example.test/video.mp4' });
  fake.onDownload = () => ({ bytes: video, mime: 'video/mp4' });
  const reopened = new WorkbenchService({ workspaceRoot: root, mediaProvider: fake, mediaPollIntervalMs: 5 });
  try {
    const completed = await until(reopened, created.task.id);
    assert.equal(fake.calls.submit.length, 1);
    assert.ok(fake.calls.query.every(value => value === 'provider-video-001'));
    assert.equal(completed.task.files[0].kind, 'video');
    assert.equal(completed.task.files[0].validation.media.validated, true);
    assert.equal(completed.task.files[0].hash, sha(video));
    resolveQuery?.({ status: 'processing' });
  } finally { reopened.close(); }
});

test('known result download and registration retry never submit generation again or overwrite a file', async t => {
  let attempts = 0;
  const fake = provider({ onSubmit: () => ({ resultURL: 'https://media.example.test/one.png' }), onDownload: () => {
    if (++attempts === 1) throw new Error('模拟下载连接失败');
    return { bytes: png, mime: 'image/png' };
  } });
  const { service, input, root } = fixture(t, fake, { pythonExecutable: path.join(os.tmpdir(), randomUUID()) });
  const created = await service.media.create(input());
  const failed = await until(service, created.task.id, value => value.job.status === 'download_failed');
  assert.equal(failed.task.status, 'failed');
  assert.equal(failed.job.canResume, true);
  service.media.resume(created.task.id);
  await until(service, created.task.id, value => value.job.status === 'registration_failed');
  const stored = service.store.db.prepare('SELECT * FROM media_jobs WHERE task_id=?').get(created.task.id);
  assert.equal(sha(readFileSync(path.join(root, stored.downloaded_path))), sha(png));
  service.python = 'python3';
  service.media.resume(created.task.id);
  await until(service, created.task.id);
  assert.equal(fake.calls.submit.length, 1);
  assert.equal(fake.calls.download.length, 2);
  assert.equal(service.tasks.get(created.task.id).files.length, 1);
  service.media.resume(created.task.id);
  assert.equal(fake.calls.submit.length, 1);
});

test('reference bytes are real managed images; foreign, changed, invalid and video references fail visibly', async t => {
  const { service, input, requirement, fake, root } = fixture(t);
  const imported = await service.importMaterial({ requirementId: requirement.id, filename: '参考.png', bytes: png, operationId: randomUUID() });
  const card = imported.board.nodes.find(node => node.refId === imported.material.id);
  const args = input({ selectedCardIds: [card.id], sourceRefs: [{ cardId: card.id, hash: card.sourceHash }] });
  const created = await service.media.create(args);
  await until(service, created.task.id);
  assert.equal(fake.calls.submit[0].references.length, 1);
  assert.deepEqual(fake.calls.submit[0].references[0].bytes, png);
  assert.equal(created.task.input.mediaReferences[0].imageHash, sha(png));
  const generated = service.canvas.getBoard(requirement.id).nodes.find(node => node.artifactKind === 'image');
  const useGenerated = await service.media.create(input({ selectedCardIds: [generated.id], sourceRefs: [{ cardId: generated.id, hash: generated.sourceHash }] }));
  await until(service, useGenerated.task.id);
  assert.deepEqual(fake.calls.submit[1].references[0].bytes, png);
  const other = service.store.createRequirement({ title: '另一课程', operationId: randomUUID() });
  await assert.rejects(service.media.create({ ...args, requirementId: other.id, operationId: randomUUID() }), /不属于当前需求/);
  writeFileSync(path.join(root, imported.material.importedFile.path), Buffer.from('changed'));
  await assert.rejects(service.media.create({ ...args, operationId: randomUUID() }), /外改|不可用/);
  const invalid = await service.importMaterial({ requirementId: requirement.id, filename: '损坏.png', bytes: Buffer.from('not PNG'), operationId: randomUUID() });
  const badCard = invalid.board.nodes.find(node => node.refId === invalid.material.id);
  await assert.rejects(service.media.create(input({ selectedCardIds: [badCard.id], sourceRefs: [{ cardId: badCard.id, hash: badCard.sourceHash }] })), /真实格式验证/);
  const video = await service.importMaterial({ requirementId: requirement.id, filename: '损坏.mp4', bytes: Buffer.from('bad video'), operationId: randomUUID() });
  const videoCard = video.board.nodes.find(node => node.refId === video.material.id);
  await assert.rejects(service.media.create(input({ selectedCardIds: [videoCard.id], sourceRefs: [{ cardId: videoCard.id, hash: videoCard.sourceHash }] })), /不会忽略视频/);
});

test('global generation is serial across projects and a frozen image modified in the queue is not submitted', async t => {
  let finish;
  const first = fixture(t, provider({ onSubmit: () => new Promise(resolve => { finish = resolve; }) }));
  const a = await first.service.media.create(first.input());
  await until(first.service, a.task.id, value => value.job.status === 'submitting');
  const second = fixture(t);
  const imported = await second.service.importMaterial({ requirementId: second.requirement.id, filename: '排队引用.png', bytes: png, operationId: randomUUID() });
  const card = imported.board.nodes.find(node => node.refId === imported.material.id);
  const b = await second.service.media.create(second.input({ selectedCardIds: [card.id], sourceRefs: [{ cardId: card.id, hash: card.sourceHash }] }));
  assert.equal(second.service.media.get(b.task.id).job.status, 'queued');
  assert.equal(second.fake.calls.submit.length, 0);
  writeFileSync(path.join(second.root, imported.material.importedFile.path), Buffer.from('changed while queued'));
  finish({ resultBase64: png.toString('base64') });
  await until(first.service, a.task.id);
  const failed = await until(second.service, b.task.id, value => value.job.status === 'failed');
  assert.equal(failed.job.errorCode, 'reference_changed');
  assert.equal(second.fake.calls.submit.length, 0);
});

test('media format validation rejects disguised output, size overflow and delivery symlinks without artifacts', async t => {
  const bad = fixture(t, provider({ onSubmit: () => ({ resultBase64: Buffer.from('<html>fake image</html>').toString('base64') }) }));
  const malformed = await bad.service.media.create(bad.input());
  const failure = await until(bad.service, malformed.task.id, value => value.job.status === 'download_failed');
  assert.equal(failure.task.files.length, 0);
  const big = fixture(t, provider({ onDownload: () => ({ bytes: Buffer.alloc(200 * 1024 * 1024 + 1), mime: 'image/png' }), onSubmit: () => ({ resultURL: 'https://media.example.test/oversized' }) }));
  const oversized = await big.service.media.create(big.input());
  assert.match((await until(big.service, oversized.task.id, value => value.job.status === 'download_failed')).job.error, /200 MiB/);
  const linked = fixture(t);
  const outside = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-media-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, path.join(linked.root, 'courses'));
  const stopped = await linked.service.media.create(linked.input());
  assert.match((await until(linked.service, stopped.task.id, value => value.job.status === 'download_failed')).job.error, /符号链接/);
  assert.equal(linked.service.tasks.get(stopped.task.id).files.length, 0);
});

test('invalid model, silently rewritten parameters, missing service/credential and reference limits do not admit a task', async t => {
  const { service, input, fake } = fixture(t);
  await assert.rejects(service.media.create(input({ media: { model: 'imaginary-model' } })), /支持目录/);
  await assert.rejects(service.media.create(input({ outputType: 'video', media: { model: 'seedance-2.0-mini', duration: 5 } })), /不能静默改写/);
  await assert.rejects(service.media.create(input({ outputType: 'video', media: { model: 'seedance-2.0-mini' } })), /至少引用一张/);
  fake.capabilities = async () => ({ endpoint: 'http://127.0.0.1:8000', credentialConfigured: false, healthy: true, modelDefaults: { image: 'jimeng-5.0' }, models });
  await assert.rejects(service.media.create(input()), error => error.code === 'credential_missing');
  fake.capabilities = async () => ({ endpoint: 'http://127.0.0.1:8000', credentialConfigured: true, healthy: false, modelDefaults: { image: 'jimeng-5.0' }, models });
  await assert.rejects(service.media.create(input()), error => error.code === 'service_unavailable');
  assert.equal(fake.calls.submit.length, 0);
  assert.equal(service.tasks.list(input().requirementId).length, 0);
});

test('queue transaction rollback cannot submit or leave a task without its media journal', async t => {
  const { service, input, fake, requirement } = fixture(t);
  service.store.db.exec("CREATE TRIGGER reject_media_queue BEFORE INSERT ON media_jobs BEGIN SELECT RAISE(ABORT,'media queue refused'); END");
  const args = input();
  await assert.rejects(service.media.create(args), /media queue refused/);
  assert.equal(service.tasks.list(requirement.id).length, 0);
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM media_jobs').get().n, 0);
  assert.equal(fake.calls.submit.length, 0);
  service.store.db.exec('DROP TRIGGER reject_media_queue');
  const created = await service.media.create(args);
  await until(service, created.task.id);
  assert.equal(fake.calls.submit.length, 1);
});

test('failed artifact transaction preserves known download and retry atomically records output without another generation', async t => {
  const { service, input, fake } = fixture(t);
  service.store.db.exec("CREATE TRIGGER reject_media_artifact BEFORE INSERT ON task_files BEGIN SELECT RAISE(ABORT,'media artifact refused'); END");
  const created = await service.media.create(input());
  const failed = await until(service, created.task.id, value => value.job.status === 'registration_failed');
  assert.equal(failed.task.files.length, 0);
  assert.equal(failed.task.status, 'failed');
  assert.equal(failed.job.artifactId, undefined);
  service.store.db.exec('DROP TRIGGER reject_media_artifact');
  service.media.resume(created.task.id);
  const completed = await until(service, created.task.id);
  assert.equal(completed.task.status, 'output');
  assert.equal(completed.job.artifactId, completed.task.files[0].id);
  assert.equal(fake.calls.submit.length, 1);
  assert.equal(fake.calls.download.length, 0);
});

test('permanently missing provider video stops querying, retains its id and releases the serial queue without resubmission', async t => {
  let rejectQuery;
  const fake = provider({ onSubmit: data => data.type === 'video' ? { providerTaskId: 'expired-original-video' } : { resultBase64: png.toString('base64') },
    onQuery: () => new Promise((_resolve, reject) => { rejectQuery = reject; }) });
  const { service, input } = fixture(t, fake);
  const first = await service.media.create(input({ outputType: 'video' }));
  await until(service, first.task.id, value => value.job.status === 'processing' && fake.calls.query.length === 1);
  const second = await service.media.create(input());
  assert.equal(service.media.get(second.task.id).job.status, 'queued');
  rejectQuery(Object.assign(new Error('原服务任务已过期'), { code: 'provider_task_expired' }));
  const stopped = await until(service, first.task.id, value => value.job.status === 'failed');
  assert.equal(stopped.job.providerTaskId, 'expired-original-video');
  assert.match(stopped.job.error, /不会自动重新生成/);
  assert.equal(stopped.job.canResume, false);
  await until(service, second.task.id);
  service.media.resume(first.task.id);
  assert.equal(fake.calls.submit.length, 2);
  assert.equal(fake.calls.query.length, 1);
});


test('API providers are explicit, do not expose private capabilities, and can append to a Skill card', async t => {
  const api = provider({ label: '合成 API', capabilities: async () => ({ endpoint: 'https://api.example.test', healthy: true, credentialConfigured: true,
    apiKey: 'do-not-expose', modelDefaults: { image: { model: 'synthetic-image', ratio: '4:3', resolution: '2k', secret: 'do-not-expose' } },
    models: [{ id: 'synthetic-image', type: 'image', maxReferences: 10, requiresReference: false, ratios: ['4:3'], resolutions: ['2k'], secret: 'do-not-expose' }] }) });
  const { service, input, root, requirement, fake } = fixture(t, undefined, { mediaApiProviders: { synthetic: api } });
  const caps = await service.media.apiCapabilities();
  assert.equal(caps.providers.length, 1);
  assert.equal(caps.providers[0].id, 'synthetic');
  assert.ok(!JSON.stringify(caps).includes('do-not-expose'));
  const first = service.createTask(input({ selectedSkills: [], generation: { mode: 'new' } }));
  const relative = `${first.prepared.deliveryDirectory}/skill.png`;
  writeFileSync(path.join(root, relative), png);
  service.tasks.bindSession({ taskId: first.task.id, sessionId: 'skill-session' });
  const file = await service.tasks.files.register({ taskId: first.task.id, operationId: randomUUID(), path: relative, kind: 'image', title: 'Skill 图片' }, { sessionId: 'skill-session' });
  const descriptor = service.cards.describe({ requirementId: requirement.id, cardId: first.task.outputCardId });
  const args = input({ generationMethod: 'api', providerId: 'synthetic', generation: { mode: 'revise', cardId: descriptor.card.id, baseVersionId: descriptor.version.id } });
  const created = await service.media.create(args);
  await until(service, created.task.id);
  assert.equal(api.calls.submit.length, 1);
  assert.equal(fake.calls.submit.length, 0);
  assert.equal(created.task.input.providerId, 'synthetic');
  assert.equal(created.task.input.generationMethod, 'api');
  assert.equal(service.cards.describe({ requirementId: requirement.id, cardId: descriptor.card.id }).card.versions.length, 2);
  assert.equal(sha(readFileSync(path.join(root, file.path))), file.hash);
  assert.equal((await service.media.create(args)).task.id, created.task.id);
  assert.equal(api.calls.submit.length, 1);
  await assert.rejects(service.media.create(input({ generationMethod: 'api', providerId: 'missing' })), /尚未接入/);
  await assert.rejects(service.media.create(input({ generationMethod: 'api', providerId: 'synthetic', instruction: '/custom-skill 不执行' })), /不执行 Skill/);
});

test('empty API registry never detects or submits through the legacy provider', async t => {
  const fake = provider({ capabilities() { assert.fail('legacy capabilities must not run'); } });
  const { service, input } = fixture(t, fake);
  assert.deepEqual((await service.media.apiCapabilities()).providers, []);
  await assert.rejects(service.media.create(input({ generationMethod: 'api', providerId: 'missing' })), /尚未接入/);
  assert.equal(fake.calls.submit.length, 0);
});


test('API recovery retains its provider across restart and missing adapters never query legacy', async t => {
  let queryCount = 0;
  const api = provider({ onSubmit: () => ({ providerTaskId: 'frozen-api-task' }), onQuery: () => { queryCount++; return new Promise(() => {}); } });
  const { service, input, root } = fixture(t, undefined, { mediaApiProviders: { synthetic: api } });
  const created = await service.media.create(input({ generationMethod: 'api', providerId: 'synthetic' }));
  await until(service, created.task.id, value => value.job.status === 'processing' && queryCount > 0);
  service.close();
  const legacy = provider({ capabilities() { assert.fail('recovery cannot detect legacy'); }, query() { assert.fail('recovery cannot query legacy'); } });
  const reopened = new WorkbenchService({ workspaceRoot: root, mediaProvider: legacy, mediaPollIntervalMs: 5 });
  try {
    const failed = await until(reopened, created.task.id, value => value.job.errorCode === 'provider_unavailable');
    assert.equal(failed.job.providerTaskId, 'frozen-api-task');
    assert.equal(failed.task.input.providerId, 'synthetic');
    assert.equal(api.calls.submit.length, 1);
  } finally { reopened.close(); }
  api.onQuery = () => ({ status: 'succeeded', resultURL: 'https://media.example.test/result.png' });
  const restored = new WorkbenchService({ workspaceRoot: root, mediaProvider: legacy, mediaApiProviders: { synthetic: api }, mediaPollIntervalMs: 5 });
  try {
    const completed = await until(restored, created.task.id);
    assert.equal(completed.job.status, 'succeeded');
    assert.equal(api.calls.submit.length, 1);
    assert.ok(api.calls.query.every(id => id === 'frozen-api-task'));
  } finally { restored.close(); }
});
