export function importedFileResponse(file, { method = 'GET', range, preview = false, headers = {} } = {}) {
  const size = file.bytes.byteLength
  const media = /^(?:image\/(?:png|jpeg|gif|webp)|video\/(?:mp4|webm))$/.test(file.mime)
  if (preview && !media) throw new Error('此文件格式不支持预览')
  const responseHeaders = { ...headers, 'Content-Type': file.mime,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Content-Length': String(size), ...(preview ? { 'Accept-Ranges': 'bytes' } : {}) }
  if (method === 'HEAD') return new Response(null, { headers: responseHeaders })
  if (!preview || !range) return new Response(file.bytes.slice(), { headers: responseHeaders })
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  let start, end
  if (match && (match[1] || match[2])) {
    if (!match[1]) { start = Math.max(0, size - Number(match[2])); end = size - 1 }
    else { start = Number(match[1]); end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1 }
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return new Response(null, { status: 416, headers: { ...responseHeaders, 'Content-Length': '0', 'Content-Range': `bytes */${size}` } })
  }
  return new Response(file.bytes.slice(start, end + 1), { status: 206,
    headers: { ...responseHeaders, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } })
}
