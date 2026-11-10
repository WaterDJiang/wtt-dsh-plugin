import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';

export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;
export const IMPORT_TEXT_BYTES = 1_048_576;
const TYPES = {
  ...Object.fromEntries(['.markdown','.yaml','.yml','.html','.css','.js','.mjs','.py','.xml','.log'].map(ext=>[ext,'text/plain'])),
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.jsonl': 'application/x-ndjson',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const TEXT = new Set(['.markdown','.yaml','.yml','.html','.css','.js','.mjs','.py','.xml','.log','.txt', '.md', '.csv', '.json', '.jsonl']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const supportsMaterialImport = filename => Object.hasOwn(TYPES, path.extname(filename).toLowerCase());

export function inspectMaterialImport({ filename, bytes }) {
  if (typeof filename !== 'string' || !filename.trim() || /[\/\\\u0000-\u001f\u007f]/.test(filename)
    || filename === '.' || filename === '..' || Buffer.byteLength(filename) > 240) throw new Error('导入文件名无效或过长，不能包含目录或控制字符');
  if (!(bytes instanceof Uint8Array)) throw new Error('请上传真实文件字节');
  if (bytes.byteLength > IMPORT_MAX_BYTES) throw Object.assign(new Error('单个导入文件不能超过 20 MB'), { status: 413 });
  const extension = path.extname(filename).toLowerCase();
  if (!TYPES[extension] || !path.basename(filename, path.extname(filename)).trim()) throw new Error('不支持此文件格式；可导入 TXT、MD、CSV、JSON、JSONL、PDF、DOCX、PPTX、PNG/JPG/WebP/GIF 或 MP4/WebM');
  if (!bytes.byteLength && /^(image|video)\//.test(TYPES[extension])) throw new Error('图片或视频文件不能为空');
  const safeName = filename.normalize('NFC').replace(/[<>:"|?*]/g, '_');
  return { name: filename, safeName, extension, byteSize: bytes.byteLength, hash: hash(bytes), mime: TYPES[extension] };
}

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function mp4Container(bytes) {
  let offset = 0;
  for (let count = 0; count < 128 && offset + 8 <= bytes.length; count += 1) {
    let size = bytes.readUInt32BE(offset), header = 8;
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (size === 1) {
      if (offset + 16 > bytes.length) return false;
      const extended = bytes.readBigUInt64BE(offset + 8);
      if (extended > BigInt(bytes.length)) return false;
      size = Number(extended); header = 16;
    }
    if (size < header || offset + size > bytes.length) return false;
    if (type === 'ftyp') {
      if (size < header + 8) return false;
      const major = bytes.subarray(offset + header, offset + header + 4).toString('ascii');
      const brands = [major];
      for (let at = offset + header + 8; at + 4 <= offset + size; at += 4) brands.push(bytes.subarray(at, at + 4).toString('ascii'));
      return major !== 'qt  ' && brands.some(brand => /^(isom|iso[a-z0-9]|mp41|mp42|avc1|av01|M4V |MSNV|dash)$/i.test(brand));
    }
    offset += size;
  }
  return false;
}

function webmContainer(bytes) {
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return false;
  const vint = offset => {
    const first = bytes[offset];
    if (!first) return null;
    let length = 1, marker = 128;
    while (!(first & marker) && length <= 8) { length += 1; marker >>= 1; }
    if (length > 8 || offset + length > bytes.length) return null;
    let value = first & (marker - 1);
    for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index];
    return Number.isSafeInteger(value) ? { value, length } : null;
  };
  const header = vint(4);
  if (!header || header.value > 4096 || 4 + header.length + header.value > bytes.length) return false;
  const end = 4 + header.length + header.value;
  let offset = 4 + header.length;
  while (offset < end) {
    const first = bytes[offset];
    let idLength = 1, marker = 128;
    while (first && !(first & marker) && idLength <= 4) { idLength += 1; marker >>= 1; }
    if (!first || idLength > 4 || offset + idLength > end) return false;
    const docType = idLength === 2 && first === 0x42 && bytes[offset + 1] === 0x82;
    const size = vint(offset + idLength);
    if (!size) return false;
    const start = offset + idLength + size.length;
    if (start + size.value > end) return false;
    if (docType) return bytes.subarray(start, start + size.value).toString('ascii') === 'webm';
    offset = start + size.value;
  }
  return false;
}

function probeMedia(file, extension, { ffprobe, signal }) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm',
      ...(extension === '.mp4' ? ['-enable_drefs', '0'] : []),
      '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height,pix_fmt:stream_disposition=attached_pic', '-of', 'json', '-i', file];
    const child = spawn(ffprobe, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, 10_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 131072) { exceeded = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', chunk => { if (errors.length < 2048) errors += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || exceeded) { reject(new Error(exceeded ? '视频格式验证超时或超出检查限制' : errors.trim().slice(0, 300) || '视频格式验证失败')); return; }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('ffprobe 未返回有效的媒体信息')); }
    });
  });
}

