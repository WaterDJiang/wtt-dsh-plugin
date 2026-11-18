import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const rootIndex = '# 项目记忆\n\n- [现行设定](spec/INDEX.md)\n- [委托与计划](plan/INDEX.md)\n- [日志与成果依据](log/INDEX.md)\n';
const short = (value, limit) => typeof value === 'string' && value.trim() && value.length <= limit && !value.includes('\0');
const escapeLabel = value => String(value).replace(/[\r\n[\]]/g, ' ');
const linkFor = row => 'log/' + row.day + '.md#e-' + hash(row.id).slice(0,24);
function safePath(root, relative, create = true) {
  const parts = ('.wtt-workbench/memory/' + relative).split('/');
  if (parts.some(part => !part || ['.','..'].includes(part) || part.includes('\\'))) throw Error('记忆文件路径无效');
  let current = root;
  for (const part of parts.slice(0,-1)) {
    current = path.join(current, part);
    if (!existsSync(current) && create) mkdirSync(current, {mode:0o700});
    if (!lstatSync(current).isDirectory()) throw Error('项目记忆目录必须是项目内的普通目录');
  }
  const target = path.join(current, parts.at(-1));
  if (existsSync(target) && !lstatSync(target).isFile()) throw Error('记忆原文必须是普通文件');
  return target;
}
function read(file, limit = 32768) {
  if(!lstatSync(file).isFile())throw Error('记忆原文必须是普通文件');
  const fd = openSync(file, constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK);
  try { const stat=fstatSync(fd);if (!stat.isFile()||stat.size > limit) throw Error('设定原文超过大小限制'); return readFileSync(fd,'utf8'); }
  finally { closeSync(fd); }
}
function existingDocument(root,relative) {
  if (!short(relative,500)||path.isAbsolute(relative)||!relative.endsWith('.md')||relative.includes('\\')||
      relative.split('/').some(s=>!s||s.startsWith('.'))||['AGENTS.MD','CLAUDE.MD','INDEX.MD'].includes(path.basename(relative).toUpperCase())) throw Error('请选择项目内的独立 Markdown 设定文件');
  let current=root;
  const parts=relative.split('/');
  for (const part of parts.slice(0,-1)){current=path.join(current,part);if(!lstatSync(current).isDirectory())throw Error('设定文件的父目录不能是链接');}
  return path.join(current,parts.at(-1));
}
function write(root,relative,body){atomicFile(safePath(root,relative),body);}
function atomicFile(file,body) {
  const tmp = file + '.tmp-' + randomUUID();
  try { writeFileSync(tmp, body, {flag:'wx',mode:existsSync(file)?lstatSync(file).mode & 0o777:0o600}); renameSync(tmp,file); }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
const localDay=(d=new Date())=>{return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');};
const versionSelect = `SELECT 'version-'||v.id,date(v.created_at,'localtime'), '成果版本',c.title||' V'||v.number,
  '成果版本，已登记主产物 '||v.primary_ref, json_object('requirementId',c.requirement_id,'cardId',c.id,'versionId',v.id,'taskId',v.task_id,'hash',coalesce(f.hash,o.hash),'path',coalesce(f.path,o.markdown_path))
  FROM output_card_versions v JOIN output_cards c ON c.id=v.card_id
  LEFT JOIN task_files f ON v.primary_ref LIKE 'artifact:%' AND f.id=substr(v.primary_ref,10)
  LEFT JOIN outline_versions o ON v.primary_ref LIKE 'outline:%' AND o.id=substr(v.primary_ref,9)`;

// A trailing pair of spaces also indexes the final one or two characters.
const shortText = prefix => ['kind','title','body','evidence'].map(field=>prefix+field).join('||')+"||'  '";
function ensureShortIndex(db){
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='pa_short_vocab'").get())return;
  db.exec('BEGIN IMMEDIATE');
  try{
    if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='pa_short_vocab'").get()){
      db.exec(`CREATE VIRTUAL TABLE pa_short_fts USING fts5(terms,tokenize='trigram',content='',detail=none,columnsize=0);
        CREATE VIRTUAL TABLE pa_short_vocab USING fts5vocab(pa_short_fts,'instance');
        CREATE TRIGGER pa_index_short AFTER INSERT ON pa_events BEGIN
          INSERT INTO pa_short_fts(rowid,terms) VALUES(new.rowid,${shortText('new.')}); END;
        INSERT INTO pa_short_fts(rowid,terms) SELECT rowid,${shortText('')} FROM pa_events;`);
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export class ProjectMemory {
  constructor(service) {
    this.db = service.store.db;
    this.root = service.workspaceRoot;
    const db = this.db;
    db.exec(`CREATE TABLE IF NOT EXISTS pa_events(id TEXT UNIQUE NOT NULL,day TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,evidence TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pa_event_day ON pa_events(day);
      CREATE TABLE IF NOT EXISTS pa_settings(id TEXT PRIMARY KEY,name TEXT NOT NULL,scope TEXT NOT NULL,rev TEXT, UNIQUE(name,scope));
      CREATE VIRTUAL TABLE IF NOT EXISTS pa_search USING fts5(title,body,evidence,content='pa_events',content_rowid='rowid',tokenize='trigram');
      CREATE TABLE IF NOT EXISTS pa_dirty_days(day TEXT PRIMARY KEY);
      CREATE TRIGGER IF NOT EXISTS pa_index_event AFTER INSERT ON pa_events BEGIN
        INSERT INTO pa_search(rowid,title,body,evidence) VALUES(new.rowid,new.title,new.body,new.evidence);
        INSERT OR IGNORE INTO pa_dirty_days VALUES(new.day); END;
      CREATE TRIGGER IF NOT EXISTS pa_index_version AFTER INSERT ON output_card_versions BEGIN
        INSERT OR IGNORE INTO pa_events ${versionSelect} WHERE v.id=new.id; END;`);
    if(!db.prepare('PRAGMA table_info(pa_settings)').all().some(c=>c.name==='document'))db.exec('ALTER TABLE pa_settings ADD COLUMN document TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS pa_setting_document ON pa_settings(document) WHERE document IS NOT NULL');
    db.exec('INSERT OR IGNORE INTO pa_events ' + versionSelect);
    ensureShortIndex(db);
  }
  event(id, kind, title, body = '', evidence = {}, day = localDay()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !short(title, 240) || body.length > 6000) throw Error('项目日志内容超出限制');
    this.db.prepare('INSERT OR IGNORE INTO pa_events VALUES(?,?,?,?,?,?)').run(id,day,kind,title,body,JSON.stringify(evidence));
  }
  setting(row) {
    const relative = row.document || 'spec/' + row.id + '.md';
    let body = '', missing = false;
    try { body = read(row.document?existingDocument(this.root,relative):safePath(this.root,relative)); } catch (e) { if (e.code !== 'ENOENT') throw e; missing = true; }
    const revision = missing ? null : hash(body);
    if (row.rev !== revision) {
      this.event('setting-'+randomUUID(),'设定',row.name, missing ? '原文已移除' : body.slice(0,1200),{scope:row.scope,relative,revision});
      this.db.prepare('UPDATE pa_settings SET rev=? WHERE id=?').run(revision,row.id);
    }
    return { id:row.id,name:row.name,scope:row.scope,body,revision,relative,document:row.document||null,missing };
  }
  settings() { return this.db.prepare('SELECT * FROM pa_settings ORDER BY name,scope').all().map(row=>this.setting(row)); }
  bind({name,scope='项目',document}) {
    if(!short(name,80)||!short(scope,120))throw Error('请填写设定名称和范围');
    name=name.trim();scope=scope.trim();
    const body=read(existingDocument(this.root,document));
    if(!short(body,4000))throw Error('请选择 1–4000 字的独立设定文件');
    const id=hash(JSON.stringify([name,scope])).slice(0,32);
    const existing=this.db.prepare('SELECT * FROM pa_settings WHERE id=? OR document=?').get(id,document);
    if(existing&&(!this.setting(existing).missing||existing.document))throw Error('该设定名称或原文已绑定，请先核对现行设定');
    this.db.prepare('INSERT INTO pa_settings(id,name,scope,document) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document').run(id,name,scope,document);
    const setting=this.setting(this.db.prepare('SELECT * FROM pa_settings WHERE id=?').get(id));
    this.project(); return {setting};
  }
  save({name, scope='项目', body, baseRevision=null}) {
    if (!short(name,80) || !short(scope,120) || typeof body !== 'string' || body.length > 4000) throw Error('设定名称、范围或正文无效（正文最多 4000 字）');
    name=name.trim(); scope=scope.trim();
    const id = hash(JSON.stringify([name,scope])).slice(0,32);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO pa_settings(id,name,scope) VALUES(?,?,?)').run(id,name,scope);
      const current = this.setting(this.db.prepare('SELECT * FROM pa_settings WHERE id=?').get(id));
      if (current.revision !== baseRevision) { this.db.exec('COMMIT'); return { conflict:true,current }; }
      if(current.document&&!body.trim()){
        this.db.prepare('DELETE FROM pa_settings WHERE id=?').run(id);
        this.event('remove-'+randomUUID(),'设定',name,'已解除原文绑定',{scope,relative:current.document});
        this.db.exec('COMMIT');this.project();return {removed:true};
      }
      if(current.document)atomicFile(existingDocument(this.root,current.document),body);
      else if (body.trim()) write(this.root,current.relative,body.trim()+'\n');
      else if (!current.missing) unlinkSync(safePath(this.root,current.relative));
      const result=this.setting({...current,rev:current.revision});
      this.db.exec('COMMIT');
      this.project();
      return {setting:result};
    } catch (e) { if(this.db.isTransaction)this.db.exec('ROLLBACK'); throw e; }
  }
  effective(scopes=[]) {
    const rank=['项目',...new Set(scopes.filter(s=>s!=='项目'))], winners=new Map();
    for (const scope of rank) for (const row of this.db.prepare('SELECT * FROM pa_settings WHERE scope=? ORDER BY name').all(scope)) {
      const item=this.setting(row);
      if(item.missing&&row.document)throw Error('设定原文已缺失：'+row.document);
      if(!item.missing && item.body.trim()) winners.set(item.name,item);
    }
    const values=[...winners.values()];
    if (values.reduce((n,s)=>n+s.body.length,0)>7500) throw Error('适用设定超过 7500 字，请在项目记忆中缩小范围');
    return values;
  }
  entry(id) {
    const row=this.db.prepare('SELECT * FROM pa_events WHERE id=?').get(id);
    if(!row)throw Error('找不到项目日志原文');
    return {...row,evidence:JSON.parse(row.evidence),relative:linkFor(row)};
  }
  search(query='', filters={}) {
    let q=String(query).trim().slice(0,200);
    const conditions=[], params=[];
    for(const field of ['requirementId','cardId','versionId','taskId','planId']){
      if(!filters[field])continue;
      conditions.push("json_extract(e.evidence,'$."+field+"')=?");
      params.push(String(filters[field]));
    }
    const date=q.match(/\d{4}-\d{2}(?:-\d{2})?|上个月|这个月|上月|本月|昨天|今天/);
    if(date){
      const term=date[0], now=new Date();
      let prefix=term;
      if(!/^\d/.test(term)){
        if(term==='昨天')now.setDate(now.getDate()-1);
        if(['上个月','上月'].includes(term)){now.setDate(1);now.setMonth(now.getMonth()-1);}
        prefix=localDay(now).slice(0,term.includes('月')?7:10);
      }
      conditions.push('e.day LIKE ?');params.push(prefix+'%');
      q=q.replace(term,'').trim();
    }
    const where=conditions.length?' AND '+conditions.join(' AND '):'';
    let rows;
    if(!q) rows=this.db.prepare('SELECT e.* FROM pa_events e WHERE 1'+where+' ORDER BY e.day DESC,e.rowid DESC LIMIT 15').all(...params);
    else {
      const words=q.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu)||[q];
      const aliases=[];
      if(/能播|能放/u.test(q))aliases.push('可播放');
      if(/加不到引用|引用不了|引用不到/u.test(q))aliases.push('无法引用');
      if(/拖不动|不能快进/u.test(q))aliases.push('时间条','播放定位');
      const terms=[...new Set([q.toLowerCase(),...aliases,...words,...words.flatMap(s=>/\p{Script=Han}/u.test(s)&&s.length>2?Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)):[])])].slice(0,30);
      const longer=terms.filter(t=>t.length>=3);
      const hits=longer.length?this.db.prepare('SELECT e.*,rank FROM pa_search f JOIN pa_events e ON e.rowid=f.rowid WHERE pa_search MATCH ?'+where+' ORDER BY rank LIMIT 60').all(longer.map(t=>'"'+t.replaceAll('"','""')+'"').join(' OR '),...params):[];
      const small=terms.filter(t=>t.length<3);
      // Each vocabulary row identifies a matching event. Prefix bounds use the FTS vocabulary index.
      const prefixes=small.map(()=>'SELECT doc FROM pa_short_vocab WHERE term>=? AND term<?');
      const bounds=small.flatMap(t=>[t,t+'\u{10ffff}\u{10ffff}\u{10ffff}']);
      const partial=small.length?this.db.prepare('SELECT e.* FROM pa_events e WHERE e.rowid IN ('+prefixes.join(' UNION ALL ')+')'+where+' ORDER BY e.rowid DESC LIMIT 100').all(...bounds,...params):[];
      const score=row=>terms.reduce((v,t)=>v+(row.kind+' '+row.title+' '+row.body+' '+row.evidence).toLowerCase().includes(t)*(t===q.toLowerCase()?50:t.length),0);
      rows=[...new Map([...hits,...partial].map(r=>[r.id,r])).values()].sort((a,b)=>score(b)-score(a)||b.day.localeCompare(a.day)).slice(0,15);
    }
    return rows.map(r=>({id:r.id,day:r.day,kind:r.kind,title:r.title,body:r.body.slice(0,1600),evidence:JSON.parse(r.evidence),relative:linkFor(r)}));
  }
  project({rebuild=false}={}) {
    if(rebuild) {
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec(`INSERT INTO pa_search(pa_search) VALUES('rebuild');
          INSERT INTO pa_short_fts(pa_short_fts) VALUES('delete-all');
          INSERT INTO pa_short_fts(rowid,terms) SELECT rowid,${shortText('')} FROM pa_events;
          INSERT OR IGNORE INTO pa_dirty_days SELECT DISTINCT day FROM pa_events;`);
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
      this.settings();
    }
    const dirty=this.db.prepare('SELECT day FROM pa_dirty_days ORDER BY day').all();
    if(!dirty.length && !rebuild && existsSync(safePath(this.root,'INDEX.md')))return;
    for(const {day} of dirty){
      const rows=this.db.prepare('SELECT rowid,* FROM pa_events WHERE day=? ORDER BY rowid').all(day);
      write(this.root,'log/'+day+'.md','# '+day+'\n'+rows.map(r=>'\n<a id="'+linkFor(r).split('#')[1]+'"></a>\n## '+escapeLabel(r.title)+'\n\n'+r.kind+' · '+r.body+'\n\n依据 '+r.evidence+'\n').join(''));
    }
    const months=this.db.prepare('SELECT DISTINCT substr(day,1,7) AS month FROM pa_events ORDER BY month DESC').all();
    for(const month of new Set(dirty.map(r=>r.day.slice(0,7)))){
      const entries=this.db.prepare('SELECT * FROM pa_events WHERE day LIKE ? ORDER BY day DESC,rowid DESC').all(month+'%');
      write(this.root,'log/'+month+'.md','# '+month+'\n\n'+entries.map(r=>'- ['+escapeLabel(r.title)+']('+linkFor(r).slice(4)+')').join('\n')+'\n');
    }
    write(this.root,'log/INDEX.md','# 日志\n\n'+months.map(({month})=>'- ['+month+']('+month+'.md)').join('\n')+'\n');
    const settings=this.db.prepare('SELECT * FROM pa_settings WHERE rev IS NOT NULL ORDER BY scope,name').all();
    write(this.root,'spec/INDEX.md','# 现行设定\n\n'+settings.map(r=>'- ['+escapeLabel(r.name)+' · '+escapeLabel(r.scope)+']('+(r.document?'../../../'+r.document.split('/').map(encodeURIComponent).join('/'):r.id+'.md')+')').join('\n')+'\n');
    const plans=this.db.prepare("SELECT * FROM pa_events WHERE kind='委托' ORDER BY rowid DESC LIMIT 40").all();
    write(this.root,'plan/INDEX.md','# 委托与计划\n\n'+plans.map(r=>'- ['+escapeLabel(r.title)+'](../'+linkFor(r)+')').join('\n')+'\n');
    const recent=this.db.prepare('SELECT * FROM pa_events ORDER BY rowid DESC LIMIT 5').all();
    const active=this.db.prepare("SELECT p.id,p.title FROM pa_plans p WHERE p.state NOT IN ('done','stopped') ORDER BY p.rowid DESC LIMIT 10").all();
    const link=r=>'- ['+escapeLabel(r.title)+']('+linkFor(r)+')';
    const current=active.map(p=>this.db.prepare('SELECT * FROM pa_events WHERE id=?').get('plan-'+p.id)).filter(Boolean);
    write(this.root,'INDEX.md',rootIndex+(current.length?'\n## 当前委托\n\n'+current.map(link).join('\n')+'\n':'')+(recent.length?'\n## 最近记录\n\n'+recent.map(link).join('\n')+'\n':''));
    for(const {day} of dirty)this.db.prepare('DELETE FROM pa_dirty_days WHERE day=?').run(day);
  }
}
