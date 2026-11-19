import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, renameSync, symlinkSync, statSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'wtt-batch-')));
  const service = new WorkbenchService({ workspaceRoot: root });
  t.after(() => { service.close(); rmSync(root, { recursive: true, force: true }); });
  const requirement = service.store.createRequirement({ title: '批量登记技术项目', operationId: randomUUID() });
  const created = service.createTask({ requirementId: requirement.id, outputType: 'text', instruction: '真实文件，非 AI 生成',
    selectedCardIds: [], generation: { mode: 'new' }, operationId: randomUUID() });
  const taskId = created.task.id, sessionId = 'batch-session';
  service.tasks.bindSession({ taskId, sessionId });
  const file = (name, content = '# 内容\n\n保留实际字节', extra = {}) => {
    const relative = `${created.prepared.deliveryDirectory}/${name}`;
    writeFileSync(path.join(root, relative), content);
    return { kind: 'text', title: name, path: relative, operationId: randomUUID(), ...extra };
  };
  const batch = (files, options = {}) => service.tasks.files.registerBatch({ taskId, files }, { sessionId, ...options });
  return { root, service, requirement, created, taskId, sessionId, file, batch };
}

test('one image container expands to seven real image cards, retaining successes and supporting isolated revision and replay', async t => {
  const { root, service, requirement } = fixture(t);
  const made = service.createTask({ requirementId: requirement.id, outputType: 'image', instruction: '制作七张独立图片',
    selectedCardIds: [`requirement:${requirement.id}`], generation: { mode: 'new' }, operationId: randomUUID() });
  const taskId = made.task.id, sessionId = 'seven-images';
  service.tasks.bindSession({ taskId, sessionId });
  assert.equal(made.task.input.outputPresentation, 'cards', 'new media defaults must not depend on a selectedSkills field');
  assert.match(made.prepared.prompt, /交付7张图就登记7个 image/);
  const png = spawnSync('python3', ['-c', 'import io,sys;from PIL import Image;b=io.BytesIO();Image.new("RGB",(12,8),(25,100,170)).save(b,format="PNG");sys.stdout.buffer.write(b.getvalue())']);
  assert.equal(png.status, 0, png.stderr.toString());
  const files = Array.from({ length: 7 }, (_, index) => {
    const relative = `${made.prepared.deliveryDirectory}/图${index + 1}.png`;
    writeFileSync(path.join(root, relative), png.stdout);
    return { kind: 'image', title: `独立图片 ${index + 1}`, path: relative, operationId: randomUUID(), ...(index === 0 ? { primary: true } : {}) };
  });
  const batch = files => service.tasks.files.registerBatch({ taskId, files }, { sessionId });
  const cards = () => service.canvas.getBoard(requirement.id).nodes.filter(node => node.taskId === taskId && node.outputCard);
  const first = await batch(files.slice(0, 1));
  assert.equal(first.succeeded, 1); assert.equal(cards().length, 1);
  assert.equal(cards()[0].outputCard.id, made.task.outputCardId);
  const mainVersion = service.tasks.get(taskId).cardVersionId;
  writeFileSync(path.join(root, files[3].path), 'not a real PNG');
  const partial = await batch(files.slice(1));
  assert.equal(partial.succeeded, 5); assert.equal(partial.failed, 1);
  assert.equal(cards().length, 6, 'a failed file must not create a fake successful card');
  assert.equal(service.tasks.get(taskId).cardVersionId, mainVersion);
  writeFileSync(path.join(root, files[3].path), png.stdout);
  assert.equal((await batch([files[3]])).succeeded, 1);
  const seven = cards(); assert.equal(seven.length, 7);
  assert(seven.every(node=>node.width===640&&node.height===512));
  assert(seven.every(node => node.artifactKind === 'image' && node.generatedFile.media.validated && node.outputCard.versions.length === 1));
  assert.equal(new Set(seven.map(node => node.outputCard.id)).size, 7);
  assert.equal(new Set(seven.map(node => JSON.stringify(node.position))).size, 7);
  assert(seven.every(node => service.canvas.getBoard(requirement.id).edges.some(edge => edge.target === node.id)));
  const allNodes = service.canvas.getBoard(requirement.id).nodes;
  for (const node of seven) for (const other of allNodes) if (node.id !== other.id) {
    assert(!(node.position.x < other.position.x + (other.width || 320) && node.position.x + (node.width || 320) > other.position.x
      && node.position.y < other.position.y + (other.height || 256) && node.position.y + (node.height || 256) > other.position.y), 'new output cannot overlap any current card');
  }
  const fixedPositions = new Map(seven.map(node => [node.id, node.position]));
  const artifactIds = service.tasks.get(taskId).files.map(file => file.id).sort();
  assert.equal((await batch(files)).succeeded, 7);
  assert.deepEqual(service.tasks.get(taskId).files.map(file => file.id).sort(), artifactIds);
  assert.equal(cards().length, 7);
  const reportPath = `${made.prepared.deliveryDirectory}/报告.md`; writeFileSync(path.join(root, reportPath), '# 校验报告');
  assert.equal((await batch([{ kind: 'support', title: '报告附件', path: reportPath, operationId: randomUUID(), presentation: 'attachment' }])).succeeded, 1);
  assert.equal(cards().length, 7, 'an explicit attachment must not become an eighth card');
  const child = seven.find(node => node.outputCard.id !== made.task.outputCardId);
  assert.equal(service.outcomes.manifest({ requirementId: requirement.id, cardId: child.outputCard.id }).files.length, 1);
  const revision = service.createTask({ requirementId: requirement.id, outputType: 'image', instruction: '只修改这一张图', selectedCardIds: [], selectedSkills: [],
    generation: { mode: 'revise', cardId: child.outputCard.id, baseVersionId: child.outputCard.versionId }, operationId: randomUUID() });
  service.tasks.bindSession({ taskId: revision.task.id, sessionId: 'revise-one-image' });
  const revisionPath = `${revision.prepared.deliveryDirectory}/修改.png`; writeFileSync(path.join(root, revisionPath), png.stdout);
  await service.tasks.files.register({ taskId: revision.task.id, kind: 'image', title: '只修改这一张图', path: revisionPath, operationId: randomUUID(), primary: true }, { sessionId: 'revise-one-image' });
  const allImages = service.canvas.getBoard(requirement.id).nodes.filter(node => node.outputCard?.type === 'image');
  assert.equal(allImages.length, 7);
  assert.equal(allImages.find(node => node.outputCard.id === child.outputCard.id).outputCard.versions.length, 2);
  assert(allImages.filter(node => node.outputCard.id !== child.outputCard.id).every(node => node.outputCard.versions.length === 1));
  service.close();
  const reopened = new WorkbenchService({ workspaceRoot: root });
  try {
    assert.equal(reopened.canvas.getBoard(requirement.id).nodes.filter(node => node.outputCard?.type === 'image').length, 7);
    for (const node of reopened.canvas.getBoard(requirement.id).nodes.filter(node => fixedPositions.has(node.id))) assert.deepEqual(node.position, fixedPositions.get(node.id));
    assert.equal((await reopened.tasks.files.registerBatch({ taskId, files }, { sessionId })).succeeded, 7);
    assert.equal(reopened.canvas.getBoard(requirement.id).nodes.filter(node => node.outputCard?.type === 'image').length, 7);
  } finally { reopened.close(); }
});

