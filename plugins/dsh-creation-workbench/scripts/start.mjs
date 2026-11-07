import { existsSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = (key) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
if (args.includes('--help') || !value('--workspace')) {
  console.log('用法：./scripts/wtt-dsh --workspace /绝对/工作文件夹 [--port 3080] [--no-open] [--install-only]');
  process.exit(args.includes('--help') ? 0 : 1);
}
const workspace = path.resolve(value('--workspace'));
const dshHome = path.join(project, '.runtime/dsh-home');
const cli = path.join(project, '.runtime/host/node_modules/@deepseek-ai/dsh/lib/bin.js');
if (!existsSync(cli)) throw new Error('DSH 尚未安装，按 README 完成隔离运行时安装');
if (!existsSync(path.join(project, 'dist/client.js'))) throw new Error('插件尚未构建，先执行 npm run build');
mkdirSync(workspace, { recursive: true });
const realWorkspace = realpathSync(workspace);
const env = { ...process.env, DSH_HOME: dshHome, WTT_COURSE_WORKSPACE: realWorkspace,
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
  npm_config_registry: 'https://registry.npmjs.org', npm_config_cache: path.join(project, '.runtime/npm-cache'),
  npm_config_store_dir: path.join(project, '.runtime/pnpm-store'),
};
const profileManifest = path.join(dshHome, 'profiles/web/package.json');
let installed = false;
if (existsSync(profileManifest)) {
  const manifest = JSON.parse(readFileSync(profileManifest, 'utf8'));
  installed = existsSync(path.join(dshHome, 'profiles/web/node_modules/@wtt/dsh-creation-workbench/package.json'))
    && Boolean(manifest.dependencies?.['@wtt/dsh-creation-workbench'])
    && (manifest.dsh?.profile?.bundles || []).includes('@wtt/dsh-creation-workbench');
}
const runtimeFlags = process.versions.node.startsWith('23.') ? ['--experimental-sqlite'] : [];
if (!installed) {
  console.log('将 WTT 创作工作台安装到隔离 DSH profile…');
  const install = spawnSync(process.execPath, [...runtimeFlags, cli, 'plugin', '--profile', 'web', 'add', project],
    { env, cwd: realWorkspace, stdio: 'inherit' });
  if (install.error) throw install.error;
  if (install.status !== 0) process.exit(install.status || 1);
}
if (args.includes('--install-only')) process.exit(0);
console.log(`工作目录：${realWorkspace}`);
const launchArgs = [...runtimeFlags, cli, 'web'];
if (value('--port')) launchArgs.push('--port', value('--port'));
if (args.includes('--no-open')) launchArgs.push('--no-open');
const child = spawn(process.execPath, launchArgs, { env, cwd: realWorkspace, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code || 0; });
