import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractMaterialImport } from './material-import.mjs';

export const GENERATED_MEDIA_MAX_BYTES = 209_715_200;

const mimeTypes = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.jsonl': 'application/x-ndjson',
  '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const formats = {
  text: ['.md', '.txt', '.docx', '.pdf', '.csv'],
  pptx: ['.pptx'], exercise: ['.pdf', '.csv'], script: ['.md', '.docx', '.pdf'],
  storyboard: ['.md', '.json', '.jsonl'], support: ['.md', '.txt', '.json', '.jsonl', '.pdf', '.csv', '.docx', '.svg', '.html', '.pptx'],
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp'], video: ['.mp4', '.webm'],
};

export function generatedMediaExtension(type, bytes) {
  if (type === 'image') {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return '.jpg';
    if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return '.gif';
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  } else if (type === 'video') {
    if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return '.mp4';
    if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return '.webm';
  }
  throw new Error('生成结果不是真实受支持的图片或视频');
}

const inspectImage = String.raw`
import json,sys,warnings
from PIL import Image
warnings.simplefilter('error',Image.DecompressionBombWarning)
Image.MAX_IMAGE_PIXELS=40000000
with Image.open(sys.argv[1]) as image:
 fmt=image.format.lower(); width,height=image.size
 assert fmt in ('png','jpeg','gif','webp') and width>0 and height>0 and width*height<=40000000,'Unsupported or excessive image dimensions'
 assert '.'+('jpg' if fmt=='jpeg' else fmt)==sys.argv[2] or (fmt=='jpeg' and sys.argv[2]=='.jpeg'),'Image format does not match extension'
 image.verify()
with Image.open(sys.argv[1]) as image: image.load()
print(json.dumps({'kind':'image','validated':True,'format':fmt,'width':width,'height':height,'browserCompatible':True}))
`;

const inspectDocument = String.raw`
import csv,io,json,sys,zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
p=Path(sys.argv[1]); ext=p.suffix.lower()
def package(required):
    with zipfile.ZipFile(p) as z:
        members=z.infolist()
        assert len(members)<=10000 and sum(x.file_size for x in members)<=536870912, 'Office package exceeds validation budget'
        assert all(x.file_size<=52428800 for x in members if x.filename.endswith('.xml')), 'Office XML exceeds validation budget'
        assert z.testzip() is None, 'Office package CRC failed'
        assert all(name in z.namelist() for name in required), 'Office package is incomplete'
        ET.fromstring(z.read('[Content_Types].xml'))
if ext=='.pptx':
    package(['[Content_Types].xml','ppt/presentation.xml'])
    from pptx import Presentation
    deck=Presentation(str(p)); assert len(deck.slides)>0, 'PPTX has no slides'
    result={'format':'pptx','pages':len(deck.slides)}
elif ext in ('.svg','.html'):
    assert p.stat().st_size<=20971520, 'Model documents must not exceed 20 MiB'
    content=p.read_text(encoding='utf-8-sig')
    assert content.strip() and '\x00' not in content, 'Model document must be nonempty UTF-8'
    assert content.lstrip().startswith('<'), 'Model document must contain markup, not a disguised binary or text file'
    if ext=='.svg':
        assert '<!doctype' not in content.lower() and '<!entity' not in content.lower(), 'SVG DTD and entity declarations are not supported'
        root=ET.fromstring(content)
        assert root.tag in ('svg','{http://www.w3.org/2000/svg}svg'), 'Document root must be SVG'
    else:
        from html.parser import HTMLParser
        class DocumentParser(HTMLParser):
            def __init__(self):
                super().__init__(); self.tags=set()
            def handle_starttag(self,tag,attrs): self.tags.add(tag)
        parser=DocumentParser(); parser.feed(content); parser.close()
        assert {'html','body'}.issubset(parser.tags), 'HTML must be a standalone document with html and body'
    result={'format':ext[1:],'encoding':'utf-8','presentation':'download-only','rendered':False}
elif ext=='.docx':
    package(['[Content_Types].xml','word/document.xml'])
    from docx import Document
    d=Document(str(p)); content='\n'.join(x.text for x in d.paragraphs)+'\n'.join(c.text for t in d.tables for r in t.rows for c in r.cells)
    assert content.strip(), 'DOCX has no readable text'
    result={'format':'docx','paragraphs':len(d.paragraphs),'tables':len(d.tables)}
elif ext=='.pdf':
    from pypdf import PdfReader
    assert p.read_bytes().startswith(b'%PDF-'), 'PDF signature is invalid'
    reader=PdfReader(str(p),strict=True); assert not reader.is_encrypted, 'Encrypted PDF cannot be delivered'
    assert len(reader.pages)>0, 'PDF has no pages'
    for page in reader.pages: _=page.mediabox
    result={'format':'pdf','pages':len(reader.pages)}
elif ext=='.csv':
    raw=p.read_bytes(); assert not raw.startswith((b'%PDF-',b'PK\x03\x04')), 'Binary document renamed to CSV'
    text=raw.decode('utf-8-sig'); assert '\x00' not in text, 'CSV contains null bytes'
    rows=[row for row in csv.reader(io.StringIO(text,newline=''),strict=True) if any(cell.strip() for cell in row)]
    assert rows and rows[0], 'CSV is empty'
    width=len(rows[0]); assert all(len(row)==width for row in rows), 'CSV row widths do not match'
    result={'format':'csv','rows':len(rows),'columns':width,'encoding':'utf-8'}
else: raise ValueError('Unsupported document format')
print(json.dumps(result,ensure_ascii=False))
`;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', exceeded = false;
    const limit = () => { if (output.length + errors.length > 1_000_000) { exceeded = true; child.kill('SIGTERM'); } };
    child.stdout.on('data', bytes => { output += bytes; limit(); });
    child.stderr.on('data', bytes => { errors += bytes; limit(); });
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && !exceeded) resolve(output);
      else reject(new Error(`产物文件验证失败：${errors.trim() || output.trim() || `进程退出 ${code}`}`));
    });
  });
}