test('new media defaults do not rewrite the frozen attachment mode of an existing image task', async t => {
  const { root, service, requirement } = fixture(t);
  const made = service.createTask({ requirementId: requirement.id, outputType: 'image', instruction: '历史图片任务',
    selectedCardIds: [], generation: { mode: 'new' }, operationId: randomUUID() });
  const frozen = { ...made.task.input }; delete frozen.outputPresentation;
  service.store.db.prepare('UPDATE course_tasks SET input_json=? WHERE id=?').run(JSON.stringify(frozen), made.task.id);
  service.tasks.bindSession({ taskId: made.task.id, sessionId: 'legacy-images' });
  const bytes = spawnSync('python3', ['-c', 'import io,sys;from PIL import Image;b=io.BytesIO();Image.new("RGB",(3,2)).save(b,format="PNG");sys.stdout.buffer.write(b.getvalue())']);
  assert.equal(bytes.status, 0, bytes.stderr.toString());
  const files = [1, 2].map(index => {
    const relative = `${made.prepared.deliveryDirectory}/旧图${index}.png`; writeFileSync(path.join(root, relative), bytes.stdout);
    return { kind: 'image', title: `旧图${index}`, path: relative, operationId: randomUUID() };
  });
  assert.equal((await service.tasks.files.registerBatch({ taskId: made.task.id, files }, { sessionId: 'legacy-images' })).succeeded, 2);
  assert.equal(service.tasks.get(made.task.id).input.outputPresentation, undefined);
  const cards = service.canvas.getBoard(requirement.id).nodes.filter(node => node.taskId === made.task.id && node.outputCard);
  assert.equal(cards.length, 1); assert.equal(cards[0].outputCard.versions[0].outputs.length, 2);
});

