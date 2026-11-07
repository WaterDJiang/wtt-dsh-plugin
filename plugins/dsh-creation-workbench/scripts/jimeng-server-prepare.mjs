#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstream = path.join(root, '.runtime/jimeng-compatible-upstream');
const target = path.join(root, '.runtime/jimeng-backend');
const skill = path.join(os.homedir(), '.codex/skills/wtt-jimeng-api/backend');
const sourceUrl = 'https://github.com/hedashuaiii/jimeng-api.git';
const sourceCommit = 'e82acff7848a96a2e4d0f13ce8ed518f8e6f506f';
const sha = value => createHash('sha256').update(value).digest('hex');
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(`命令失败：${command} ${args.join(' ')}（${result.error?.message || result.status}）`);
};
if (!existsSync(upstream)) {
  run('git', ['-c', 'credential.helper=', 'clone', '--depth', '1', '--no-checkout', sourceUrl, upstream]);
  run('git', ['-c', 'credential.helper=', 'fetch', '--depth', '1', 'origin', sourceCommit], upstream);
  run('git', ['checkout', '--detach', sourceCommit], upstream);
}
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8' });
if (revision.status !== 0 || revision.stdout.trim() !== sourceCommit) throw new Error('公开运行库源码版本与固定 commit 不符，请核对隔离 checkout');
if (!existsSync(path.join(skill, 'src')) || !existsSync(path.join(skill, 'node_modules/tsup'))) throw new Error('本机即梦 Skill 源码或已安装构建依赖不完整');
if (existsSync(target) && readdirSync(target).length && !existsSync(path.join(target, 'source-manifest.json'))) throw new Error('目标目录含未登记内容，拒绝覆盖；请先核对 .runtime/jimeng-backend');
mkdirSync(target, { recursive: true });
for (const name of ['src/lib', 'LICENSE', 'tsconfig.json', 'libs.d.ts']) {
  const from = path.join(upstream, name);
  if (existsSync(from)) cpSync(from, path.join(target, name), { recursive: true, verbatimSymlinks: true });
}
cpSync(path.join(upstream, 'README.md'), path.join(target, 'UPSTREAM_README.md'));
for (const name of ['src', 'configs', 'public', 'package.json']) cpSync(path.join(skill, name), path.join(target, name), { recursive: true, verbatimSymlinks: true });
if (!existsSync(path.join(target, 'node_modules'))) cpSync(path.join(skill, 'node_modules'), path.join(target, 'node_modules'), { recursive: true, verbatimSymlinks: true });

const patches = [];
function patch(relative, before, after, label) {
  const file = path.join(target, relative), content = readFileSync(file, 'utf8');
  if (!content.includes(before)) throw new Error(`隔离修正无法匹配源码：${relative}（${label}）`);
  writeFileSync(file, content.replace(before, after)); patches.push(label);
}
patch('src/api/controllers/videos.ts', 'import { ProxyAgent as UndiciProxyAgent } from "undici";\nimport { ProxyAgent as UndiciProxyAgent } from "undici";',
  'import { ProxyAgent as UndiciProxyAgent } from "undici";', '移除重复 UndiciProxyAgent 导入');
patch('src/api/routes/images.ts', 'const files = (request.files as any)?.images;',
  'const files = request.filesMap?.images || (request.rawFiles as any)?.images;', '图片 multipart 使用原生 Request.filesMap');
// Both generation and composition use the same parser contract.
const imageRoute = path.join(target, 'src/api/routes/images.ts');
writeFileSync(imageRoute, readFileSync(imageRoute, 'utf8').replaceAll('const files = (request.files as any)?.images;', 'const files = request.filesMap?.images || (request.rawFiles as any)?.images;'));
patch('src/api/routes/videos.ts', 'const seedanceDuration = finalDuration === 5 ? 4 : finalDuration;',
  'const seedanceDuration = _.isUndefined(request.body.duration) ? 4 : finalDuration;', '同步 Seedance 保留显式 5 秒');
patch('src/api/routes/videos.ts', 'const seedanceRatio = ratio === "1:1" ? "4:3" : ratio;',
  'const seedanceRatio = _.isUndefined(request.body.ratio) ? "4:3" : ratio;', '同步 Seedance 保留显式 1:1');
patch('src/api/controllers/videos.ts', 'options.duration === 5 ? 4 : options.duration;',
  'options.duration === undefined ? 4 : options.duration;', '异步 Seedance 保留显式 5 秒');
patch('src/api/controllers/videos.ts', 'options.ratio === "1:1" ? "4:3" : options.ratio;',
  'options.ratio === undefined ? "4:3" : options.ratio;', '异步 Seedance 保留显式 1:1');
patch('src/api/controllers/videos.ts', 'const ASYNC_TASK_DIR = path.join(process.cwd(), "tmp", "async-tasks");',
  'const ASYNC_TASK_DIR = path.join(process.env.WTT_JIMENG_PRIVATE_DIR || process.cwd(), "async-tasks");', '异步认证恢复状态移到仓库外私有目录');