async function inspectVideo(bytes, metadata, { ffprobe = 'ffprobe', signal } = {}) {
  let temporary;
  try {
    const buffer = Buffer.from(bytes);
    if (!(metadata.extension === '.mp4' ? mp4Container(buffer) : webmContainer(buffer))) throw new Error('真实容器与文件扩展名不符或视频文件损坏');
    temporary = mkdtempSync(path.join(os.tmpdir(), 'wtt-media-probe-'));
    const file = path.join(temporary, `source${metadata.extension}`);
    writeFileSync(file, buffer, { flag: 'wx', mode: 0o600 });
    const report = await probeMedia(file, metadata.extension, { ffprobe, signal });
    signal?.throwIfAborted();
    const streams = Array.isArray(report.streams) ? report.streams : [];
    const video = streams.find(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1
      && Number.isFinite(stream.width) && stream.width > 0 && Number.isFinite(stream.height) && stream.height > 0);
    const audio = streams.find(stream => stream.codec_type === 'audio');
    if (!video || !report.format?.format_name?.includes(metadata.extension === '.mp4' ? 'mp4' : 'webm')) throw new Error('文件未包含有效的视频流或容器不匹配');
    const browserCompatible = metadata.extension === '.mp4'
      ? video.codec_name === 'h264' && video.pix_fmt === 'yuv420p' && (!audio || audio.codec_name === 'aac')
      : ['vp8', 'vp9'].includes(video.codec_name) && video.pix_fmt === 'yuv420p' && (!audio || ['opus', 'vorbis'].includes(audio.codec_name));
    const duration = Number(report.format.duration);
    const media = { kind: 'video', validated: true, container: metadata.extension.slice(1), videoCodec: video.codec_name,
      ...(audio ? { audioCodec: audio.codec_name } : {}), width: video.width, height: video.height,
      ...(Number.isFinite(duration) && duration >= 0 ? { durationSeconds: duration } : {}), browserCompatible,
      ...(!browserCompatible ? { warning: '视频容器与视频流已核对；此编码的浏览器播放兼容性需实际确认，原件可下载。' } : {}) };
    return { content: '', mime: metadata.mime, extractionStatus: 'unparsed', truncated: false, extractionError: '视频已保留，未转写音频或解析画面', media };
  } catch (error) {
    signal?.throwIfAborted();
    const reason = error.code === 'ENOENT' ? '本机 ffprobe 不可用，未完成视频格式验证' : `视频格式验证失败：${error.message}`.slice(0, 350);
    return { content: '', mime: 'application/octet-stream', extractionStatus: 'unparsed', truncated: false,
      extractionError: `${reason}；原件已保留，无法预览。`, media: { kind: 'video', validated: false, warning: reason } };
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}

function boundedText(content) {
  if (!content.trim()) return { content: '', extractionStatus: 'unparsed', truncated: false, extractionError: '未发现可提取正文' };
  if (content.includes('\0')) return { content: '', extractionStatus: 'unparsed', truncated: false, extractionError: '文件包含 NUL 字节，未作为文本解析' };
  const raw = Buffer.from(content, 'utf8');
  let end = Math.min(raw.length, IMPORT_TEXT_BYTES);
  if (end < raw.length) while (end > 0 && (raw[end] & 0xc0) === 0x80) end -= 1;
  return { content: raw.subarray(0, end).toString('utf8'), extractionStatus: 'extracted', truncated: raw.length > IMPORT_TEXT_BYTES };
}

const PYTHON_EXTRACT = String.raw`
import io,json,sys,zipfile
try:
 import resource
 resource.setrlimit(resource.RLIMIT_CPU,(20,20))
except (ImportError,ValueError,OSError): pass
limit=1048576
parts=[]
used=0
truncated=False
def add(text):
 global used,truncated
 if not text or not text.strip(): return True
 raw=(('\n\n' if parts else '')+text).encode('utf-8',errors='replace')
 available=limit-used
 if len(raw)>available:
  parts.append(raw[:available].decode('utf-8',errors='ignore'))
  truncated=True
  return False
 parts.append(raw.decode('utf-8'))
 used+=len(raw)
 return True
try:
 raw=sys.stdin.buffer.read()
 extension=sys.argv[1]
 if extension in ('.docx','.pptx'):
  with zipfile.ZipFile(io.BytesIO(raw)) as archive:
   if sum(item.file_size for item in archive.infolist())>104857600: raise ValueError('压缩文档展开后超过 100 MB，未提取正文')
 if extension=='.pdf':
  from pypdf import PdfReader
  document=PdfReader(io.BytesIO(raw),strict=False)
  if document.is_encrypted: raise ValueError('PDF 已加密，未提取正文')
  for index,page in enumerate(document.pages):
   if index>=2000:
    truncated=True
    break
   text=page.extract_text() or ''
   if text.strip() and not add('[第 '+str(index+1)+' 页]\n'+text): break
 elif extension=='.docx':
  from docx import Document
  document=Document(io.BytesIO(raw))
  for paragraph in document.paragraphs:
   if not add(paragraph.text): break
  if not truncated:
   for table in document.tables:
    for row in table.rows:
     if not add('\t'.join(cell.text for cell in row.cells)): break
    if truncated: break
 elif extension=='.pptx':
  from pptx import Presentation
  document=Presentation(io.BytesIO(raw))
  def texts(shapes):
   for shape in shapes:
    if getattr(shape,'has_text_frame',False): yield shape.text_frame.text
    if getattr(shape,'has_table',False):
     for row in shape.table.rows: yield '\t'.join(cell.text for cell in row.cells)
    if hasattr(shape,'shapes'): yield from texts(shape.shapes)
  for index,slide in enumerate(document.slides):
   values=[text for text in texts(slide.shapes) if text.strip()]
   if values and not add('[第 '+str(index+1)+' 页]\n'+'\n'.join(values)): break
 content=''.join(parts)
 if '\x00' in content: raise ValueError('提取结果包含 NUL 字符')
 print(json.dumps({'content':content,'extractionStatus':'extracted' if content.strip() else 'unparsed','truncated':truncated,**({} if content.strip() else {'extractionError':('已达到页数检查上限，' if truncated else '')+'未发现可提取文字；图片或扫描内容未进行 OCR'})},ensure_ascii=False))
except Exception as error:
 print(json.dumps({'content':'','extractionStatus':'unparsed','truncated':False,'extractionError':str(error)[:300]},ensure_ascii=False))
`;

function runExtractor(bytes, extension, { python, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-c', PYTHON_EXTRACT, extension], { signal, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; let size = 0, errors = '', exceeded = false;
    const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, 30_000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > IMPORT_TEXT_BYTES * 6 + 65536) { exceeded = true; child.kill('SIGKILL'); }
      else output.push(chunk);
    });
    child.stderr.on('data', chunk => { if (errors.length < 2048) errors += chunk.toString(); });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || exceeded) { reject(new Error(exceeded ? '正文提取超时或超过输出限制' : `正文提取器执行失败：${errors.slice(0, 300) || code}`)); return; }
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))); }
      catch { reject(new Error('正文提取器未返回有效结果')); }
    });
    child.stdin.end(bytes);
  });
}

