import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importedFileResponse } from '../src/media-response.mjs';

const file = { name: '课件视频.mp4', mime: 'video/mp4', bytes: Buffer.from('0123456789') };
test('a video player can request byte ranges and suffixes without changing the original download', async () => {
  const first = importedFileResponse(file, { preview: true, range: 'bytes=2-5' });
  assert.equal(first.status, 206);
  assert.equal(first.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(first.headers.get('content-length'), '4');
  assert.equal(await first.text(), '2345');
  assert.equal(await importedFileResponse(file, { preview: true, range: 'bytes=-3' }).text(), '789');
  assert.equal(await importedFileResponse(file, { preview: true, range: 'bytes=8-' }).text(), '89');
  const download = importedFileResponse(file, { range: 'bytes=2-5' });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /^attachment/);
  assert.equal(await download.text(), '0123456789');
});
test('unsatisfiable or multiple ranges are rejected and HEAD carries no media body', async () => {
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-5', 'not-a-range']) {
    const response = importedFileResponse(file, { preview: true, range });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
    assert.equal(await response.text(), '');
  }
  const head = importedFileResponse(file, { preview: true, method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(await head.text(), '');
  assert.throws(() => importedFileResponse({ ...file, mime: 'text/html' }, { preview: true }), /不支持预览/);
});

test('model markup downloads stay attachments and cannot become host-origin previews', async () => {
  for (const mime of ['image/svg+xml', 'text/html; charset=utf-8']) {
    const model = { name: mime.startsWith('image') ? '模型.svg' : '模型.html', mime, bytes: Buffer.from('<html><body>model</body></html>') };
    assert.throws(() => importedFileResponse(model, { preview: true }), /不支持预览/);
    const response = importedFileResponse(model);
    assert.match(response.headers.get('content-disposition'), /^attachment/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'; sandbox/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), model.bytes);
  }
});