export function artifactFormat(kind, file) {
  const extension = path.extname(file).toLowerCase();
  if (!formats[kind]?.includes(extension)) throw new Error(`产物类型与格式不匹配：${kind} 只接受 ${formats[kind]?.join(' / ') || '已支持的类型'}`);
  if (kind === 'pptx' && /preview_noneditable/i.test(path.basename(file))) throw new Error('preview_noneditable 是视觉预览，不能登记为正式可编辑 PPT');
  return { extension, mime: mimeTypes[extension], role: ['storyboard', 'support'].includes(kind) ? 'intermediate' : 'delivery' };
}

/** Validate a private byte snapshot; the caller rechecks the original file before committing. */
export async function validateArtifact(kind, file, bytes, { pythonExecutable = 'python3', ffprobeExecutable = 'ffprobe', pptSkillDir = path.join(os.homedir(), '.codex/skills/wtt-course-pptx-builder') } = {}) {
  const { extension, mime, role } = artifactFormat(kind, file);
  if (kind === 'image' || kind === 'video') {
    if (!bytes.length || bytes.length > GENERATED_MEDIA_MAX_BYTES) throw new Error('生成媒体必须非空且不超过 200 MiB');
    let media;
    if (kind === 'video') {
      const checked = await extractMaterialImport(bytes, { extension, mime }, { ffprobe: ffprobeExecutable, python: pythonExecutable });
      if (!checked.media?.validated) throw new Error(checked.extractionError || '生成视频格式验证失败');
      media = checked.media;
    } else {
      const temporary = mkdtempSync(path.join(os.tmpdir(), 'wtt-image-check-'));
      try {
        const snapshot = path.join(temporary, `image${extension}`);
        writeFileSync(snapshot, bytes, { flag: 'wx', mode: 0o600 });
        media = JSON.parse(await run(pythonExecutable, ['-c', inspectImage, snapshot, extension]));
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    return { mime, validation: { status: 'passed', role, checkedAt: new Date().toISOString(), format: extension.slice(1), media } };
  }
  let report;
  if (['.md', '.txt', '.json', '.jsonl'].includes(extension)) {
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('文本产物必须是有效 UTF-8 文件'); }
    if (!content.trim() || content.includes('\0') || bytes.subarray(0, 5).toString() === '%PDF-' || bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('文本产物为空或实际是二进制文件');
    try {
      if (extension === '.json') {
        const value = JSON.parse(content.replace(/^\uFEFF/, ''));
        if (!value || typeof value !== 'object') throw new Error('JSON 交接内容须为对象或数组');
      }
      if (extension === '.jsonl') for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim())) {
        const value = JSON.parse(line); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSONL 每行须为对象');
      }
    } catch (error) { throw new Error(`中间资料格式无效：${error.message}`, { cause: error }); }
    report = { format: extension.slice(1), encoding: 'utf-8' };
  } else {
    const temporary = mkdtempSync(path.join(os.tmpdir(), 'wtt-artifact-check-'));
    const snapshot = path.join(temporary, `artifact${extension}`);
    try {
      writeFileSync(snapshot, bytes, { flag: 'wx', mode: 0o600 });
      report = JSON.parse(await run(pythonExecutable, ['-c', inspectDocument, snapshot]));
      if (kind === 'support' && extension === '.pptx') {
        report.presentation = 'download-only';
        report.editabilityChecked = false;
      }
      if (kind === 'pptx') {
        const validator = path.join(pptSkillDir, 'scripts/validate_pptx_editability.py');
        try { readFileSync(validator); } catch { throw new Error('PPT 可编辑性验证器不可用，请核对本机 PPT Builder Skill'); }
        const editability = JSON.parse(await run(pythonExecutable, [validator, snapshot, '--json']));
        if (editability.ok !== true || editability.page_count !== report.pages || !editability.totals?.editable_leaf_objects) throw new Error('PPT 未通过原生可编辑性检查');
        // A temporary validation path is an implementation detail, not the delivered artifact path.
        const { pptx: _temporaryPath, ...saved } = editability;
        report.editability = saved;
      }
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  return { mime, validation: { status: 'passed', role, checkedAt: new Date().toISOString(), ...report } };
}