test('a misregistered video can publish the original file to the original card once', async t => {
  const { root, service, requirement } = fixture(t);
  const { task, prepared } = service.createTask({ requirementId: requirement.id, outputType: 'video', instruction: '交付一支主视频',
    selectedCardIds: [], generation: { mode: 'new' }, operationId: randomUUID() });
  const taskId = task.id, sessionId = 'video-registration';
  service.tasks.bindSession({ taskId, sessionId });
  assert.match(prepared.prompt, /cardOutput.role=primary/);

  const video = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:d=0.25',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
  assert.equal(video.status, 0, video.stderr?.toString() || String(video.error || ''));
  const makeFile = title => {
    const relative = path.posix.join(prepared.deliveryDirectory, title + '.mp4');
    writeFileSync(path.join(root, relative), video.stdout);
    return { path: relative, title, kind: 'video', presentation: 'attachment', operationId: randomUUID() };
  };
  const main = makeFile('主视频'), other = makeFile('补充视频');
  const register = (input, session = sessionId) => service.tasks.files.register({ ...input, taskId }, { sessionId: session });
  const batch = files => service.tasks.files.registerBatch({ taskId, files }, { sessionId });
  const { results: [original, supplement], succeeded } = await batch([main, other]);
  assert.equal(succeeded, 2);
  assert.equal(original.cardOutput.cardId, task.outputCardId);
  assert.equal(original.cardOutput.role, 'attachment');
  assert.equal(original.cardOutput.versionId, null);
  assert.match(original.cardOutput.warning, /primary=true/);
  assert.equal(service.tasks.get(taskId).cardVersionId, undefined);

  const primary = { path: main.path, title: main.title, kind: 'video', primary: true, operationId: randomUUID() };
  await assert.rejects(register({ ...primary, operationId: main.operationId }), /操作标识已用于不同内容/);
  await assert.rejects(register(primary, 'unbound-video-session'), /会话/);
  await assert.rejects(register({ ...primary, title: '另一个标题' }), /原登记标题/);
  await assert.rejects(register({ ...main, operationId: randomUUID() }), /路径已登记/);

  const mainPath = path.join(root, main.path);
  const preview = options => service.tasks.files.videoPreviewResponse(original.id, options);
  const detail=options=>service.outcomes.preview({requirementId:requirement.id,sourceRef:'artifact:'+original.id,hash:original.hash,...options});
  const originalRead=service.tasks.files.read,originalWrite=service.documents.write;
  try{
    service.tasks.files.read=()=>{throw new Error('video detail must not read all bytes')};
    service.documents.write=()=>{throw new Error('video detail must not write a full snapshot')};
    assert.equal(detail().path,original.path);
    assert.equal(detail().originalPath,original.path);
    assert.equal(detail().mime,'video/mp4');
    assert.throws(()=>detail({requirementId:randomUUID()}),/不属于当前画布/);
    assert.throws(()=>detail({hash:'0'.repeat(64)}),/版本已变化/);
  }finally{
    service.tasks.files.read=originalRead;
    service.documents.write=originalWrite;
  }
  const response = await preview({ range: 'bytes=32-79' });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 32-79/${video.stdout.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.stdout.subarray(32, 80));
  const tail = await preview({ range: 'bytes=-48' });
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), video.stdout.subarray(-48));
  const head = await preview({ method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(video.stdout.length));
  assert.equal(head.body, null);
  assert.equal((await preview({ range: `bytes=${video.stdout.length}-` })).status, 416);
  const abort = new AbortController();
  const interrupted = await preview({ range: 'bytes=0-', signal: abort.signal });
  abort.abort();
  await assert.rejects(interrupted.arrayBuffer(), { name: 'AbortError' });
  const old = statSync(mainPath), modified = Buffer.from(video.stdout);
  modified[32] ^= 0xff;
  writeFileSync(mainPath, modified);
  utimesSync(mainPath, old.atime, old.mtime);
  assert.throws(()=>detail(),/外改/);
  await assert.rejects(preview({ range: 'bytes=32-79' }), /已被外部修改/);
  writeFileSync(mainPath, video.stdout);
  const pending = await preview({ range: 'bytes=32-79' });
  renameSync(mainPath, mainPath + '.old');
  symlinkSync(mainPath + '.old', mainPath);
  await assert.rejects(pending.arrayBuffer(), /符号链接|已被外部修改/);
  rmSync(mainPath);
  renameSync(mainPath + '.old', mainPath);
  writeFileSync(mainPath, Buffer.concat([video.stdout, Buffer.from('changed')]));
  await assert.rejects(register(primary), /已变化/);
  assert.equal(service.tasks.get(taskId).cardVersionId, undefined);
  writeFileSync(mainPath, video.stdout);

  const { results: [published] } = await batch([primary]);
  assert.equal(published.ok, true, published.error);
  assert.equal(published.id, original.id);
  assert.equal(published.hash, original.hash);
  assert.equal(published.path, original.path);
  assert.deepEqual(readFileSync(mainPath), video.stdout);
  const updated = service.tasks.get(taskId);
  assert.equal(updated.files.length, 2);
  assert.deepEqual(published.cardOutput, { cardId: task.outputCardId, versionId: updated.cardVersionId, role: 'primary' });
  const cards = service.canvas.getBoard(requirement.id).nodes.filter(node => node.taskId === taskId && node.outputCard);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, `output:${task.outputCardId}`);
  const ref = { cardId: `artifact:${original.id}`, hash: original.hash };
  assert.equal(cards[0].sourceId, ref.cardId);
  assert.equal(cards[0].outputCard.versions.length, 1);
  assert.equal(cards[0].outputCard.versions[0].number, 1);
  assert.equal(service.canvas.validateSourceRefs(requirement.id, [ref])[0].hash, original.hash);
  for (const request of [primary, main]) {
    const replay = await register(request);
    assert.equal(replay.id, original.id);
    assert.deepEqual(replay.cardOutput, published.cardOutput);
  }
  const otherReplay = await register(other);
  assert.equal(otherReplay.id, supplement.id);
  assert.deepEqual(otherReplay.cardOutput, { ...published.cardOutput, role: 'attachment' });
  await assert.rejects(register({ ...primary, path: other.path, title: other.title, operationId: randomUUID() }), /已经有正式视频版本/);
  assert.equal(service.canvas.getBoard(requirement.id).nodes.find(node => node.id === cards[0].id).outputCard.versions.length, 1);
});