patch('src/api/controllers/videos.ts', 'JSON.stringify(data, null, 2), "utf-8");',
  'JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });', '异步状态文件仅本机用户可读');

// Capture credentials only in process memory so even upstream Axios errors are redacted.
patch('src/lib/server.ts', 'this.app = new Koa();', `this.app = new Koa();
        this.app.use(async (ctx, next) => {
            const authorization = ctx.headers.authorization;
            if (typeof authorization === 'string') {
                const secrets = ((globalThis as any).__wttJimengSecrets ||= new Set<string>());
                for (const token of authorization.replace(/^Bearer\\s+/i, '').split(',')) if (token.trim()) secrets.add(token.trim());
            }
            await next();
        });`, '只在内存捕获认证值用于日志脱敏');
patch('src/lib/logger.ts', 'this.text = _util.format.apply(null, params);', `let formatted = _util.format.apply(null, params);
        for (const secret of ((globalThis as any).__wttJimengSecrets || [])) formatted = formatted.split(secret).join('[REDACTED]');
        formatted = formatted.replace(/Bearer\\s+[^\\s'",}]+/gi, 'Bearer [REDACTED]');
        this.text = formatted;`, '终端和日志统一脱敏请求认证值');
patch('src/lib/browser-service.ts', 'headless: true,',
  'headless: true,\n          ...(process.env.JIMENG_CHROMIUM_EXECUTABLE ? { executablePath: process.env.JIMENG_CHROMIUM_EXECUTABLE } : {}),', '允许复用本机浏览器二进制，使用独立临时上下文');
const browserService = path.join(target, 'src/lib/browser-service.ts');
writeFileSync(browserService, readFileSync(browserService, 'utf8').replaceAll('${token.substring(0, 8)}...', '[session]'));
patches.push('不在浏览器会话日志输出 token 前缀');

const packageFile = path.join(target, 'package.json');
const originalPackage = JSON.parse(readFileSync(packageFile));
writeFileSync(packageFile, JSON.stringify({ ...originalPackage, name: 'wtt-jimeng-isolated-backend', version: `${originalPackage.version}-wtt.1`, license: 'GPL-3.0-only' }, null, 2) + '\n');
writeFileSync(path.join(target, 'configs/dev/service.yml'), "name: wtt-jimeng-isolated\nhost: '127.0.0.1'\nport: 8000\n");
writeFileSync(path.join(target, 'configs/dev/system.yml'), 'requestLog: false\ndebug: false\ntmpDir: ./tmp\nlogDir: ./logs\nlogWriteInterval: 200\nlogFileExpires: 86400000\npublicDir: ./public\ntmpFileExpires: 86400000\n');
const files = [];
function collect(directory, prefix = '') {
  for (const name of readdirSync(directory).sort()) {
    const relative = path.posix.join(prefix, name), file = path.join(directory, name);
    if (statSync(file).isDirectory()) collect(file, relative);
    else files.push({ path: relative, sha256: sha(readFileSync(file)) });
  }
}
collect(path.join(target, 'src'), 'src');
const manifest = { preparedAt: new Date().toISOString(), publicSource: sourceUrl, publicCommit: sourceCommit,
  publicPackageVersion: JSON.parse(readFileSync(path.join(upstream, 'package.json'))).version,
  localSkillPackageVersion: originalPackage.version, runtimeVersion: `${originalPackage.version}-wtt.1`,
  licenseFile: 'LICENSE', license: 'GPL-3.0', originalPackageLicense: originalPackage.license,
  licenseNote: '公开 fork 的 LICENSE 是 GPL-3.0；保留全文。原 package 声明 ISC 与 LICENSE 不一致，本隔离副本按实际 LICENSE 标注。',
  patches, sourceTreeSha256: sha(JSON.stringify(files)), files };
writeFileSync(path.join(target, 'source-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(path.join(target, 'LOCAL_CHANGES.md'), `# 本机隔离副本\n\n公开运行库：${sourceUrl}\n固定 commit：${sourceCommit}\n本机 Skill API 扩展版本：${originalPackage.version}\n\n${patches.map(item => '- ' + item).join('\n')}\n\n保留公开 LICENSE；不包含 Skill config.json、sessionid 或账号数据。仅本机 loopback 服务，不随插件包分发。\n`);
run(process.execPath, [path.join(target, 'node_modules/tsup/dist/cli-default.js'), 'src/index.ts', '--format', 'cjs,esm', '--sourcemap', '--dts', '--clean', '--publicDir', 'public'], target);
console.log(JSON.stringify({ prepared: true, target, version: manifest.runtimeVersion, publicCommit: sourceCommit, sourceTreeSha256: manifest.sourceTreeSha256 }));
