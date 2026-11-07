import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';

const VERSION = 'cw10-ppt-preview-2';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// The existing Builder does the actual LibreOffice → PDF → PNG conversion. This
// preflight bounds that renderer's fixed 1280px page width before rasterization.
const PREFLIGHT_AND_RENDER = String.raw`
import collections,hashlib,json,math,posixpath,resource,runpy,sys,zipfile
from pathlib import Path
import xml.etree.ElementTree as ET
source,script,out,script_hash,max_pages,max_pixels,max_total,max_expanded,max_bytes,timeout,fontconfig,fontconfig_hash=sys.argv[1:]
script=Path(script)
if hashlib.sha256(script.read_bytes()).hexdigest()!=script_hash: raise ValueError('渲染脚本已变更，请重试预览')
with zipfile.ZipFile(source) as package:
 entries=package.infolist()
 if len(entries)>10000 or sum(x.file_size for x in entries)>int(max_expanded): raise ValueError('PPTX 解压体积或文件数超过预览限制')
 root=ET.fromstring(package.read('ppt/presentation.xml'))
 ns={'p':'http://schemas.openxmlformats.org/presentationml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
 pages=len(root.findall('p:sldIdLst/p:sldId',ns));size=root.find('p:sldSz',ns)
 if pages<1 or pages>int(max_pages): raise ValueError('PPTX 页数超过预览限制：'+str(pages))
 if size is None: raise ValueError('PPTX 缺少实际页面尺寸')
 width,height=int(size.attrib['cx']),int(size.attrib['cy'])
 if width<=0 or height<=0: raise ValueError('PPTX 页面尺寸无效')
 pixels=1280*(int(1280*height/width)+2)
 if pixels>int(max_pixels) or pixels*pages>int(max_total): raise ValueError('PPTX 页面像素超过预览限制')
 expected_text=[]
 def visible_text(element):
  if element.tag.rsplit('}',1)[-1] in {'sp','grpSp','graphicFrame','cxnSp','pic'}:
   for properties in list(element):
    if properties.tag.rsplit('}',1)[-1].startswith('nv'):
     if any(x.attrib.get('hidden','').lower() in {'true','1'} for x in properties if x.tag.rsplit('}',1)[-1]=='cNvPr'): return ''
  if element.tag=='{'+ns['a']+'}t': return element.text or ''
  return ''.join(visible_text(child) for child in element)
 relation_root=ET.fromstring(package.read('ppt/_rels/presentation.xml.rels'))
 slides={item.attrib['Id']:item.attrib.get('Target','') for item in relation_root}
 for slide in root.findall('p:sldIdLst/p:sldId',ns):
  target=slides.get(slide.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'),'')
  target=posixpath.normpath(posixpath.join('ppt',target)) if not target.startswith('/') else target.lstrip('/')
  if not target.startswith('ppt/slides/') or not target.endswith('.xml'): raise ValueError('PPTX 页面关系无效')
  expected_text.append(visible_text(ET.fromstring(package.read(target))))
 for entry in entries:
  lowered=entry.filename.lower()
  if 'vbaproject' in lowered or lowered.startswith('ppt/activex/'):
   raise ValueError('当前预览不运行含宏或 ActiveX 的课件')
  if lowered.endswith('.rels'):
   relations=ET.fromstring(package.read(entry))
   for relation in relations:
    if relation.attrib.get('TargetMode','').lower()=='external' and not relation.attrib.get('Type','').endswith('/hyperlink'):
     raise ValueError('课件含外部资源，当前预览不加载外部文件或网络素材')
# Bound intermediate PDF/file writes as well as the final cache. These limits
# are process-local and inherited by this isolated LibreOffice invocation.
resource.setrlimit(resource.RLIMIT_FSIZE,(int(max_bytes),int(max_bytes)))
import fitz
original_pixmap=fitz.Page.get_pixmap
original_save=fitz.Pixmap.save
rendered_pixels=0;rendered_bytes=0
def bounded_pixmap(page,*args,**kwargs):
 global rendered_pixels
 bounds=page.rect*kwargs.get('matrix',fitz.Matrix(1,1))
 pixels=math.ceil(bounds.width)*math.ceil(bounds.height)
 if pixels>int(max_pixels) or pixels+rendered_pixels>int(max_total): raise ValueError('实际 PDF 页面像素超过预览限制')
 rendered_pixels+=pixels
 return original_pixmap(page,*args,**kwargs)
def bounded_save(image,filename,*args,**kwargs):
 global rendered_bytes
 result=original_save(image,filename,*args,**kwargs)
 rendered_bytes+=Path(filename).stat().st_size
 if rendered_bytes>int(max_bytes): raise ValueError('实际预览页图超过缓存大小限制')
 return result
fitz.Page.get_pixmap=bounded_pixmap
fitz.Pixmap.save=bounded_save
sys.argv=[str(script),source,'--out',out,'--timeout',timeout,'--fontconfig',fontconfig]
try:
 runpy.run_path(str(script),run_name='__main__')
except SystemExit as error:
 if error.code not in {0,None}: raise
# Text extraction alone can include invisible text. Compare Chinese characters
# against actual painted glyph traces, rejecting missing/.notdef/transparent
# glyphs. PNGs are still real PDF rasterizations and require visual review.
def chinese(code):
 return 0x3400<=code<=0x4dbf or 0x4e00<=code<=0x9fff or 0xf900<=code<=0xfaff or 0x20000<=code<=0x323af
manifest_path=Path(out)/'manifest.json';manifest=json.loads(manifest_path.read_text())
if manifest.get('fontconfig_sha256')!=fontconfig_hash: raise ValueError('渲染未使用本次核验的字体配置')
with fitz.open(Path(out)/(Path(source).stem+'.pdf')) as document:
 for number,(page,expected) in enumerate(zip(document,expected_text),1):
  wanted=collections.Counter(ord(c) for c in expected if chinese(ord(c)))
  drawn=collections.Counter()
  for span in page.get_texttrace():
   if span.get('type') not in {0,1,2} or span.get('opacity',1)<=0: continue
   for char in span.get('chars',()):
    code,glyph,origin,bbox=char
    if chinese(code) and glyph>0 and fitz.Rect(bbox).intersects(page.rect): drawn[code]+=1
  missing=wanted-drawn
  if missing: raise ValueError('第 '+str(number)+' 页中文未实际绘制，字体转换失败：'+''.join(chr(c) for c in list(missing)[:24]))
  if expected.strip() and not page.get_text().strip(): raise ValueError('第 '+str(number)+' 页原有文字未转换为可核验的实际内容')
manifest['chinese_glyph_check']='passed';manifest_path.write_text(json.dumps(manifest,ensure_ascii=False))
`;

