import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
export function localEditorUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || !url.port || url.username || url.password
    || !/^\/slides\/[a-zA-Z0-9_-]+\/$/.test(url.pathname) || url.search || url.hash) throw new Error('宝玉编辑地址不是有效的本机课件地址');
  return url;
}
function hostOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname) || url.origin !== value) throw new Error('编辑器只向当前本机工作台开放');
  return url.origin;
}
export function editorParentOrigin(request) {
  // DSH intentionally creates Request.url with dsh.internal; Host is admitted by its connection layer.
  const host = request.headers.get('host');
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$/.test(host)) throw new Error('缺少经过核对的本机工作台 Host');
  const origin = hostOrigin(`http://${host}`);
  if (request.headers.get('origin') && request.headers.get('origin') !== origin) throw new Error('编辑器请求与工作台来源不一致');
  return origin;
}
export function findSlidesRuntime(config = {}) {
  const candidates = [config.slidesPackageDir,
    process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'profiles/web/node_modules/dsh-claude-slides'),
    path.resolve(import.meta.dirname, '../.runtime/dsh-home/profiles/web/node_modules/dsh-claude-slides')].filter(Boolean);
  const directory = candidates.find(root => existsSync(path.join(root, 'skills/claude-slides/scripts/artifact.mjs')));
  if (!directory) throw new Error('未找到已安装的 dsh-claude-slides；请在当前 DSH web profile 安装宝玉幻灯片插件');
  const root = realpathSync(directory);
  return { root, script: path.join(root, 'skills/claude-slides/scripts/artifact.mjs'),
    skill: path.join(root, 'skills/claude-slides/SKILL.md'), plugin: path.join(root, 'lib/index.js') };
}

/** Configure the installed editor at response time; never copy or patch its files. */
export function configureEditorHtml(html, parentOrigin) {
  hostOrigin(parentOrigin);
  if (!html.includes('id="appifact-flags"') || !html.includes('</head>')) throw new Error('宝玉编辑器启动协议已变化，无法安全嵌入');
  return html.replace('</head>', `<script>${editorBootScript(parentOrigin)}</script></head>`);
}
function editorBootScript(parentOrigin) {
  const origin = JSON.stringify(parentOrigin).replaceAll('<', '\\u003c');
  return `window.__FRAME_PREAMBLE={...(window.__FRAME_PREAMBLE||{}),origins:[${origin}]};` +
    `(()=>{const flags=globalThis.__appifact_flags;if(!flags||flags.version!=="appifact-flags:v1")return;` +
    `globalThis.__appifact_flags={...flags,get:(k,f)=>k==="appifact_extra_export_formats"?true:flags.get(k,f),all:()=>({...flags.all(),appifact_extra_export_formats:true})};})();` +
    `window.addEventListener('message',event=>{if(event.source!==window.parent||event.origin!==${origin})return;const m=event.data;if(!m||m.__wtt_slides_command!==true)return;` +
    `if(m.cmd==='theme'&&['light','dark'].includes(m.theme)){document.documentElement.setAttribute('data-theme',m.theme);return;}` +
    `if(typeof m.request!=='string'||!/^[-a-f0-9]{36}$/.test(m.request))return;` +
    `if(['comments-list','comment-submit','comment-reply'].includes(m.cmd)){(async()=>{try{const base=new URL('__comments',location.href);const p=m.payload||{};` +
    `if(m.cmd==='comment-reply'){if(typeof p.id!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(p.id))throw new Error('批注标识无效');base.pathname+='/'+p.id+'/messages';}` +
    `const list=m.cmd==='comments-list';const response=await fetch(base,{credentials:'same-origin',cache:'no-store',...(list?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m.cmd==='comment-reply'?{text:p.text,...(p.send?{send:true}:{})}:p)})});` +
    `const result=await response.json();if(!response.ok)throw new Error(result.message||result.error||'批注保存失败');window.parent.postMessage({__wtt_slides_reply:true,request:m.request,result},${origin});` +
    `}catch(error){window.parent.postMessage({__wtt_slides_reply:true,request:m.request,error:String(error.message||error)},${origin});}})();return;}` +
    `if(m.cmd!=='export-pptx')return;` +
    `try{const entries=typeof window.__baoyuExports==='function'?window.__baoyuExports():[];const entry=entries.find(item=>/\\.pptx\\b/i.test(item.label)&&item.disabled!==true);` +
    `if(!entry||typeof entry.run!=='function')throw new Error('宝玉原生 PowerPoint 导出入口尚未就绪');entry.run();window.parent.postMessage({__wtt_slides_reply:true,request:m.request,accepted:true},${origin});` +
    `}catch(error){window.parent.postMessage({__wtt_slides_reply:true,request:m.request,error:String(error.message||error)},${origin});}});`;
}
export function configuredEditorPolicy(policy, parentOrigin) {
  hostOrigin(parentOrigin);
  const hash = createHash('sha256').update(editorBootScript(parentOrigin)).digest('base64');
  const directive = `script-src 'self' 'sha256-${hash}'`;
  if (!policy) return directive;
  return /(?:^|;)\s*script-src\s/.test(policy)
    ? policy.replace(/((?:^|;)\s*script-src\s+[^;]*)/, `$1 'sha256-${hash}'`)
    : `${policy}; ${directive}`;

}

