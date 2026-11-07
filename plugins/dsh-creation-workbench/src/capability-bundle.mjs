import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
export function environmentCheck(service) {
  const checks = [];
  const modules = spawnSync(service.python, ['-c', 'import sys,json,docx,fitz,pptx,markdown,bs4,reportlab,pypdf;print(json.dumps({"python":sys.version.split()[0]}))'], { encoding: 'utf8', timeout: 15000 });
  checks.push({ name: 'Python 文档与课件依赖', available: modules.status === 0, message: modules.status === 0 ? modules.stdout.trim() : String(modules.stderr || modules.error?.message || 'Python不可用').slice(0, 700) });
  for (const item of service.creationTypes()) checks.push({ name: item.label, available: item.available, message: item.message || '', skills: item.skills });
  checks.push({ name: 'Word 转换器', available: existsSync(path.join(service.wordSkillDir, 'scripts/convert.py')), path: service.wordSkillDir });
  const render = spawnSync(service.python, ['-c', 'import sys,json;sys.path.insert(0,sys.argv[1]);import render_course_pptx as r;print(json.dumps({"office":str(r.resolve_soffice(None) or "")}))', path.join(service.pptSkillDir, 'scripts')], { encoding: 'utf8', timeout: 15000 });
  let office = ''; try { office = JSON.parse(render.stdout).office; } catch { /* Actual failure is reported below. */ }
  checks.push({ name: 'LibreOffice 实际分页渲染', available: render.status === 0 && Boolean(office), message: office || String(render.stderr || '未发现 LibreOffice，PDF仍可预览、DOCX可下载').slice(0, 500) });
  const fontDirectories = process.platform === 'darwin' ? ['/System/Library/Fonts', '/Library/Fonts'] : ['/usr/share/fonts', '/usr/local/share/fonts'];
  checks.push({ name: '系统字体目录', available: fontDirectories.some(existsSync), message: '仅核对真实字体目录；具体中文字形与版式需代表页渲染检查' });
  return { checkedAt: new Date().toISOString(), node: process.version, platform: process.platform, checks,
    fingerprint: createHash('sha256').update(JSON.stringify({ node: process.version, checks })).digest('hex') };
}