export function compactPptRenderDiagnostics(value) {
  const counts=new Map(),lines=[];
  for(const line of String(value).split('\n')){const key=line.trim();if(!key)continue;if(counts.has(key)){counts.set(key,counts.get(key)+1);continue;}counts.set(key,1);lines.push(key);}
  return lines.map(line=>line+(counts.get(line)>1?`（重复 ${counts.get(line)} 次）`:'')).join('\n');
}

function positive(value, fallback, maximum, label) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`${label}无效`);
  return result;
}

/** Derived local previews only; the registered PPTX remains the formal artifact. */
export class ArtifactPreview {
  constructor(service, options = {}) {
    this.service = service;
    this.root = realpathSync(service.workspaceRoot);
    if (service.tasks?.files?.store !== service.store || service.store.workspaceRoot !== this.root) throw new Error('预览必须绑定当前项目的文件产物服务');
    this.files = service.tasks.files;
    this.cacheRoot = path.join(this.root, '.wtt-workbench', 'previews', 'pptx');
    this.script = path.resolve(service.pptSkillDir, 'scripts/render_course_pptx.py');
    this.python = service.python || 'python3';
    const directories = options.fontDirectories ?? ['/System/Library/Fonts', '/System/Library/Fonts/Supplemental', '/Library/Fonts',
      '/System/Library/AssetsV2/com_apple_MobileAsset_Font8', '/usr/share/fonts', '/usr/local/share/fonts'].filter(existsSync);
    if (!Array.isArray(directories) || !directories.length || directories.length > 20) throw new Error('预览字体目录无效');
    this.fontDirectories = [...new Set(directories.map(directory => {
      if (typeof directory !== 'string' || !path.isAbsolute(directory) || !lstatSync(directory).isDirectory()) throw new Error('预览字体目录必须是本机实际目录');
      return realpathSync(directory);
    }))];
    this.maxPages = positive(options.maxPages, 200, 200, '预览页数上限');
    this.maxPagePixels = positive(options.maxPagePixels, 4_000_000, 8_000_000, '单页像素上限');
    this.maxTotalPixels = positive(options.maxTotalPixels, 200_000_000, 400_000_000, '总像素上限');
    this.maxFileBytes = positive(options.maxFileBytes, 200 * 1024 * 1024, 200 * 1024 * 1024, '原文件大小上限');
    this.maxCacheBytes = positive(options.maxCacheBytes, 200 * 1024 * 1024, 400 * 1024 * 1024, '预览缓存大小上限');
    this.timeoutMs = positive(options.timeoutMs, 150_000, 300_000, '预览超时');
    this.inflight = new Map();
    this.queue = Promise.resolve();
    this.children = new Set();
    this.closed = false;
  }