export class BaoyuRuntime {
  constructor(config = {}) { this.config = config; this.editors = new Map(); this.opening = new Map(); this.waits = new Map(); this.closed = false; }
  resolve() { return findSlidesRuntime(this.config); }
  async run(args, { timeout = 30_000, signal } = {}) {
    if (this.closed) throw new Error('宝玉编辑适配器已关闭');
    const runtime = this.resolve();
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runtime.script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], signal,
        env: { ...process.env, NODE_NO_WARNINGS: '1' } });
      let stdout = '', stderr = '', limit = false;
      const collect = (kind, chunk) => {
        if (kind === 'out') stdout += chunk; else stderr += chunk;
        if (stdout.length + stderr.length > 2_000_000) { limit = true; child.kill(); }
      };
      child.stdout.setEncoding('utf8').on('data', chunk => collect('out', chunk));
      child.stderr.setEncoding('utf8').on('data', chunk => collect('err', chunk));
      const timer = timeout > 0 ? setTimeout(() => child.kill(), timeout) : null;
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0 || limit) return reject(new Error(`宝玉命令 ${args[0]} 失败（退出 ${code}）：${(stderr || stdout).replace(/(http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+)\/slides\/[^/\s]+/g, '$1/slides/[授权已隐藏]').slice(0, 1800)}`));
        try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error(`宝玉命令 ${args[0]} 未返回有效 JSON`)); }
      });
    });
  }
  async open(root, parentOrigin, sessionId) {
    parentOrigin = hostOrigin(parentOrigin);
    const key = `${root}\0${parentOrigin}`;
    if (this.opening.has(key)) return this.opening.get(key);
    const pending = this.#open(root, parentOrigin, sessionId, key).finally(() => this.opening.delete(key));
    this.opening.set(key, pending); return pending;
  }
  async #open(root, parentOrigin, sessionId, key) {
    const opened = await this.run(['open', root, '--port', '0']);
    const cached = this.editors.get(key);
    if (cached && cached.upstream === opened.url && cached.server.listening) { this.watch(root, sessionId); return cached.result; }
    if (cached) { cached.server.closeAllConnections(); cached.server.close(); this.editors.delete(key); }
    if (realpathSync(opened.root) !== realpathSync(root)) throw new Error('宝玉返回了其他工程的编辑地址');
    const upstream = localEditorUrl(opened.url), cookies = new Set();
    const server = http.createServer((request, response) => {
      const address = server.address(), ownOrigin = `http://127.0.0.1:${address.port}`;
      if (request.headers.host !== `127.0.0.1:${address.port}` || (request.headers.origin && ![parentOrigin, ownOrigin].includes(request.headers.origin))) {
        response.writeHead(403); return response.end('编辑器来源无效');
      }
      const headers = { ...request.headers, host: upstream.host };
      delete headers.authorization;
      headers.cookie = (headers.cookie || '').split(';').filter(item => cookies.has(item.trim().split('=')[0])).join(';');
      if (headers.origin) headers.origin = upstream.origin;
      if (headers.referer?.startsWith(ownOrigin)) headers.referer = headers.referer.replace(ownOrigin, upstream.origin);
      // Identity encoding permits injecting only documented boot configuration.
      headers['accept-encoding'] = 'identity';
      const outgoing = http.request(upstream.origin + request.url, { method: request.method, headers }, incoming => {
        const resultHeaders = { ...incoming.headers };
        for (const cookie of incoming.headers['set-cookie'] || []) cookies.add(cookie.split('=')[0]);
        if (resultHeaders.location?.startsWith(upstream.origin)) resultHeaders.location = resultHeaders.location.replace(upstream.origin, ownOrigin);
        if (request.method === 'POST' && new URL(request.url, ownOrigin).pathname.endsWith('/__share/save') && incoming.statusCode === 200) {
          let receipt = '';
          incoming.setEncoding('utf8').on('data', chunk => { receipt += chunk; if (receipt.length > 64_000) incoming.destroy(new Error('导出回执超限')); });
          incoming.on('end', () => {
            try {
              this.config.recordSlideExport?.(root, JSON.parse(receipt));
              response.writeHead(200, resultHeaders); response.end(receipt);
            } catch (error) { response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: `文件已导出，但回执校验失败：${error.message}` })); }
          });
        } else if (String(resultHeaders['content-type']).includes('text/html') && new URL(request.url, ownOrigin).pathname === upstream.pathname) {
          let html = '';
          incoming.setEncoding('utf8').on('data', chunk => { html += chunk; if (html.length > 4_000_000) incoming.destroy(new Error('编辑器页面超限')); });
          incoming.on('end', () => {
            try {
              const configured = configureEditorHtml(html, parentOrigin);
              delete resultHeaders['content-length']; delete resultHeaders.etag;
              resultHeaders['cache-control'] = 'no-store';
              resultHeaders['content-security-policy'] = configuredEditorPolicy(resultHeaders['content-security-policy'], parentOrigin);
              response.writeHead(incoming.statusCode || 502, resultHeaders); response.end(configured);
            } catch (error) { response.writeHead(502); response.end(error.message); }
          });
        } else { response.writeHead(incoming.statusCode || 502, resultHeaders); incoming.pipe(response); }
        incoming.on('error', () => response.destroy());
      });
      outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('本机宝玉编辑器连接失败，请重新打开'); });
      request.on('aborted', () => outgoing.destroy());
      response.on('close', () => outgoing.destroy());
      request.pipe(outgoing);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (this.closed) { server.close(); throw new Error('工作台已关闭'); }
    const result = { url: `http://127.0.0.1:${server.address().port}${upstream.pathname}`, sessionId };
    this.editors.set(key, { server, result, root, upstream: opened.url, script: this.resolve().script });
    this.watch(root, sessionId);
    return result;
  }
  watch(root, sessionId) {
    if (!this.config.deliverSlideComments || this.waits.has(root)) return;
    const controller = new AbortController(); this.waits.set(root, controller);
    void (async () => {
      const { commentMessage } = await import(pathToFileURL(this.resolve().plugin).href);
      while (!this.closed && !controller.signal.aborted) {
        const batch = await this.run(['comments', root, '--wait'], { timeout: 0, signal: controller.signal });
        if (batch.threads?.length || batch.requests?.length) {
          const message = commentMessage({ name: 'claude-slides', comments: true }, 'dsh-claude-slides', batch, root);
          await this.config.deliverSlideComments(sessionId, message, root);
        }
      }
    })().catch(error => {
      if (!this.closed && !controller.signal.aborted) this.config.onSlideCommentError?.(root, error.message);
    }).finally(() => { if (this.waits.get(root) === controller) this.waits.delete(root); });
  }
  close() {
    this.closed = true;
    for (const controller of this.waits.values()) controller.abort();
    for (const { server, root, script } of this.editors.values()) {
      server.closeAllConnections(); server.close();
      spawnSync(process.execPath, [script, 'stop', root], { timeout: 5000, stdio: 'ignore' });
    }
    this.editors.clear();
  }
}
