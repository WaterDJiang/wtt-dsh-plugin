import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const sha = value => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['node_modules','.git','.wtt-workbench','.Trash','回收站','backup','exports']);
const MAX_BYTES = 209_715_200;
export class SvgDeckSources {
  constructor(service) {
    this.service=service; this.root=realpathSync(service.workspaceRoot); this.db=service.store.db;
    this.helper=fileURLToPath(new URL('./svg-editor.py',import.meta.url)); this.children=new Set(); this.closed=false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS svg_deck_snapshots(id TEXT PRIMARY KEY,path TEXT NOT NULL,tree_hash TEXT NOT NULL,model_json TEXT NOT NULL,origin_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS svg_deck_bindings(artifact_id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL REFERENCES svg_deck_snapshots(id));
      CREATE TABLE IF NOT EXISTS svg_deck_previews(draft_id TEXT NOT NULL,revision INTEGER NOT NULL,pages_json TEXT NOT NULL,PRIMARY KEY(draft_id,revision));
      CREATE TABLE IF NOT EXISTS svg_deck_exports(draft_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot_id TEXT NOT NULL REFERENCES svg_deck_snapshots(id),PRIMARY KEY(draft_id,revision));`);
  }
  file(relative) {
    if(this.closed) throw new Error('SVG编辑服务已关闭');
    const target=path.resolve(this.root,relative);
    if((target!==this.root&&!target.startsWith(this.root+path.sep))||realpathSync(target)!==target) throw new Error('SVG工程路径超出项目或使用符号链接');
    return target;
  }
  directory(relative) {
    let current=this.root;
    for(const part of relative.split('/')) {
      if(!part||part==='.'||part==='..') throw new Error('SVG快照目录无效');
      current=path.join(current,part); if(!existsSync(current)) mkdirSync(current,{mode:0o700});
      if(lstatSync(current).isSymbolicLink()||!lstatSync(current).isDirectory()||realpathSync(current)!==current) throw new Error('SVG快照目录不能使用链接');
    }
    return current;
  }
  entries(directory,{copy=false}={}) {
    const result=[];let size=0,count=0;
    const walk=(dir,depth)=>{
      if(depth>16) throw new Error('SVG工程目录层级超过16层');
      for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
        if(++count>12000) throw new Error('SVG工程文件数量超过12000');
        if(e.name.startsWith('.')||excluded.has(e.name)||(copy&&e.name==='svg_output'&&existsSync(path.join(directory,'svg_final'))))continue;
        const file=path.join(dir,e.name);
        if(e.isSymbolicLink()) throw new Error('SVG工程含符号链接，请使用独立真实文件');
        if(e.isDirectory()) walk(file,depth+1);
        else if(e.isFile()) {const bytes=readFileSync(this.file(path.relative(this.root,file)));size+=bytes.length;
          if(size>MAX_BYTES)throw new Error('SVG工程超过200MB');
          result.push({name:path.relative(directory,file),hash:sha(bytes),bytes});}
      }
    };walk(directory,0);return result;
  }
  tree(entries) {return sha(JSON.stringify(entries.map(({name,hash})=>[name,hash])));}
  row(id) {
    const row=this.db.prepare('SELECT * FROM svg_deck_snapshots WHERE id=?').get(String(id));
    if(!row) throw new Error('SVG源稿快照不存在');
    if(this.tree(this.entries(this.file(row.path)))!==row.tree_hash)throw new Error('SVG工程快照已被外部修改，未继续编辑');
    return row;
  }
  validate(scope) {
    const row=this.row(scope.svgSourceId), origin=JSON.parse(row.origin_json);
    const binding=this.db.prepare('SELECT snapshot_id FROM svg_deck_bindings WHERE artifact_id=?').get(scope.artifactId);
    if(binding?.snapshot_id!==row.id&&(origin.artifactId!==scope.artifactId||origin.hash!==scope.hash))throw new Error('SVG源稿不属于所选PPTX');
    return row;
  }
  async discover(scope) {
    this.service.deck.validateScope(scope);
    const bound=this.db.prepare('SELECT snapshot_id FROM svg_deck_bindings WHERE artifact_id=?').get(scope.artifactId);
    if(bound) {const row=this.row(bound.snapshot_id);return {status:'matched',candidates:[{id:`snapshot:${row.id}`,path:JSON.parse(row.origin_json).project||row.path,pageCount:JSON.parse(row.model_json).slides.length}]};}
    const candidates=[];let count=0,hashed=0;
    const walk=(dir,depth)=>{
      if(depth>12)throw new Error('源工程查找超过12层，请将工程放在项目内较浅位置');
      const entries=readdirSync(dir,{withFileTypes:true});
      const hasSvg=entries.some(e=>e.isDirectory()&&['svg_final','svg_output'].includes(e.name));
      if(hasSvg) {
        const exports=path.join(dir,'exports');
        if(existsSync(exports)&&!lstatSync(exports).isSymbolicLink()&&lstatSync(exports).isDirectory())for(const e of readdirSync(exports,{withFileTypes:true})) {
          if(!e.isFile()||!e.name.toLowerCase().endsWith('.pptx'))continue;
          const relative=path.relative(this.root,path.join(exports,e.name)),file=this.file(relative),size=lstatSync(file).size;
          hashed+=size;if(size>MAX_BYTES||hashed>MAX_BYTES*4)throw new Error('源工程导出文件超过查找上限');
          if(sha(readFileSync(file))===scope.hash){const relativeRoot=path.relative(this.root,dir);candidates.push({id:sha(relativeRoot+'\0'+relative+'\0'+scope.hash),path:relativeRoot,exportPath:relative});break;}
        }
      }
      for(const e of entries) {
        if(++count>30000)throw new Error('源工程查找超过30000项，请缩小项目范围');
        if(!e.isDirectory()||e.isSymbolicLink()||e.name.startsWith('.')||excluded.has(e.name)||['svg_final','svg_output','templates','images','notes'].includes(e.name))continue;
        walk(path.join(dir,e.name),depth+1);
      }
    };walk(this.root,0);
    return {status:candidates.length===1?'matched':candidates.length?'choose':'none',candidates};
  }
  async resolve({scope,candidateId}) {
    this.service.deck.validateScope(scope);
    const found=await this.discover(scope),candidate=found.candidates.find(c=>c.id===candidateId);
    if(!candidate)throw new Error('SVG源工程候选已变化，请重新选择');
    let id;
    if(candidate.id.startsWith('snapshot:'))id=candidate.id.slice(9);
    else {
      const source=this.file(candidate.path),entries=this.entries(source,{copy:true});
      const origin={artifactId:scope.artifactId,hash:scope.hash,project:candidate.path,exportPath:candidate.exportPath};
      const treeHash=this.tree(entries);
      const existing=this.db.prepare('SELECT id FROM svg_deck_snapshots WHERE tree_hash=? AND origin_json=?').get(treeHash,JSON.stringify(origin));
      if(existing) {this.row(existing.id);id=existing.id;}
      else {
        id=randomUUID();const relative=`.wtt-workbench/svg-decks/${id}/project`,directory=this.directory(relative);
        for(const e of entries){const output=path.join(directory,e.name);this.directory(path.relative(this.root,path.dirname(output)));writeFileSync(output,e.bytes,{flag:'wx',mode:0o600});}
        if(this.tree(this.entries(source,{copy:true}))!==treeHash||sha(readFileSync(this.file(candidate.exportPath)))!==scope.hash)throw new Error('复制期间SVG源工程发生变化，请重新打开');
        const model=await this.run(['inspect',directory]);
        this.db.prepare('INSERT INTO svg_deck_snapshots VALUES (?,?,?,?,?)').run(id,relative,treeHash,JSON.stringify(model),JSON.stringify(origin));
      }
    }
    return {...scope,svgSourceId:id};
  }
  async upgradeModel(sourceId){
    const row=this.row(sourceId);if(JSON.parse(row.model_json).svgModelVersion===2)return;
    const model=await this.run(['inspect',this.file(row.path)]);this.row(sourceId);
    this.db.prepare('UPDATE svg_deck_snapshots SET model_json=? WHERE id=? AND model_json=?').run(JSON.stringify(model),row.id,row.model_json);
  }
  async open(input) { return this.service.deck.open(await this.resolve(input)); }
  model(scope) {return JSON.parse(this.validate(scope).model_json);}
  run(args,input,timeout=60000) {
    if(this.closed)throw new Error('SVG编辑服务已关闭');
    return new Promise((resolve,reject)=>{
      const child=spawn(this.service.python,[this.helper,...args],{cwd:this.root,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});
      this.children.add(child);let stdout='',stderr='',error;
      const timer=setTimeout(()=>{error=new Error('SVG操作超过60秒');child.kill('SIGTERM');},timeout);
      child.stdout.on('data',c=>{stdout+=c;if(stdout.length>(args[0]==='preview'?64_000_000:10_000_000)){error=new Error('SVG输出过大');child.kill('SIGTERM');}});
      child.stderr.on('data',c=>{stderr+=c;if(stderr.length>30000)child.kill('SIGTERM');});
      child.on('error',e=>{error=e;});child.stdin.on('error',e=>{if(e.code!=='EPIPE')error=e;});
      child.on('close',code=>{clearTimeout(timer);this.children.delete(child);if(error||code!==0)return reject(new Error(`SVG适配失败：${error?.message||stderr.trim()||code}`));try{resolve(JSON.parse(stdout));}catch(e){reject(e);}});
      child.stdin.end(input?JSON.stringify(input):'');
    });
  }
  rememberPreview(row,revision) {
    const existing=this.db.prepare('SELECT pages_json FROM svg_deck_previews WHERE draft_id=? AND revision=?').get(row.id,revision);
    if(existing&&existing.pages_json!==row.pages_json)throw new Error('SVG预览修订号重复，未覆盖已有预览');
    if(!existing)this.db.prepare('INSERT INTO svg_deck_previews VALUES (?,?,?)').run(row.id,revision,row.pages_json);
  }
  previewPages(draftId,revision) {
    const row=this.db.prepare('SELECT pages_json FROM svg_deck_previews WHERE draft_id=? AND revision=?').get(draftId,revision);
    if(!row)throw new Error('SVG预览修订不存在，请更新预览');return JSON.parse(row.pages_json);
  }
  async preview(scope,pages,page) {
    const row=this.validate(scope); const result=await this.run(['preview',this.file(row.path)],{pages,page});
    this.validate(scope);const bytes=Buffer.from(result.svg);
    return {bytes,mime:'image/svg+xml',name:`page-${page}.svg`,hash:sha(bytes)};
  }
  inScope(scope,sourceId) {
    this.validate(scope);const row=this.row(sourceId),origin=JSON.parse(row.origin_json);
    if(row.id!==scope.svgSourceId&&(origin.basedOn!==scope.svgSourceId||origin.artifactId!==scope.artifactId||origin.hash!==scope.hash))throw new Error('SVG修订不属于当前源文件');
    return row;
  }
  async fork(scope,{sourceId=scope.svgSourceId,operations=[],pages=[],assets=[]}={}) {
    const base=this.inScope(scope,sourceId),id=randomUUID(),relative=`.wtt-workbench/svg-decks/${id}/project`,directory=this.directory(relative);
    for(const e of this.entries(this.file(base.path))){const output=path.join(directory,e.name);this.directory(path.relative(this.root,path.dirname(output)));writeFileSync(output,e.bytes,{flag:'wx',mode:0o600});}
    for(const asset of assets){
      if(!/^[a-zA-Z0-9-]+\.(png|jpg|jpeg|webp)$/.test(asset.filename))throw new Error('SVG引用图片名称无效');
      const file=this.file(asset.path),bytes=readFileSync(file);if(sha(bytes)!==asset.hash)throw new Error('SVG引用图片已变化');
      const image=path.join(this.directory(`${relative}/images`),asset.filename);
      if(existsSync(image)){if(sha(readFileSync(image))!==asset.hash)throw new Error('SVG引用图片名称冲突');}else writeFileSync(image,bytes,{flag:'wx',mode:0o600});
    }
    if(operations.length)await this.run(['revise',directory],{operations});
    if(pages.length)await this.run(['apply',directory],{pages});
    const model=await this.run(['inspect',directory]),original=JSON.parse(base.model_json);
    if(model.width!==original.width||model.height!==original.height)throw new Error('SVG修订不能改变课件尺寸');
    this.inScope(scope,sourceId);
    const origin={...JSON.parse(base.origin_json),artifactId:scope.artifactId,hash:scope.hash,basedOn:scope.svgSourceId,editedFrom:base.id};
    this.db.prepare('INSERT INTO svg_deck_snapshots VALUES (?,?,?,?,?)').run(id,relative,this.tree(this.entries(directory)),JSON.stringify(model),JSON.stringify(origin));
    return this.row(id);
  }
  async previewSnapshot(scope,sourceId,page){
    const row=this.inScope(scope,sourceId),result=await this.run(['preview',this.file(row.path)],{pages:[],page});this.inScope(scope,sourceId);
    const bytes=Buffer.from(result.svg);return {bytes,mime:'image/svg+xml',name:`page-${page}.svg`,hash:sha(bytes)};
  }
  async export(scope,draftId,revision,pages,sourceId) {
    const previous=this.db.prepare('SELECT snapshot_id FROM svg_deck_exports WHERE draft_id=? AND revision=?').get(draftId,revision);
    if(previous){const row=this.row(previous.snapshot_id);return {sourceId:row.id,path:row.path};}
    const base=sourceId?this.inScope(scope,sourceId):this.validate(scope),id=randomUUID(),relative=`.wtt-workbench/svg-decks/${id}/project`,directory=this.directory(relative);
    for(const e of this.entries(this.file(base.path))){const output=path.join(directory,e.name);this.directory(path.relative(this.root,path.dirname(output)));writeFileSync(output,e.bytes,{flag:'wx',mode:0o600});}
    await this.run(['apply',directory],{pages});
    const model=await this.run(['inspect',directory]);
    const origin={...JSON.parse(base.origin_json),artifactId:scope.artifactId,hash:scope.hash,basedOn:scope.svgSourceId,editedFrom:base.id};
    this.db.prepare('INSERT INTO svg_deck_snapshots VALUES (?,?,?,?,?)').run(id,relative,this.tree(this.entries(directory)),JSON.stringify(model),JSON.stringify(origin));
    // Explicit output: the trusted installed converter cannot write into the original project.
    const output=path.join(this.directory(`.wtt-workbench/svg-decks/${id}`),'export.pptx');
    const script=path.join(this.service.pptSkillDir,'scripts/svg_to_pptx.py');
    if(!existsSync(script))throw new Error('未找到本机PPT Builder导出器，请在技能设置中配置');
    if(sourceId||existsSync(path.join(directory,'wtt-svg-pages.json'))) await this.run(['export-native',directory],{script,output},180000);
    else await this.convert(script,directory,output);
    this.validate(scope);this.row(id);
    this.db.prepare('INSERT INTO svg_deck_exports VALUES (?,?,?)').run(draftId,revision,id);
    return {sourceId:id,path:relative,output};
  }
  convert(script,project,output) {
    return new Promise((resolve,reject)=>{
      const source=existsSync(path.join(project,'svg_final'))?'final':'output';
      const child=spawn(this.service.python,['-B',script,project,'-s',source,'-o',output,'--only','native','--no-cache','--quiet'],{cwd:this.root,stdio:['ignore','pipe','pipe']});
      this.children.add(child);let log='',error;const timer=setTimeout(()=>{error=new Error('PPT导出超过180秒');child.kill('SIGTERM');},180000);
      const append=c=>{log+=c;if(log.length>100000){error=new Error('PPT导出日志过大');child.kill('SIGTERM');}};child.stdout.on('data',append);child.stderr.on('data',append);child.on('error',e=>{error=e;});
      child.on('close',code=>{clearTimeout(timer);this.children.delete(child);if(error||code!==0)reject(new Error(`SVG导出PPT失败：${error?.message||log.trim()||code}`));else resolve();});
    });
  }
  recordPublication(artifactId,scope,sourceId) {
    this.validate(scope);
    const row=this.row(sourceId),origin=JSON.parse(row.origin_json);
    if(origin.basedOn!==scope.svgSourceId)throw new Error('SVG成果缺少对应工程快照，未登记正式版本');
    this.db.prepare('INSERT INTO svg_deck_bindings VALUES (?,?)').run(artifactId,row.id);
  }
  close(){this.closed=true;for(const child of this.children)child.kill('SIGTERM');}
}