  #directory(directory, create = false) {
    const relative = path.relative(this.root, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('预览缓存路径超出项目目录');
    let current = this.root;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      if (create) {
        try { mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory() || realpathSync(current) !== current) throw new Error('预览缓存目录不能使用符号链接');
    }
    return directory;
  }

  #read(file, limit) {
    this.#directory(path.dirname(file));
    if (lstatSync(file).isSymbolicLink() || realpathSync(file) !== file) throw new Error('预览缓存文件不能使用符号链接');
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error('预览文件大小超过限制或不是实际文件');
      const bytes = readFileSync(descriptor);
      if (bytes.length !== info.size) throw new Error('预览文件在读取时发生变更');
      return bytes;
    } finally { closeSync(descriptor); }
  }

  #source(id) {
    if (this.closed || this.service.store.closed) throw new Error('预览服务已关闭');
    if (this.files.store !== this.service.store || this.service.workspaceRoot !== this.root) throw new Error('预览项目已改变');
    const artifact = this.files.get(id);
    if (!['pptx', 'support'].includes(artifact.kind) || path.extname(artifact.path).toLowerCase() !== '.pptx') throw new Error('只有实际 PPTX 课件产物可以生成逐页预览');
    if (artifact.byteSize > this.maxFileBytes) throw new Error('PPTX 文件超过预览大小上限，可下载原文件');
    const { bytes } = this.files.read(id);
    if (!hashValue(artifact.hash) || sha(bytes) !== artifact.hash) throw new Error('PPTX 文件已外改，不能使用旧版本预览');
    return { artifact, bytes };
  }

  documentFontConfiguration() { return this.#renderer(); }

  #renderer() {
    const bytes = readFileSync(this.script);
    if (!bytes.length || bytes.length > 1_048_576) throw new Error('PPT 渲染脚本大小无效');
    const scriptHash = sha(bytes);
    const fontRoot = path.join(this.root, '.wtt-workbench', 'previews', 'fonts');
    const fontCache = path.join(fontRoot, 'cache'); this.#directory(fontCache, true);
    const aliases = { 'PingFang SC': ['Heiti SC'], KaiTi: ['STKaiti', 'Kaiti SC'], '楷体': ['STKaiti', 'Kaiti SC'],
      Consolas: ['Menlo', 'Liberation Mono'], monospace: ['Menlo', 'Liberation Mono'],
      'Segoe UI': ['Arial', 'Heiti SC'], 'sans-serif': ['Arial', 'Heiti SC'],
      'Microsoft YaHei': ['Heiti SC'], '微软雅黑': ['Heiti SC'], SimSun: ['Heiti SC'], '宋体': ['Heiti SC'], SimHei: ['Heiti SC'], '黑体': ['Heiti SC'] };
    const fontconfig = `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>${this.fontDirectories.map(directory => `<dir>${xml(directory)}</dir>`).join('')}<cachedir>${xml(fontCache)}</cachedir>${Object.entries(aliases).map(([family, prefer]) => `<alias><family>${xml(family)}</family><prefer>${prefer.map(value => `<family>${xml(value)}</family>`).join('')}</prefer></alias>`).join('')}</fontconfig>`;
    const fontconfigHash = sha(fontconfig), fontconfigPath = path.join(fontRoot, `${fontconfigHash}.conf`);
    if (!existsSync(fontconfigPath)) writeFileSync(fontconfigPath, fontconfig, { flag: 'wx', mode: 0o600 });
    if (sha(this.#read(fontconfigPath, 65_536)) !== fontconfigHash) throw new Error('PPT 预览字体配置已被外改');
    const fontSignatures = this.fontDirectories.map(directory => {
      const info = lstatSync(directory); return [directory, info.dev, info.ino, info.mtimeMs, info.ctimeMs];
    });
    const rendererVersion = `${VERSION}-${sha(JSON.stringify([scriptHash, this.python, fontconfigHash, fontSignatures, this.maxPages, this.maxPagePixels, this.maxTotalPixels, this.maxCacheBytes])).slice(0, 20)}`;
    return { scriptHash, rendererVersion, fontconfigPath, fontconfigHash };
  }

  #png(bytes) {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG) || bytes.toString('ascii', 12, 16) !== 'IHDR'
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') throw new Error('预览页不是完整的 PNG 图片');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width !== 1280 || height < 1 || width * height > this.maxPagePixels) throw new Error('预览页面像素超过限制或尺寸无效');
    return { width, height };
  }

  #cached(directory, artifact, rendererVersion, requestedPage) {
    const value = JSON.parse(this.#read(path.join(directory, 'preview.json'), 1_048_576));
    if (value.artifactId !== artifact.id || value.hash !== artifact.hash || value.rendererVersion !== rendererVersion
      || value.workspace !== this.root || !Array.isArray(value.pages) || !value.pages.length
      || value.pages.length > this.maxPages || value.pageCount !== value.pages.length || value.status !== 'ready'
      || value.chineseGlyphCheck !== 'passed' || !hashValue(value.fontConfigurationHash)) throw new Error('预览清单与当前产物版本不符');
    let totalPixels = 0, totalBytes = 0;
    for (const [index, page] of value.pages.entries()) {
      if (page.number !== index + 1 || page.file !== `P${String(index + 1).padStart(3, '0')}.png` || !hashValue(page.hash)
        || page.width !== 1280 || !Number.isSafeInteger(page.height) || page.height < 1 || page.width * page.height > this.maxPagePixels
        || !Number.isSafeInteger(page.byteSize) || page.byteSize < 1 || page.byteSize > this.maxCacheBytes) throw new Error('预览页清单无效');
      totalPixels += page.width * page.height; totalBytes += page.byteSize;
      // The manifest endpoint verifies every page. A thumbnail request verifies
      // its own actual PNG, avoiding rereading a whole deck for each slide.
      if (requestedPage !== undefined && page.number !== requestedPage) continue;
      const bytes = this.#read(path.join(directory, page.file), this.maxCacheBytes);
      const size = this.#png(bytes);
      if (sha(bytes) !== page.hash || page.width !== size.width || page.height !== size.height || page.byteSize !== bytes.length) throw new Error('预览页内容与缓存清单不符');
    }
    if (totalPixels > this.maxTotalPixels || totalBytes > this.maxCacheBytes) throw new Error('预览缓存超过大小或总像素限制');
    return value;
  }

  #artifactCache(artifact, renderer, page) {
    const candidates = [
      { directory: path.join(this.cacheRoot, 'editable', 'by-hash', `${artifact.hash}-${renderer.rendererVersion}`), artifact: { ...artifact, id: artifact.hash } },
      { directory: path.join(this.cacheRoot, artifact.id, `${artifact.hash}-${renderer.rendererVersion}`), artifact },
    ];
    let failure;
    for (const candidate of candidates) {
      try { return { directory: candidate.directory, manifest: this.#cached(candidate.directory, candidate.artifact, renderer.rendererVersion, page) } }
      catch (cause) { failure = cause }
    }
    throw failure;
  }

  #public(manifest) {
    const { workspace, ...value } = manifest;
    return { ...value, pages: value.pages.map(({ file, ...page }) => page) };
  }

  #run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, args, { cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      this.children.add(child);
      let output = '', failure;
      const collect = data => { output = (output + data.toString()).slice(-32_768); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const stop = () => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} };
      child.previewStop = stop;
      const timer = setTimeout(() => { failure = new Error(`PPT 预览超过 ${this.timeoutMs} ms，已停止本地转换`); stop(); }, this.timeoutMs);
      const finish = error => {
        clearTimeout(timer); this.children.delete(child);
        if (error) reject(error); else resolve(output);
      };
      child.on('error', error => finish(error));
      child.on('close', code => finish(failure || (code === 0 ? null : new Error(`PPT 渲染命令退出 ${code}：${compactPptRenderDiagnostics(output)}`))));
    });
  }

  async #render(artifact, bytes, renderer, directory, verifySource = () => this.#source(artifact.id).artifact) {
    this.#directory(path.dirname(directory), true);
    const attempt = `${directory}.attempt-${randomUUID()}`;
    this.#directory(attempt, true);
    const source = path.join(attempt, 'source.pptx'), output = path.join(attempt, 'rendered');
    writeFileSync(source, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await this.#run(['-c', PREFLIGHT_AND_RENDER, source, this.script, output, renderer.scriptHash,
        String(this.maxPages), String(this.maxPagePixels), String(this.maxTotalPixels), String(512 * 1024 * 1024),
        String(this.maxCacheBytes), String(Math.max(1, (this.timeoutMs - 20_000) / 1000)), renderer.fontconfigPath, renderer.fontconfigHash]);
      const rendered = JSON.parse(this.#read(path.join(output, 'manifest.json'), 1_048_576));
      if (rendered.pptx_sha256 !== artifact.hash || rendered.fontconfig_sha256 !== renderer.fontconfigHash || rendered.chinese_glyph_check !== 'passed'
        || rendered.status !== 'rendered_requires_review' || !Array.isArray(rendered.pages)
        || !rendered.pages.length || rendered.pages.length > this.maxPages) throw new Error('PPT 渲染未产生可核验的真实页图');
      const published = path.join(attempt, 'published'); this.#directory(published, true);
      const pages = rendered.pages.map((page, index) => {
        const file = `P${String(index + 1).padStart(3, '0')}.png`;
        if (page.sequence !== index + 1 || page.image !== file || page.errors?.length) throw new Error('PPT 真实页面的顺序或文字渲染检查失败');
        const image = this.#read(path.join(output, file), this.maxCacheBytes), dimensions = this.#png(image);
        if (sha(image) !== page.image_sha256) throw new Error('PPT 渲染页图 hash 不符');
        writeFileSync(path.join(published, file), image, { flag: 'wx', mode: 0o600 });
        return { number: index + 1, file, hash: sha(image), byteSize: image.length, ...dimensions };
      });
      const current = verifySource();
      if (current.hash !== artifact.hash || this.#renderer().rendererVersion !== renderer.rendererVersion) throw new Error('PPT 或渲染脚本在预览时变更，请重试');
      const manifest = { artifactId: artifact.id, hash: artifact.hash, rendererVersion: renderer.rendererVersion, workspace: this.root,
        status: 'ready', derived: true, coverPage: 1, pageCount: pages.length, pages, createdAt: new Date().toISOString(), visualReview: 'pending',
        fontConfigurationHash: renderer.fontconfigHash, chineseGlyphCheck: 'passed',
        warnings: (rendered.warnings || []).map(item => ({ source: String(item.source), message: String(item.message).slice(0, 1000) })) };
      writeFileSync(path.join(published, 'preview.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      this.#cached(published, artifact, renderer.rendererVersion);
      if (existsSync(directory)) {
        this.#directory(directory);
        rmSync(directory, { recursive: true });
      }
      renameSync(published, directory);
      return this.#public(manifest);
    } catch (error) {
      // Keep structured page failures ahead of repeated MuPDF diagnostics.
      let detail = '';
      try {const manifest=JSON.parse(this.#read(path.join(output,'manifest.json'),1_048_576));
        const failures=(manifest.pages||[]).filter(page=>page.errors?.length).slice(0,8).map(page=>({page:page.sequence,errors:page.errors}));
        if(failures.length)detail+='\n页面检查未通过：'+JSON.stringify(failures);
      } catch {}
      for (const name of ['failure.json', 'renderer.log']) {
        try { detail += '\n' + compactPptRenderDiagnostics(this.#read(path.join(output, name), 65_536).toString('utf8')).slice(-1800); } catch {}
      }
      throw new Error(`${detail}\n${compactPptRenderDiagnostics(error.message)}`.trim().slice(0, 6000), { cause: error });
    } finally { this.#directory(attempt); rmSync(attempt, { recursive: true, force: true }); }
  }

  async get(id, { hash } = {}) {
    let artifact, renderer;
    try {
      artifact = this.files.get(id); // Keep the registered identity in honest failure DTOs too.
      const source = this.#source(id); artifact = source.artifact;
      if (hash !== undefined && hash !== artifact.hash) throw new Error('预览请求的 PPTX 版本已不匹配');
      renderer = this.#renderer();
      const key = `${artifact.id}:${artifact.hash}:${renderer.rendererVersion}`;
      const directory = path.join(this.cacheRoot, artifact.id, `${artifact.hash}-${renderer.rendererVersion}`);
      try { return { ...this.#public(this.#artifactCache(artifact, renderer).manifest), artifactId: artifact.id }; }
      catch {
        if (existsSync(directory)) this.#directory(directory); // Never replace a symlink masquerading as a cache.
      }
      if (!this.inflight.has(key)) {
        const job = this.queue.catch(() => {}).then(() => {
          if (this.closed) throw new Error('预览服务已关闭');
          return this.#render(artifact, source.bytes, renderer, directory);
        });
        this.queue = job; this.inflight.set(key, job);
        job.finally(() => this.inflight.delete(key)).catch(() => {});
      }
      return await this.inflight.get(key);
    } catch (error) {
      return { artifactId: artifact?.id || id, hash: artifact?.hash || null, status: 'failed', pageCount: 0, pages: [],
        derived: true, rendererVersion: renderer?.rendererVersion || VERSION, error: error.message };
    }
  }

  async readPage(id, pageNumber, { hash } = {}) {
    if (!hashValue(hash)) throw new Error('读取预览页必须指定登记 PPTX 的完整版本 hash');
    const source = this.#source(id);
    if (source.artifact.hash !== hash) throw new Error('预览页版本不匹配，不能返回其他版本的页面');
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > this.maxPages) throw new Error('预览页码无效');
    const renderer = this.#renderer();
    let cached;
    try { cached = this.#artifactCache(source.artifact, renderer, pageNumber); }
    catch {
      const preview = await this.get(id, { hash });
      if (preview.status !== 'ready') throw new Error(preview.error);
      cached = this.#artifactCache(source.artifact, renderer, pageNumber);
    }
    const { manifest, directory } = cached;
    if (pageNumber > manifest.pageCount) throw new Error('预览页码无效');
    const page = manifest.pages[pageNumber - 1];
    const bytes = this.#read(path.join(directory, page.file), this.maxCacheBytes);
    if (sha(bytes) !== page.hash) throw new Error('预览页在读取时发生变更');
    if (this.#source(id).artifact.hash !== hash) throw new Error('PPTX 在预览页读取时发生变更');
    return { bytes, mime: 'image/png', name: page.file, hash: page.hash, artifactHash: hash, width: page.width, height: page.height };
  }

  #editableSource({ id, hash, bytes, title = '编辑草稿' }) {
    if (this.closed || this.service.store.closed || this.service.workspaceRoot !== this.root) throw new Error('PPT 编辑预览服务已关闭或项目已改变');
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('编辑预览标识无效');
    if (!hashValue(hash) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > this.maxFileBytes || sha(bytes) !== hash) throw new Error('编辑预览文件与版本 hash 不匹配');
    const snapshot = Buffer.from(bytes);
    return { bytes: snapshot, artifact: { id: id.toLowerCase(), hash, title, kind: 'pptx', byteSize: snapshot.length } };
  }

  /** Only the project-owned editor may supply these verified byte snapshots. */
  async prepareBytes(input, { isCurrent = () => true, requestKey = '' } = {}) {
    const source = this.#editableSource(input), renderer = this.#renderer();
    const { bytes } = source;
    // Content-addressed only inside this workspace. New card/draft identities
    // must not reconvert the identical validated bytes after a version save.
    const artifact = { ...source.artifact, id: source.artifact.hash };
    const bind = result => ({ ...result, artifactId: source.artifact.id });
    const superseded = () => bind({ hash: artifact.hash, status: 'superseded', pageCount: 0, pages: [], derived: true });
    if (!isCurrent()) return superseded();
    const directory = path.join(this.cacheRoot, 'editable', 'by-hash', `${artifact.hash}-${renderer.rendererVersion}`);
    try { return bind(this.#public(this.#cached(directory, artifact, renderer.rendererVersion))); }
    catch { if (existsSync(directory)) this.#directory(directory); }
    const key = `editable:${artifact.id}:${artifact.hash}:${renderer.rendererVersion}:${requestKey}`;
    if (!this.inflight.has(key)) {
      const job = this.queue.catch(() => {}).then(() => {
        if (this.closed || this.service.store.closed) throw new Error('PPT 编辑预览服务已关闭');
        if (!isCurrent()) return superseded();
        try { return this.#public(this.#cached(directory, artifact, renderer.rendererVersion)); } catch {}
        return this.#render(artifact, bytes, renderer, directory, () => {
          if (this.closed || this.service.store.closed || sha(bytes) !== artifact.hash) throw new Error('编辑预览快照已改变');
          return artifact;
        });
      });
      this.queue = job; this.inflight.set(key, job);
      job.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    return bind(await this.inflight.get(key));
  }

  async readBytesPage(input) {
    const source = this.#editableSource(input), pageNumber = input.page;
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > this.maxPages) throw new Error('编辑预览页码无效');
    const renderer = this.#renderer(), artifact = { ...source.artifact, id: source.artifact.hash };
    const directory = path.join(this.cacheRoot, 'editable', 'by-hash', `${artifact.hash}-${renderer.rendererVersion}`);
    let manifest;
    try { manifest = this.#cached(directory, artifact, renderer.rendererVersion, pageNumber); }
    catch {
      await this.prepareBytes({ ...input, bytes: source.bytes });
      manifest = this.#cached(directory, artifact, renderer.rendererVersion, pageNumber);
    }
    const page = manifest.pages[pageNumber - 1];
    if (!page) throw new Error('编辑预览页码无效');
    const bytes = this.#read(path.join(directory, page.file), this.maxCacheBytes);
    if (sha(bytes) !== page.hash) throw new Error('编辑预览页在读取时发生变更');
    return { bytes, mime: 'image/png', name: page.file, hash: page.hash, artifactHash: artifact.hash, width: page.width, height: page.height };
  }

  close() { this.closed = true; for (const child of this.children) child.previewStop?.(); }
}

export const createArtifactPreview = (service, options) => new ArtifactPreview(service, options);
