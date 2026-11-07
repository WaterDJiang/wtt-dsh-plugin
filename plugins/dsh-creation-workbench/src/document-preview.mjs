import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './service.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export class DocumentPreview {
  constructor(service) {
    this.service = service; this.inflight = new Map();
    const fonts = ['/System/Library/Fonts', '/System/Library/AssetsV2/com_apple_MobileAsset_Font8', '/usr/share/fonts'].filter(existsSync).map(directory => [directory, statSync(directory).mtimeMs]);
    this.rendererKey = sha(Buffer.concat([readFileSync(fileURLToPath(new URL('./document-preview.py', import.meta.url))), Buffer.from(JSON.stringify({ python: service.python, platform: process.platform, fonts }))])).slice(0, 16);
  }
  async source(ref, hash) {
    if (typeof ref !== 'string' || !/^(artifact|word|material):[a-f0-9-]{36}$/i.test(ref) || !/^[a-f0-9]{64}$/i.test(hash || '')) throw new Error('文档版本引用或hash无效');
    const [kind, id] = ref.split(':');
    let file;
    if (kind === 'artifact') {
      const read = this.service.tasks.files.read(id);
      file = { bytes: read.bytes, name: read.artifact.path, title: read.artifact.title };
    } else if (kind === 'material') file = this.service.canvas.readImportedFile(id);
    else file = await this.service.download(id);
    const extension = path.extname(file.name).toLowerCase();
    if (!['.pdf', '.docx'].includes(extension)) throw new Error('此入口只预览真实PDF／Word文件');
    if (sha(file.bytes) !== hash) throw new Error('文档文件已变化或选择的版本不一致');
    return { ...file, extension, id, hash, ref };
  }
  directory(source) {
    let target = this.service.workspaceRoot;
    for (const part of ['.wtt-workbench', 'previews', 'documents', source.id, `${source.hash}-${this.rendererKey}`]) {
      target = path.join(target, part); mkdirSync(target, { recursive: true });
      if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) throw new Error('文档预览目录不能是链接');
    }
    return target;
  }
  cached(directory, source, pageNumber) {
    const file = path.join(directory, 'manifest.json');
    if (lstatSync(file).isSymbolicLink()) throw new Error('文档预览清单不能是链接');
    const info = JSON.parse(readFileSync(file, 'utf8'));
    if (info.version !== 1 || !Array.isArray(info.pages) || info.pages.length !== info.pageCount || info.pageCount < 1 || info.pageCount > 200) throw new Error('文档预览清单无效');
    for (let index = 0; index < info.pages.length; index++) {
      const page = info.pages[index], actual = path.join(directory, `page-${index + 1}.png`);
      if (page.number !== index + 1 || page.file !== `page-${index + 1}.png`) throw new Error('文档预览清单页码无效');
      if ((pageNumber === undefined || pageNumber === page.number) && (lstatSync(actual).isSymbolicLink() || sha(readFileSync(actual)) !== page.hash)) throw new Error('文档预览页校验失败');
    }
    return { ...info, sourceRef: source.ref, hash: source.hash, status: 'ready' };
  }
  async get(ref, hash, { pageNumber } = {}) {
    const source = await this.source(ref, hash), directory = this.directory(source);
    try { return this.cached(directory, source, pageNumber); } catch (error) { if (existsSync(path.join(directory, 'manifest.json')) && lstatSync(path.join(directory, 'manifest.json')).isSymbolicLink()) throw error; }
    const key = `${ref}:${hash}`;
    if (!this.inflight.has(key)) {
      const job = (async () => {
        const snapshot = path.join(directory, `source${source.extension}`);
        if (existsSync(snapshot) && (lstatSync(snapshot).isSymbolicLink() || sha(readFileSync(snapshot)) !== hash)) throw new Error('受管文档预览源发生变化，未覆盖');
        if (!existsSync(snapshot)) writeFileSync(snapshot, source.bytes, { flag: 'wx', mode: 0o600 });
        const converted = path.join(directory, 'source.pdf');
        if (existsSync(converted) && lstatSync(converted).isSymbolicLink()) throw new Error('文档转换目标不能是链接');
        // Never render into an attacker-replaced page path.
        for (let page = 1; page <= 200; page++) { const file = path.join(directory, `page-${page}.png`); if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('文档预览页不能是链接'); }
        const fonts = this.service.deck.previewRenderer.documentFontConfiguration();
        await runProcess(this.service.python, [fileURLToPath(new URL('./document-preview.py', import.meta.url)), snapshot, directory, path.join(this.service.pptSkillDir, 'scripts'), fonts.fontconfigPath], { timeout: 150000 });
        await this.source(ref, hash); return this.cached(directory, source);
      })();
      this.inflight.set(key, job); job.finally(() => this.inflight.delete(key)).catch(() => {});
    }
    return this.inflight.get(key);
  }
  async page(ref, hash, number) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 200) throw new Error('文档页码无效');
    const manifest = await this.get(ref, hash, { pageNumber: number }), page = manifest.pages[number - 1];
    if (!page) throw new Error('文档页码超出范围');
    const source = await this.source(ref, hash), file = path.join(this.directory(source), page.file);
    const bytes = readFileSync(file);
    if (sha(bytes) !== page.hash) throw new Error('文档预览页已变化');
    return { bytes, mime: 'image/png', name: page.file };
  }
}