test('20 real files batch once, mirror once, return compact results and preserve one card version on replay/restart', async t => {
  const { root, service, requirement, taskId, file, batch } = fixture(t);
  const files = Array.from({ length: 20 }, (_, i) => file(`${i + 1}.md`, `# 第${i + 1}项`, { primary: i === 0 }));
  const sync = service.deliverables.sync.bind(service.deliverables);
  let calls = 0;
  service.deliverables.sync = (...args) => { calls++; return sync(...args); };
  const result = await batch(files);
  assert.equal(result.ok, true); assert.equal(result.succeeded, 20); assert.equal(calls, 1);
  assert.equal(service.tasks.get(taskId).files.length, 20);
  assert.equal(result.results[0].validation, undefined);
  for (const entry of result.results) {
    assert.equal(entry.delivery.status, 'ready');
    assert.equal(createHash('sha256').update(readFileSync(path.join(root, entry.delivery.path))).digest('hex'), entry.hash);
  }
  const board = service.canvas.getBoard(requirement.id), output = board.nodes.find(n => n.outputCard);
  assert.equal(output.outputCard.versions.length, 1);
  assert.equal(output.outputCard.versions[0].outputs.length, 20);
  const replay = await batch(files);
  assert.deepEqual(replay.results.map(x => x.id), result.results.map(x => x.id));
  assert.equal(service.tasks.get(taskId).files.length, 20);
  service.close();
  const restarted = new WorkbenchService({ workspaceRoot: root });
  try { assert.equal(restarted.tasks.get(taskId).files.length, 20); assert.equal(restarted.canvas.getBoard(requirement.id).nodes.find(n => n.outputCard).outputCard.versions.length, 1); }
  finally { restarted.close(); }
});

