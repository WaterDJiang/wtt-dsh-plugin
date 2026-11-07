// 校验插件市场索引（format 1）。用法：node scripts/validate-market-index.mjs [market/index.json]
// 校验器来自本地 DSH 安装（.runtime/host）；公开检出未安装时如实退出。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2] ?? 'market/index.json');
const candidates = [
  '@deepseek-ai/dsh-plugin-market-index',
  path.resolve(import.meta.dirname, '../.runtime/host/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js'),
];
let validator = null;
for (const candidate of candidates) {
  try { validator = await import(candidate); break; } catch { /* 尝试下一个候选 */ }
}
if (!validator) {
  console.error('未找到 @deepseek-ai/dsh-plugin-market-index：请先按 README「干净检出」安装 .runtime/host 再校验。');
  process.exit(1);
}
const value = JSON.parse(readFileSync(file, 'utf8'));
const parsed = validator.parseMarketIndex(value, 'https://example.invalid/market/index.json');
for (const plugin of parsed.plugins) {
  console.log(`${plugin.name}「${plugin.title?.zh ?? plugin.title?.en ?? ''}」versions: ${plugin.versions.map(v => v.version).join(', ')}`);
  if (!plugin.metadata.keywords.length) console.warn(`警告：${plugin.name} 未设置 keywords，市场文本搜索将难以命中`);
}
console.log(`市场索引校验通过（format 1）：${parsed.plugins.length} 个插件。`);
