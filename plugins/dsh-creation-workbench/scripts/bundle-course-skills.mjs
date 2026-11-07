import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(project, 'resources', 'course-capabilities');
const names = ['wtt-course-eight-steps-dev', 'wtt-course-pptx-generator', 'wtt-course-pptx-builder', 'wtt-course-exercise-builder',
  'wtt-course-scriptwriter', 'wtt-course-model-architect', 'wtt-course-game-designer', 'wtt-course-knowledge-question-answer',
  'wtt-course-pptx-instructor-manual', 'wtt-course-pptx-student-manual', 'wtt-markdown-to-docx'];
if (existsSync(path.join(destination, 'manifest.json'))) throw new Error('能力包已冻结；升级时创建新版本清单，不覆盖已冻结来源');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const allowed = new Set(['.md', '.py', '.json', '.jsonl', '.svg', '.html', '.css', '.js', '.mjs', '.yaml', '.yml', '.txt', '.docx']);
const manifest = { version: '2026.11.03.2', use: '当前用户本地课程插件，未公开发布', skills: [], files: [] };
for (const name of names) {
  const source = realpathSync(path.join(os.homedir(), '.codex/skills', name));
  const builtinName = `${name}-builtin`, target = path.join(destination, builtinName);
  const roots = ['SKILL.md', 'requirements.txt', 'scripts', 'references', 'assets', 'games', 'workflows'];
  if (name === 'wtt-course-pptx-builder') roots.push('templates/layouts', 'templates/charts', 'templates/icons/tabler-filled', 'templates/spec_lock_reference.md', 'templates/design_spec_reference.md', 'templates/design_system_reference.md', 'templates/chart_selection_reference.json');
  function copy(relative) {
    const from = path.join(source, relative);
    if (!existsSync(from)) return;
    if (relative.split('/').some(part => part.startsWith('.') || ['__pycache__', 'node_modules', 'venv', 'output', 'outputs', 'ai-image-comparison', 'image-renderings'].includes(part)) || path.basename(relative).startsWith('test_')) return;
    if (statSync(from).isDirectory()) { for (const entry of readdirSync(from)) copy(`${relative}/${entry}`); return; }
    if (!allowed.has(path.extname(from).toLowerCase()) || /^(config\.json|.*credentials.*|.*session.*\.json)$/i.test(path.basename(from))) return;
    if (realpathSync(from) !== from) throw new Error(`能力包资源含链接，需人工核对：${name}/${relative}`);
    const bytes = readFileSync(from);
    if (bytes.length > 5 * 1024 * 1024) throw new Error(`资源超过通用能力包限制：${name}/${relative}`);
    const to = path.join(target, relative); mkdirSync(path.dirname(to), { recursive: true });
    if (relative === 'SKILL.md') {
      let body = bytes.toString('utf8').replace(/^name:\s*.+$/m, `name: ${builtinName}`);
      body += '\n\n## 课程工作台内置版本\n\n本包是独立冻结副本，资源以本 SKILL.md 所在目录解析。原本机绝对路径不是当前机器存在的证明；外部知识库、认证与企业模板须由用户配置，不复制或猜测。沿用正文确认门；执行阶段以工作台冻结任务为准。\n';
      writeFileSync(to, body);
    } else copyFileSync(from, to);
    manifest.files.push({ skill: builtinName, path: `${builtinName}/${relative}`, sourceHash: hash(bytes), hash: hash(readFileSync(to)) });
  }
  for (const relative of roots) copy(relative);
  manifest.skills.push({ sourceName: name, name: builtinName, path: `${builtinName}/SKILL.md`, source: '用户本机课程技能冻结副本', sourceHash: hash(readFileSync(path.join(source, 'SKILL.md'))) });
}
mkdirSync(destination, { recursive: true });
// 图标由已核对的 MIT 资产提供；升级前保留并核对完整版权文本。
const notice = path.join(destination, 'THIRD_PARTY_NOTICES.md');
if (!existsSync(notice)) throw new Error('冻结前请放入已核对的第三方版权声明 THIRD_PARTY_NOTICES.md');
manifest.thirdParty = [{ name: 'Tabler Filled icons', license: 'MIT', notice: 'THIRD_PARTY_NOTICES.md', source: 'https://github.com/tabler/tabler-icons' }];
writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`已冻结 ${manifest.skills.length} 项内置课程技能、${manifest.files.length} 个资源；未包含知识库、账号配置或企业模板。`);
