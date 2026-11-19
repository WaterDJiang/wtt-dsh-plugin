export const mediaChunkBytes = 1024 * 1024

export function importedFileResponse(file, { method = 'GET', range, preview = false, headers = {} } = {}) {
  const size = file.bytes?.byteLength ?? file.size
  const body = (start, end) => file.bytes ? file.bytes.slice(start, end + 1) : file.stream(start, end)
  const media = /^(?:image\/(?:png|jpeg|gif|webp)|video\/(?:mp4|webm))$/.test(file.mime)
  if (preview && !media) throw new Error('此文件格式不支持预览')
  const responseHeaders = { ...headers, 'Content-Type': file.mime,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Content-Length': String(size), ...(preview ? { 'Accept-Ranges': 'bytes' } : {}) }
  if (method === 'HEAD') return new Response(null, { headers: responseHeaders })
  if (!preview || !range) return new Response(body(0, size - 1), { headers: responseHeaders })
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  let start, end
  if (match && (match[1] || match[2])) {
    if (!match[1]) { start = Math.max(0, size - Number(match[2])); end = size - 1 }
    else { start = Number(match[1]); end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1 }
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return new Response(null, { status: 416, headers: { ...responseHeaders, 'Content-Length': '0', 'Content-Range': `bytes */${size}` } })
  }
  return new Response(body(start, end), { status: 206,
    headers: { ...responseHeaders, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } })
}

// Own the open file until the response finishes, is cancelled, or has no body.
export async function streamedMediaResponse(file, { handle, assertCurrent, changed, signal, ...options }) {
  let handedOff = false
  try {
    return importedFileResponse({
      ...file,
      stream(start, end) {
        let position = start, closed = false, abort;
        const close = () => {
          if (closed) return;
          closed = true;
          signal?.removeEventListener('abort', abort);
          return handle.close();
        };
        const stream = new ReadableStream({
          start(controller) {
            abort = () => {
              if (closed) return;
              controller.error(signal.reason);
              void close()?.catch(() => {});
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener('abort', abort, { once: true });
          },
          async pull(controller) {
            try {
              await assertCurrent();
              const chunk = Buffer.allocUnsafe(Math.min(end - position + 1, mediaChunkBytes));
              const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
              if (closed) return;
              if (!bytesRead) throw changed();
              await assertCurrent();
              if (closed) return;
              position += bytesRead;
              controller.enqueue(chunk.subarray(0, bytesRead));
              if (position > end) {
                controller.close();
                await close();
              }
            } catch (cause) {
              if (!closed) controller.error(cause);
              await close();
            }
          },
          cancel: close,
        }, { highWaterMark: 0 });
        handedOff = true;
        return stream;
      },
    }, options)
  } finally {
    if (!handedOff) await handle.close()
  }
}