export async function extractMaterialImport(bytes, metadata, { python = 'python3', ffprobe = 'ffprobe', signal } = {}) {
  signal?.throwIfAborted();
  if (metadata.mime.startsWith('image/')) {
    const actual = imageMime(Buffer.from(bytes));
    return { content: '', extractionStatus: 'unparsed', truncated: false,
      mime: actual === metadata.mime ? actual : 'application/octet-stream',
      extractionError: actual === metadata.mime ? '图片已保留，未进行文字识别' : '图片格式与扩展名不符或文件损坏，已保留原件，无法预览',
      media: { kind: 'image', validated: actual === metadata.mime } };
  }
  if (metadata.mime.startsWith('video/')) return inspectVideo(bytes, metadata, { ffprobe, signal });
  if (TEXT.has(metadata.extension)) {
    try { return boundedText(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return { content: '', extractionStatus: 'unparsed', truncated: false, extractionError: '文本不是有效的 UTF-8 编码，已保留原件' }; }
  }
  try {
    const extracted = await runExtractor(bytes, metadata.extension, { python, signal });
    signal?.throwIfAborted();
    if (typeof extracted.content !== 'string' || !['extracted', 'unparsed'].includes(extracted.extractionStatus)) throw new Error('正文提取器返回的字段无效');
    if (extracted.extractionStatus === 'extracted') return { ...boundedText(extracted.content), truncated: Boolean(extracted.truncated) || Buffer.byteLength(extracted.content) > IMPORT_TEXT_BYTES };
    return { content: '', extractionStatus: 'unparsed', truncated: Boolean(extracted.truncated), extractionError: String(extracted.extractionError || '未发现可提取正文').slice(0, 300) };
  } catch (error) {
    signal?.throwIfAborted();
    return { content: '', extractionStatus: 'unparsed', truncated: false, extractionError: `正文提取失败：${error.message}`.slice(0, 300) };
  }
}
