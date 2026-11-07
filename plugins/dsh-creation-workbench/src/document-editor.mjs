import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './service.mjs';
import { DocumentPreview } from './document-preview.mjs';
import { validateArtifact } from './artifact-validation.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const clone = x => JSON.parse(JSON.stringify(x));
const text = x => typeof x === 'string' && !x.includes('\0') && x.length <= 1_000_000;

export class DocumentEditor {
  constructor(service) {
    this.service=service; this.db=service.store.db; this.root=realpathSync(service.workspaceRoot); this.inflight=new Map();
    this.helper=fileURLToPath(new URL('./document-editor.py',import.meta.url));
    this.preview=new DocumentPreview(service);
    this.preview.source=async(ref,hash)=>{
      if (!/^draft:[a-f0-9-]{36}:\d+$/.test(ref||'')) throw new Error('文档草稿预览引用无效');
      const [,id,revision]=ref.split(':'); const file=await this.snapshot(id,Number(revision));
      if (file.hash!==hash) throw new Error('文档草稿预览已变化');
      return {bytes:file.bytes,name:file.path,title:file.title,extension:path.extname(file.path),id,hash,ref};
    };
    this.db.exec(`CREATE TABLE IF NOT EXISTS document_editor_drafts (
      id TEXT PRIMARY KEY,scope_key TEXT UNIQUE,scope_json TEXT NOT NULL,revision INTEGER NOT NULL,
      model_json TEXT NOT NULL,patch_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );CREATE TABLE IF NOT EXISTS document_editor_snapshots (
      draft_id TEXT NOT NULL,revision INTEGER NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(draft_id,revision)
    )`);
  }
  directory(relative) {
    const target=path.resolve(this.root,relative);
    if (!target.startsWith(this.root+path.sep)) throw new Error('文档编辑目录超出当前项目');
    let current=this.root;
    for(const part of path.relative(this.root,target).split(path.sep)) {
      current=path.join(current,part);mkdirSync(current,{recursive:true,mode:0o700});
      if(lstatSync(current).isSymbolicLink()||realpathSync(current)!==current||!lstatSync(current).isDirectory()) throw new Error('文档编辑目录不能使用链接');
    }
    return target;
  }
  read(relative,hash) {
    const target=path.resolve(this.root,relative);
    if(!target.startsWith(this.root+path.sep)||realpathSync(target)!==target||lstatSync(target).isSymbolicLink()||!lstatSync(target).isFile()||lstatSync(target).size>20*1024*1024) throw new Error('文档编辑文件路径或大小无效');
    const bytes=readFileSync(target);if(sha(bytes)!==hash) throw new Error('文档编辑文件已被外部修改');return bytes;
  }
  write(relative,bytes) {
    const file=path.join(this.directory(path.dirname(relative)),path.basename(relative));
    try {writeFileSync(file,bytes,{flag:'wx',mode:0o600});}
    catch(error){if(error.code!=='EEXIST')throw error;this.read(relative,sha(bytes));}
    return file;
  }
  row(id) {
    if(!uuid(id))throw new Error('文档草稿标识无效');
    const row=this.db.prepare('SELECT * FROM document_editor_drafts WHERE id=?').get(id);
    if(!row)throw new Error('文档草稿不存在或不属于当前项目');return row;
  }
  revision(row,revision){if(!Number.isSafeInteger(revision)||revision<0||row.revision!==revision)throw new Error('文档草稿已变化，请保留输入并重新打开');}
  async scope(input) {
    if (input?.outcome === true) return this.service.outcomes.documentScope(input);
    if(!uuid(input?.requirementId)||typeof input.cardId!=='string'||typeof input.sourceRef!=='string'||!/^([a-f0-9]{64})$/.test(input.hash||''))throw new Error('文档对象或版本无效');
    const descriptor=this.service.cards.describe({requirementId:input.requirementId,cardId:input.cardId,...(input.versionId?{versionId:input.versionId}:{})});
    if(descriptor.version.primaryRef!==input.sourceRef)throw new Error('文档卡片与所选版本不匹配');
    const node=descriptor.node;let file;
    if(input.sourceRef.startsWith('material:'))file=this.service.canvas.readImportedFile(node.refId);
    else if(input.sourceRef.startsWith('word:'))file=await this.service.download(node.refId);
    else if(input.sourceRef.startsWith('artifact:')){const r=this.service.tasks.files.read(node.refId);file={bytes:r.bytes,name:r.artifact.path};}
    else throw new Error('此卡片没有可编辑文档文件');
    const expected=node.importedFile?.hash||node.sourceHash;
    if(expected!==input.hash)throw new Error('文档版本已变化，请重新选择');
    const fileHash=sha(file.bytes),extension=path.extname(file.name).toLowerCase();
    if(input.fileHash&&input.fileHash!==fileHash)throw new Error('文档原文件已被外部修改');
    if(!['.csv','.docx','.pdf'].includes(extension)||file.bytes.length>20*1024*1024)throw new Error('首轮编辑支持20MiB以内CSV、DOCX和PDF；DOC请先另存DOCX');
    return {...file,extension,descriptor,title:node.title,scope:{requirementId:input.requirementId,cardId:descriptor.card.id,versionId:descriptor.version.id,sourceRef:input.sourceRef,hash:input.hash,fileHash}};
  }
  value(row) {return {id:row.id,revision:row.revision,scope:JSON.parse(row.scope_json),model:JSON.parse(row.model_json),patch:JSON.parse(row.patch_json),dirty:row.patch_json!=='{}'};}
  async inspect(file) {
    if (path.extname(file).toLowerCase() === '.pptx') {
      const result = await validateArtifact('support', file, readFileSync(file), { pythonExecutable: this.service.python });
      return { format: 'pptx', pages: result.validation.pages };
    }
    return JSON.parse(await runProcess(this.service.python,[this.helper,'inspect',file],{timeout:60000,maxOutputBytes:32_000_000}));
  }
  async open(input) {
    const source=await this.scope(input),key=sha(JSON.stringify(source.scope));
    let row=this.db.prepare('SELECT * FROM document_editor_drafts WHERE scope_key=?').get(key);
    if(!row){
      const id=randomUUID(),base=`.wtt-workbench/document-editor/${id}/base${source.extension}`;
      const model=await this.inspect(this.write(base,source.bytes));await this.scope(source.scope);
      const now=new Date().toISOString();
      this.db.prepare('INSERT OR IGNORE INTO document_editor_drafts VALUES (?,?,?,0,?,?,?,?)').run(id,key,JSON.stringify(source.scope),JSON.stringify(model),'{}',now,now);
      row=this.db.prepare('SELECT * FROM document_editor_drafts WHERE scope_key=?').get(key);
    }
    return this.value(row);
  }
  normalize(model,patch) {
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Buffer.byteLength(JSON.stringify(patch))>1048576)throw new Error('文档草稿格式无效或超过1MB');
    if(model.format==='csv'){
      const rows=patch.rows;if(!Array.isArray(rows)||!rows.length||!Array.isArray(rows[0])||!rows[0].length||rows.length*rows[0].length>10000||rows.some(row=>!Array.isArray(row)||row.length!==rows[0].length||row.some(x=>!text(x))))throw new Error('CSV需为不超过10000单元格的矩形表格');
      return JSON.stringify(rows)===JSON.stringify(model.rows)?{}:{rows};
    }
    if(model.format==='docx'){
      if(!patch.changes||typeof patch.changes!=='object'||Array.isArray(patch.changes))throw new Error('Word文字修改无效');
      const changes={};for(const [id,value] of Object.entries(patch.changes)){
        const object=model.objects.find(o=>o.id===id);if(!object?.editable||!text(value))throw new Error('Word对象不存在、只读或文字无效');
        if(value!==object.text)changes[id]=value;
      }
      return Object.keys(changes).length?{changes}:{};
    }
    const annotations=patch.annotations;
    if(!Array.isArray(annotations)||annotations.length>500)throw new Error('PDF批注最多500条');
    const ids=new Set();for(const a of annotations){
      if(!a||!uuid(a.id)||ids.has(a.id)||!['note','highlight'].includes(a.type)||!text(a.note||'')||!Number.isSafeInteger(a.page)||a.page<1||a.page>model.pages.length)throw new Error('PDF批注标识、页码或类型无效');ids.add(a.id);
      if(a.lineId!==null&&a.lineId!==undefined){const line=model.pages[a.page-1].lines.find(l=>l.id===a.lineId);
        if(!line||!Number.isSafeInteger(a.start)||!Number.isSafeInteger(a.end)||a.start<0||a.end<=a.start||a.end>line.chars.length||a.quote!==line.chars.slice(a.start,a.end).map(c=>c.text).join(''))throw new Error('PDF选中文字或范围已变化');
      }else if(a.type==='highlight'||!(a.note||'').trim())throw new Error('高亮需要选中文字，页面批注需要填写意见');
    }
    return annotations.length?{annotations:clone(annotations)}:{};
  }
  async saveDraft({draftId,revision,patch}) {
    const row=this.row(draftId);this.revision(row,revision);await this.scope(JSON.parse(row.scope_json));
    if(JSON.parse(row.patch_json).documentFile)throw new Error('此文档草稿已由文件编辑更新，请刷新工作台继续，未覆盖修改');
    const normalized=JSON.stringify(this.normalize(JSON.parse(row.model_json),patch));
    if(normalized!==row.patch_json){
      const result=this.db.prepare('UPDATE document_editor_drafts SET patch_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(normalized,new Date().toISOString(),draftId,revision);
      if(result.changes!==1)throw new Error('文档草稿已变化，未覆盖其他修改');
    }
    return this.value(this.row(draftId));
  }
  async saveWordDraft({draftId,revision,bytesBase64,bytes:raw}) {
    return this.saveFileDraft({draftId,revision,bytesBase64,bytes:raw,wordOnly:true});
  }
  async saveFileDraft({draftId,revision,bytesBase64,bytes:raw,wordOnly=false,externalId}) {
    const row=this.row(draftId);this.revision(row,revision);
    const source=await this.scope(JSON.parse(row.scope_json));
    if(wordOnly&&source.extension!=='.docx')throw new Error('连续文档编辑只接收DOCX文件');
    if(raw!==undefined&&!(raw instanceof Uint8Array))throw new Error('Word草稿文件无效');
    if(raw===undefined&&(typeof bytesBase64!=='string'||bytesBase64.length>28_000_000||!bytesBase64.length||bytesBase64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(bytesBase64)))throw new Error('Word草稿文件无效或超过20MiB');
    const bytes=raw===undefined?Buffer.from(bytesBase64,'base64'):Buffer.from(raw);
    if(bytes.length>20*1024*1024)throw new Error('工作稿超过20MiB');
    if(source.extension==='.docx'&&bytes.subarray(0,4).toString('hex')!=='504b0304')throw new Error('Word草稿不是有效DOCX文件');
    const hash=sha(bytes),previous=JSON.parse(row.patch_json);
    if(previous.documentFile?.hash===hash&&!externalId)return this.value(row);
    const relative=`.wtt-workbench/document-editor/${draftId}/rich-${hash}${source.extension}`;
    await this.inspect(this.write(relative,bytes));
    await this.scope(source.scope);
    const patch=JSON.stringify(hash===source.scope.fileHash?{}:{documentFile:{path:relative,hash}});
    const now=new Date().toISOString();this.db.exec('BEGIN IMMEDIATE');
    try{
      if(externalId){const work=this.db.prepare('SELECT * FROM document_external_workspaces WHERE id=?').get(externalId);if(work?.draft_id!==draftId||work.revision!==revision)throw new Error('工作副本归属已变化，未导入旧文件。')}
      const result=this.db.prepare('UPDATE document_editor_drafts SET patch_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(patch,now,draftId,revision);
      if(result.changes!==1)throw new Error('文档草稿已变化，未覆盖其他修改');
      if(externalId)this.db.prepare('UPDATE document_external_workspaces SET last_hash=?,revision=?,updated_at=? WHERE id=?').run(hash,revision+1,now,externalId);
      this.db.exec('COMMIT');
    }catch(cause){this.db.exec('ROLLBACK');throw cause}
    return this.value(this.row(draftId));
  }
  async snapshot(draftId,revision) {
    const row=this.row(draftId),source=await this.scope(JSON.parse(row.scope_json));
    if(!Number.isSafeInteger(revision)||revision<0)throw new Error('文档预览修订号无效');
    const cached=this.db.prepare('SELECT * FROM document_editor_snapshots WHERE draft_id=? AND revision=?').get(draftId,revision);
    if(cached)return {bytes:this.read(cached.path,cached.hash),...cached,title:source.title};
    this.revision(row,revision);const key=`snapshot:${draftId}:${revision}`;
    if(!this.inflight.has(key))this.inflight.set(key,(async()=>{
      const base=`.wtt-workbench/document-editor/${draftId}/base${source.extension}`;this.read(base,source.scope.fileHash);
      const relative=`.wtt-workbench/document-editor/${draftId}/revision-${revision}-${randomUUID()}${source.extension}`;
      this.directory(path.dirname(relative));const target=path.join(this.root,relative);
      const patch=JSON.parse(row.patch_json);
      if(patch.documentFile)this.write(relative,this.read(patch.documentFile.path,patch.documentFile.hash));
      else if(row.patch_json==='{}')this.write(relative,source.bytes);
      else {
        const patchFile=`.wtt-workbench/document-editor/${draftId}/patch-${revision}-${randomUUID()}.json`;this.write(patchFile,Buffer.from(row.patch_json));
        await runProcess(this.service.python,[this.helper,'apply-file',path.join(this.root,base),target,path.join(this.root,patchFile)],{timeout:60000});
      }
      const bytes=readFileSync(target),hash=sha(bytes);this.read(relative,hash);this.read(base,source.scope.fileHash);await this.scope(JSON.parse(row.scope_json));
      this.db.prepare('INSERT OR IGNORE INTO document_editor_snapshots VALUES (?,?,?,?)').run(draftId,revision,relative,hash);
      return {bytes,hash,path:relative,title:source.title};
    })().finally(()=>this.inflight.delete(key)));
    return this.inflight.get(key);
  }
  async previewDraft({draftId,revision}) {
    const row=this.row(draftId),model=JSON.parse(row.model_json);if(model.format==='csv')throw new Error('CSV直接在网格中显示，无需分页');
    const snapshot=await this.snapshot(draftId,revision),ref=`draft:${draftId}:${revision}`;
    if(model.format==='pptx') return {...await this.service.deck.previewRenderer.prepareBytes({id:draftId,hash:snapshot.hash,bytes:snapshot.bytes,title:snapshot.title}),draftId,revision};
    return {...await this.preview.get(ref,snapshot.hash),draftId,revision};
  }
  async previewPage({draftId,revision,page}) {
    const snapshot=await this.snapshot(draftId,revision);
    if(path.extname(snapshot.path)==='.pptx')return this.service.deck.previewRenderer.readBytesPage({id:draftId,hash:snapshot.hash,bytes:snapshot.bytes,title:snapshot.title,page});
    return this.preview.page(`draft:${draftId}:${revision}`,snapshot.hash,page);
  }
  async saveVersion({draftId,revision,operationId}) {
    if(!uuid(operationId))throw new Error('文档保存操作标识无效');
    const row=this.row(draftId),fingerprint=sha(JSON.stringify({draftId,revision}));
    const replay=()=>{const op=this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);if(!op)return null;if(op.kind!=='document-edit'||op.input_hash!==fingerprint)throw new Error('文档保存标识已用于不同修改');return JSON.parse(op.result_id);};
    if(replay())return replay();this.revision(row,revision);if(row.patch_json==='{}')throw new Error('文档没有需要保存的修改');
    const source=await this.scope(JSON.parse(row.scope_json)),snapshot=await this.snapshot(draftId,revision);
    const artifactKind=source.extension==='.pptx'?'pptx':['text','script','exercise'].includes(source.descriptor.node.artifactKind)?source.descriptor.node.artifactKind:'text';
    const outputType=artifactKind==='pptx'?'pptx':'text';
    const validated=await validateArtifact(artifactKind,snapshot.path,snapshot.bytes,{pythonExecutable:this.service.python,pptSkillDir:this.service.pptSkillDir});
    await this.scope(source.scope);this.revision(this.row(draftId),revision);
    const taskId=randomUUID(),artifactId=randomUUID();const relative=`courses/${source.scope.requirementId}/tasks/${taskId}/delivery/文档修订${source.extension}`;
    this.write(relative,snapshot.bytes);const now=new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');let result;
    try {
      result=replay();
      if(!result){
        this.revision(this.row(draftId),revision);
        const sameType=source.descriptor.card.type===outputType,editor=source.descriptor.editor||{};
        const plan=sameType&&!source.scope.versionId
          ? {id:source.scope.cardId,requirementId:source.scope.requirementId,type:outputType,title:source.title,baseVersionId:null}
          : this.service.cards.prepare({requirementId:source.scope.requirementId,outputType,instruction:'人工文档修订',generation:sameType?{mode:'revise',cardId:source.scope.cardId,baseVersionId:source.scope.versionId}:{mode:'new'}});
        const input={requirement:this.service.store.getRequirement(source.scope.requirementId),workflow:'document-edit',outputType,...(outputType==='pptx'?{pptEngine:'native'}:{}),instruction:editor.instruction||'',sources:editor.references||[],selectedSkills:editor.selectedSkills||[],...(editor.modelSelection?{modelSelection:editor.modelSelection}:{}),documentEdit:{scope:source.scope,draftId,revision,patch:JSON.parse(row.patch_json)},outputPosition:source.descriptor.node.position};
        this.db.prepare("INSERT INTO course_tasks VALUES (?,?,?,?,?,?,NULL,NULL,'output',NULL,?,?)").run(taskId,source.scope.requirementId,'manual',`文档修订 · ${source.title}`,'右栏文档编辑',JSON.stringify(input),now,now);
        this.service.cards.attach(taskId,plan);
        this.db.prepare('INSERT INTO task_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(artifactId,source.scope.requirementId,taskId,artifactKind,source.title,relative,sha(snapshot.bytes),snapshot.bytes.length,validated.mime,JSON.stringify(validated.validation),JSON.stringify([source.scope.sourceRef]),now);
        this.service.cards.recordOutput(taskId,`artifact:${artifactId}`,{primary:true});
        const binding=this.service.cards.binding(taskId);result={cardId:binding.outputCardId,versionId:binding.cardVersionId,sourceId:`artifact:${artifactId}`,artifactId};
        // A published edit is a version, no longer an unsaved draft of its base.
        this.db.prepare("UPDATE document_editor_drafts SET patch_json='{}',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND patch_json=?")
          .run(now,draftId,revision,row.patch_json);
        this.db.prepare('INSERT INTO operations VALUES (?,?,?,?)').run(operationId,'document-edit',fingerprint,JSON.stringify(result));
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.service.store.outputSaved?.(source.scope.requirementId);return result;
  }
  async createRewrite({draftId,revision,selection,instruction,operationId}) {
    const row=this.row(draftId);this.revision(row,revision);const source=await this.scope(JSON.parse(row.scope_json)),model=JSON.parse(row.model_json);
    if(model.format!=='pdf'||!text(instruction)||!instruction.trim()||instruction.length>8000)throw new Error('请选择PDF文字并填写改写要求');
    const ranges=selection?.ranges||[selection];
    if(!ranges.length||ranges.length>200||selection.quote!==ranges.map(r=>r.quote).join('\n'))throw new Error('PDF选段无效或过长');
    this.normalize(model,{annotations:ranges.map(range=>({...range,id:randomUUID(),type:'highlight',note:''}))});
    return this.service.createTask({requirementId:source.scope.requirementId,outputType:'text',selectedSkills:[],selectedCardIds:[source.scope.sourceRef],sourceRefs:[{cardId:source.scope.sourceRef,hash:source.descriptor.node.sourceHash}],generation:{mode:'new'},operationId,
      instruction:`${instruction.trim()}\n\n将以下PDF选段改写为真实DOCX文件，保留原PDF。只处理所选范围，不臆造未提供的内容。使用现有Word转换工具并核对输出。\n选段资料（JSON）：${JSON.stringify({source:source.title,page:selection.page,quote:selection.quote}).replaceAll('/','\\u002f')}`});
  }
}
