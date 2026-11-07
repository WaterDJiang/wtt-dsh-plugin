import { build } from 'esbuild';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
for(const file of ['word-editor.js','word-editor.css'])await rm(new URL(`../dist/${file}`,import.meta.url),{force:true});
const clientBuild=await build({
  entryPoints: ['src/client.jsx'], bundle: true, format: 'cjs', target: 'es2022',
  external: ['@deepseek-ai/dsh-client-ui-sidebar-documentpreview', 'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'], outfile: 'dist/client.cjs',
  minify: false, legalComments: 'inline', metafile:true,
});
const packages=new Set();
for(const file of Object.keys(clientBuild.metafile.inputs)){
  const index=file.lastIndexOf('node_modules/');if(index<0)continue;
  const parts=file.slice(index+13).split('/'),count=parts[0].startsWith('@')?2:1;
  packages.add(file.slice(0,index+13)+parts.slice(0,count).join('/'));
}
let notices='本地文本编辑器及前端依赖声明\nWord／PDF／CSV 使用本机应用编辑；本包不再包含 SuperDoc。\nTiptap 继续用于文本／Markdown 快速编辑。\n\n';
for(const directory of [...packages].sort()){
  const metadata=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
  notices+=`\n===== ${metadata.name} ${metadata.version} (${JSON.stringify(metadata.license||'见上游许可')}) =====\n`;
  for(const file of await readdir(directory))if(/^(licen[cs]e|copying|notice)(\.|$)/i.test(file)){
    const contents=await readFile(path.join(directory,file),'utf8').catch(()=>null);if(contents)notices+=`\n${file}\n${contents}\n`;
  }
}
await writeFile('dist/third-party-notices.txt',notices);
const script = await readFile(new URL('../dist/client.cjs', import.meta.url), 'utf8');
const css = await readFile(new URL('../dist/client.css', import.meta.url), 'utf8').catch(() => '');
// DSH owns module identity and activation. Styles belong to this plugin's effect lifetime.
const style = `\nconst originalExports = module.exports; const plugin = { ...originalExports, apply: (ctx) => { ctx.effect(() => { const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style); return () => style.remove(); }); return originalExports.apply(ctx); } };\n`;
await writeFile(new URL('../dist/client.js', import.meta.url),
  `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${script}\n${style}\nreturn plugin;}});\n`);
console.log(`已构建 ${manifest.name}：dist/client.js`);
