import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function registerWorkbenchSkills(ctx) {
  const file = realpathSync(fileURLToPath(new URL('../skills/wtt-creation-workbench/SKILL.md', import.meta.url)));
  const content = readFileSync(file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  ctx.effect(() => ctx.skills.register({ name: 'wtt-creation-workbench', description: '创作工作台内部工具协议。', content,
    path: file, source: 'runtime', resourceBase: { kind: 'directory', path: path.dirname(file) } }));
}
