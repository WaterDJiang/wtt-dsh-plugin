import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { WorkbenchService } from '../src/service.mjs';
import { parseGridClipboard,gridClipboard } from '../src/document-grid.mjs';

function python(code,args=[]){const p=spawnSync('python3',['-c',code,...args],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout}
function fixture(t){const root=mkdtempSync(path.join(tmpdir(),'cw34-docs-'));const service=new WorkbenchService({workspaceRoot:root});const requirement=service.store.createRequirement({background:'虚构文档编辑验收',operationId:randomUUID()});t.after(()=>{service.close();rmSync(root,{recursive:true,force:true})});return {root,service,requirement}}
async function imported(f,name,bytes){await f.service.importMaterial({requirementId:f.requirement.id,filename:name,bytes,operationId:randomUUID()});const node=f.service.canvas.getBoard(f.requirement.id).nodes.find(n=>n.importedFile?.name===name);return {node,scope:{requirementId:f.requirement.id,sourceRef:node.sourceId||node.id,cardId:node.outputCard.id,versionId:node.outputCard.versionId,hash:node.importedFile.hash}}}
function docx(root){const file=path.join(root,'sample.docx');python(`from docx import Document
from docx.shared import Inches
from PIL import Image
import sys
p=sys.argv[1];Image.new('RGB',(20,20),'red').save(p+'.png')
d=Document();d.add_heading('标题',0);r=d.add_paragraph().add_run('普通');r=d.paragraphs[-1].add_run('加粗');r.bold=True;d.paragraphs[-1].add_run('结尾')
t=d.add_table(rows=1,cols=2);t.cell(0,0).text='甲';t.cell(0,1).text='乙';d.add_picture(p+'.png',width=Inches(1));d.save(p)`,[file]);return readFileSync(file)}
function pdf(root){const file=path.join(root,'sample.pdf');python(`import fitz,sys
d=fitz.open();p=d.new_page();p.insert_text((72,72),'Alpha beta gamma');d.new_page();d.save(sys.argv[1])`,[file]);return readFileSync(file)}

test('CSV clipboard roundtrips quotes, tabs, multiline and empty cells',()=>{const rows=[['中文','a\tb','"引号"'],['换\n行','','=1+1']];assert.deepEqual(parseGridClipboard(gridClipboard(rows)),rows);assert.deepEqual(parseGridClipboard('a\tb\r\n1\t2\r\n'),[['a','b'],['1','2']]);assert.throws(()=>parseGridClipboard('"oops'),/引号/)});

test('imported CSV appends same-card V2/V3 from V1, replays once and preserves original bytes',async t=>{
 const f=fixture(t),original=Buffer.from('\ufeff标题,内容\r\n中文,"a,b"\r\n空值,\r\n');const {scope,node}=await imported(f,'数据.csv',original);
 let d=await f.service.documents.open(scope);assert.deepEqual(d.model.rows,[['标题','内容'],['中文','a,b'],['空值','']]);
 const patch={rows:[['标题','内容','新增列'],['修改','第一行\n第二行','"引号"'],['新增行','','']]};d=await f.service.documents.saveDraft({draftId:d.id,revision:d.revision,patch});
 const operationId=randomUUID(),payload={draftId:d.id,revision:d.revision,operationId};const saved=await f.service.documents.saveVersion(payload);assert.deepEqual(await f.service.documents.saveVersion(payload),saved);
 const second=f.service.cards.describe({requirementId:f.requirement.id,cardId:saved.cardId});assert.equal(second.version.number,2);assert.equal(second.node.id,node.id);assert.equal(second.version.baseVersionId,scope.versionId);assert.deepEqual(f.service.canvas.readImportedFile(node.refId).bytes,original);
 const reopened=await f.service.documents.open({requirementId:f.requirement.id,cardId:saved.cardId,versionId:saved.versionId,sourceRef:second.version.primaryRef,hash:second.node.sourceHash});assert.deepEqual(reopened.model.rows,patch.rows);
 const v1=await f.service.documents.open(scope);assert.equal(v1.dirty,false);assert.deepEqual(v1.model.rows,[['标题','内容'],['中文','a,b'],['空值','']]);const third=await f.service.documents.saveDraft({draftId:v1.id,revision:v1.revision,patch:{rows:[['第三版','基于旧版']]}});const saved3=await f.service.documents.saveVersion({draftId:third.id,revision:third.revision,operationId:randomUUID()});
 const latest=f.service.cards.describe({requirementId:f.requirement.id,cardId:saved3.cardId});assert.equal(latest.version.number,3);assert.equal(latest.version.baseVersionId,scope.versionId);assert.equal(f.service.canvas.getBoard(f.requirement.id).nodes.filter(n=>n.id===node.id).length,1);
});

test('drafts reject stale revisions, foreign projects, forged shapes and changed source files',async t=>{
 const f=fixture(t),{scope,node}=await imported(f,'scope.csv',Buffer.from('a,b\n1,2\n'));const d=await f.service.documents.open(scope);
 await assert.rejects(f.service.documents.saveDraft({draftId:d.id,revision:0,patch:{rows:[['a'],['b','c']]}}),/矩形/);
 const next=await f.service.documents.saveDraft({draftId:d.id,revision:0,patch:{rows:[['changed','b']]}});await assert.rejects(f.service.documents.saveDraft({draftId:d.id,revision:0,patch:{rows:[['stale']]}}),/草稿已变化/);
 const other=fixture(t);await assert.rejects(other.service.documents.open(scope),/不存在|不属于/);assert.throws(()=>other.service.documents.row(d.id),/不属于/);
 const req=f.service.store.createRequirement({background:'别的需求',operationId:randomUUID()});await assert.rejects(f.service.documents.open({...scope,requirementId:req.id}),/不存在|不属于/);
 writeFileSync(path.join(f.root,node.importedFile.path),'external');await assert.rejects(f.service.documents.saveVersion({draftId:d.id,revision:next.revision,operationId:randomUUID()}),/修改|变化/);
 assert.equal(f.service.cards.describe({requirementId:f.requirement.id,cardId:scope.cardId}).card.versions.length,1);
});

test('Word changes only selected XML text, preserves package assets/styles and supports newline re-editing',async t=>{
 const f=fixture(t),bytes=docx(f.root),{scope}=await imported(f,'文档.docx',bytes);let d=await f.service.documents.open(scope);
 const p=d.model.objects.find(o=>o.text==='普通加粗结尾'),cell=d.model.objects.find(o=>o.text==='甲');assert.ok(p.editable);assert.ok(cell.inTable);assert.ok(d.model.objects.some(o=>!o.editable));
 d=await f.service.documents.saveDraft({draftId:d.id,revision:d.revision,patch:{changes:{[p.id]:'普通加粗改字结尾\n新行',[cell.id]:'表格修订'}}});
 const saved=await f.service.documents.saveVersion({draftId:d.id,revision:d.revision,operationId:randomUUID()});const read=f.service.tasks.files.read(saved.artifactId),out=path.join(f.root,'edited.docx');writeFileSync(out,read.bytes);
 const proof=JSON.parse(python(`from zipfile import ZipFile
from lxml import etree as E
import sys,json
with ZipFile(sys.argv[1]) as a,ZipFile(sys.argv[2]) as b:
 changed=[n for n in a.namelist() if a.read(n)!=b.read(n)];root=E.fromstring(b.read('word/document.xml'));ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
 print(json.dumps({'changed':changed,'bold':root.xpath('//w:r[w:rPr/w:b]/w:t/text()',namespaces=ns),'text':root.xpath('//w:t/text()',namespaces=ns)},ensure_ascii=False))`,[path.join(f.root,'sample.docx'),out]));
 assert.deepEqual(proof.changed,['word/document.xml']);assert.ok(proof.bold.join('').includes('加粗'));assert.ok(proof.text.includes('表格修订'));
 const desc=f.service.cards.describe({requirementId:f.requirement.id,cardId:saved.cardId});const next=await f.service.documents.open({requirementId:f.requirement.id,cardId:saved.cardId,versionId:saved.versionId,sourceRef:desc.version.primaryRef,hash:desc.node.sourceHash});assert.ok(next.model.objects.some(o=>o.editable&&o.text.includes('\n新行')));
 await assert.rejects(f.service.documents.saveDraft({draftId:next.id,revision:next.revision,patch:{changes:{'99999':'x'}}}),/只读|不存在/);
});

test('PDF writes real range highlights/page notes and prepares a separate Word rewrite without sending',async t=>{
 const f=fixture(t),original=pdf(f.root),{scope,node}=await imported(f,'资料.pdf',original);let d=await f.service.documents.open(scope);assert.equal(d.model.pages[1].lines.length,0);
 const line=d.model.pages[0].lines[0],selection={page:1,lineId:line.id,start:0,end:5,quote:'Alpha'};
 d=await f.service.documents.saveDraft({draftId:d.id,revision:d.revision,patch:{annotations:[{...selection,id:randomUUID(),type:'highlight',note:'重点'},{id:randomUUID(),type:'note',page:2,lineId:null,note:'扫描页意见'}]}});
 const saved=await f.service.documents.saveVersion({draftId:d.id,revision:d.revision,operationId:randomUUID()}),out=path.join(f.root,'annotated.pdf');writeFileSync(out,f.service.tasks.files.read(saved.artifactId).bytes);
 const notes=JSON.parse(python(`import fitz,sys,json
with fitz.open(sys.argv[1]) as d: print(json.dumps([[{'type':a.type[1],'content':a.info['content']} for a in p.annots()] for p in d],ensure_ascii=False))`,[out]));assert.equal(notes[0][0].type,'Highlight');assert.equal(notes[0][0].content,'重点');assert.equal(notes[1][0].content,'扫描页意见');assert.deepEqual(f.service.canvas.readImportedFile(node.refId).bytes,original);
 d=await f.service.documents.open(scope);
 await assert.rejects(f.service.documents.createRewrite({draftId:d.id,revision:d.revision,selection:{...selection,quote:'forged'},instruction:'改写',operationId:randomUUID()}),/范围|文字/);
 const rewrite=await f.service.documents.createRewrite({draftId:d.id,revision:d.revision,selection,instruction:'简化表达',operationId:randomUUID()});assert.equal(rewrite.task.status,'draft');assert.equal(rewrite.task.sessionId,null);assert.match(rewrite.prepared.prompt,/DOCX/);assert.notEqual(rewrite.task.outputCardId,saved.cardId);
});

test('draft snapshots reject symlink replacement and failed PDF candidates add no formal version',async t=>{
 const f=fixture(t),{scope}=await imported(f,'guard.csv',Buffer.from('a,b\n1,2\n'));let d=await f.service.documents.open(scope);d=await f.service.documents.saveDraft({draftId:d.id,revision:d.revision,patch:{rows:[['edited','2']]}});
 const base=path.join(f.root,`.wtt-workbench/document-editor/${d.id}/base.csv`),outside=path.join(f.root,'outside.csv');renameSync(base,outside);symlinkSync(outside,base);await assert.rejects(f.service.documents.snapshot(d.id,d.revision),/路径|修改/);
 const p=await imported(f,'bad.pdf',pdf(f.root)),pdfDraft=await f.service.documents.open(p.scope);await assert.rejects(f.service.documents.saveDraft({draftId:pdfDraft.id,revision:0,patch:{annotations:[{id:randomUUID(),type:'highlight',page:1,lineId:'0',start:0,end:999,quote:'bad'}]}}),/范围/);
 assert.equal(f.service.cards.describe({requirementId:f.requirement.id,cardId:p.scope.cardId}).card.versions.length,1);
});

test('document drafts survive a second service and produce real cached Word/PDF preview pages',async t=>{
 const f=fixture(t),{scope}=await imported(f,'preview.docx',docx(f.root));let d=await f.service.documents.open(scope);
 const item=d.model.objects.find(o=>o.text==='普通加粗结尾');d=await f.service.documents.saveDraft({draftId:d.id,revision:d.revision,patch:{changes:{[item.id]:'普通加粗修订结尾'}}});
 const second=new WorkbenchService({workspaceRoot:f.root});t.after(()=>second.close());const restored=await second.documents.open(scope);assert.equal(restored.revision,d.revision);assert.deepEqual(restored.patch,d.patch);
 const preview=await second.documents.previewDraft({draftId:d.id,revision:d.revision});assert.ok(preview.pageCount>0);
 const page=await second.documents.previewPage({draftId:d.id,revision:d.revision,page:1});assert.equal(page.mime,'image/png');assert.deepEqual(page.bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
 const again=await second.documents.previewDraft({draftId:d.id,revision:d.revision});assert.deepEqual(again.pages,preview.pages);
});

test('rich Word draft persists actual DOCX, migrates legacy edits and publishes one same-card version',async t=>{
 const f=fixture(t),original=docx(f.root),{scope,node}=await imported(f,'连续文档.docx',original);let d=await f.service.documents.open(scope);
 const p=d.model.objects.find(o=>o.text==='普通加粗结尾');d=await f.service.documents.saveDraft({draftId:d.id,revision:d.revision,patch:{changes:{[p.id]:'旧草稿继续编辑'}}});
 const migrated=await f.service.documents.snapshot(d.id,d.revision),file=path.join(f.root,'rich.docx');writeFileSync(file,migrated.bytes);
 python(`from docx import Document\nimport sys\nd=Document(sys.argv[1]);d.add_paragraph('新引擎新增段落');d.tables[0].cell(0,0).text='新引擎表格';d.save(sys.argv[1])`,[file]);
 const candidate=readFileSync(file);d=await f.service.documents.saveWordDraft({draftId:d.id,revision:d.revision,bytesBase64:candidate.toString('base64')});
 assert.ok(d.patch.documentFile);const snapshot=await f.service.documents.snapshot(d.id,d.revision);assert.deepEqual(snapshot.bytes,candidate);
 const second=new WorkbenchService({workspaceRoot:f.root});t.after(()=>second.close());assert.deepEqual((await second.documents.open(scope)).patch,d.patch);
 const payload={draftId:d.id,revision:d.revision,operationId:randomUUID()},saved=await f.service.documents.saveVersion(payload);assert.deepEqual(await f.service.documents.saveVersion(payload),saved);
 const desc=f.service.cards.describe({requirementId:f.requirement.id,cardId:saved.cardId});assert.equal(desc.version.number,2);assert.equal(desc.version.baseVersionId,scope.versionId);assert.deepEqual(f.service.tasks.files.read(saved.artifactId).bytes,candidate);assert.deepEqual(f.service.canvas.readImportedFile(node.refId).bytes,original);
 const opened=await f.service.documents.open({requirementId:f.requirement.id,cardId:saved.cardId,versionId:saved.versionId,sourceRef:desc.version.primaryRef,hash:desc.node.sourceHash});assert.ok(opened.model.objects.some(o=>o.text==='新引擎新增段落'));assert.ok(opened.model.objects.some(o=>o.text==='旧草稿继续编辑'));
});

test('rich Word draft rejects malformed files and concurrent revisions without publishing',async t=>{
 const f=fixture(t),{scope}=await imported(f,'guard.docx',docx(f.root));let d=await f.service.documents.open(scope);
 await assert.rejects(f.service.documents.saveWordDraft({draftId:d.id,revision:0,bytesBase64:'not base64'}),/无效/);
 await assert.rejects(f.service.documents.saveWordDraft({draftId:d.id,revision:0,bytesBase64:Buffer.from('plain text').toString('base64')}),/有效DOCX/);
 await assert.rejects(f.service.documents.saveWordDraft({draftId:d.id,revision:0,bytesBase64:Buffer.from('PK\x03\x04broken').toString('base64')}));
 const item=d.model.objects.find(o=>o.editable&&o.text);d=await f.service.documents.saveDraft({draftId:d.id,revision:0,patch:{changes:{[item.id]:'并发修改'}}});
 await assert.rejects(f.service.documents.saveWordDraft({draftId:d.id,revision:0,bytesBase64:docx(f.root).toString('base64')}),/草稿已变化/);
 assert.equal(f.service.cards.describe({requirementId:f.requirement.id,cardId:scope.cardId}).card.versions.length,1);
});