test('mixed success reports exact failures, preserves successes and retries only repaired items', async t => {
  const { root, service, taskId, file, batch } = fixture(t);
  const good = file('主文件.md', '# 主文件', { primary: true });
  const empty = file('空文件.md', '', { primary: false });
  const other = file('其他.md', '# 不应登记', { taskId: randomUUID() });
  const escape = { ...file('越界.md'), path: 'outside.md' };
  const first = await batch([good, empty, other, escape]);
  assert.equal(first.ok, false); assert.equal(first.succeeded, 1); assert.equal(first.failed, 3);
  assert.match(first.results[1].error, /非空/);
  assert.match(first.results[2].error, /同一个任务/);
  assert.match(first.results[3].error, /本任务/);
  assert.equal(service.tasks.get(taskId).files.length, 1);
  writeFileSync(path.join(root, empty.path), '# 已修复');
  const retry = await batch([empty]);
  assert.equal(retry.ok, true); assert.equal(service.tasks.get(taskId).files.length, 2);
  writeFileSync(path.join(root, good.path), '# 外改');
  const changed = await batch([good]);
  assert.equal(changed.ok, false); assert.equal(changed.results[0].status, 'changed');
  assert.equal(service.tasks.get(taskId).files.length, 2);
});

test('batch enforces session, size and specialized workflow gates without writing successful artifacts', async t => {
  const { service, taskId, file, batch } = fixture(t);
  const input = file('文件.md');
  await assert.rejects(batch([input], { sessionId: 'foreign' }), /当前会话/);
  await assert.rejects(batch([]), /1–100/);
  await assert.rejects(batch(Array(101).fill(input)), /1–100/);
  const media = await batch([{ ...input, kind: 'image' }]);
  assert.match(media.results[0].error, /媒体/);
  for (const snapshot of [{ outputType: 'pptx', pptEngine: 'baoyu' }, { outputType: 'pptx', workflow: 'ppt-edit' }]) {
    service.store.db.prepare('UPDATE course_tasks SET input_json=? WHERE id=?').run(JSON.stringify(snapshot), taskId);
    const forbidden = await batch([{ ...input, kind: 'pptx' }]);
    assert.equal(forbidden.succeeded, 0);
    assert.match(forbidden.results[0].error, /右栏|待确认/);
  }
  assert.equal(service.tasks.get(taskId).files.length, 0);
});

test('cancellation retains completed item and marks every unexecuted item, with no new registrations on pre-abort', async t => {
  const { service, file, batch, taskId } = fixture(t);
  const controller = new AbortController(), files = [file('1.md'), file('2.md'), file('3.md')];
  const register = service.tasks.files.register.bind(service.tasks.files);
  service.tasks.files.register = async (...args) => { const result = await register(...args); controller.abort(); return result; };
  const result = await batch(files, { signal: controller.signal });
  assert.equal(result.succeeded, 1); assert.equal(result.results[1].skipped, true); assert.equal(result.results[2].skipped, true);
  assert.equal(service.tasks.get(taskId).files.length, 1);
  const aborted = await batch([file('4.md')], { signal: controller.signal });
  assert.equal(aborted.succeeded, 0); assert.equal(service.tasks.get(taskId).files.length, 1);
});

test('mirror failure does not erase successful registration or pretend directory copy succeeded', async t => {
  const { service, file, batch, taskId } = fixture(t);
  service.deliverables.sync = () => { throw new Error('技术夹具：目录只读'); };
  const result = await batch([file('成功登记.md')]);
  assert.equal(result.ok, false); assert.equal(result.succeeded, 1);
  assert.match(result.syncError, /目录只读/);
  assert.equal(service.tasks.get(taskId).files.length, 1);
});
