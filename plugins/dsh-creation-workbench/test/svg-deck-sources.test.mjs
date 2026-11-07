import {svgFixture} from './fixtures/svg-editor.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,symlinkSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {WorkbenchService} from '../src/service.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const fixture=svgFixture;

const change=(draft,text)=>[{slideId:draft.document.slides[0].id,changes:[{elementId:draft.document.slides[0].elements[0].id,text}],notes:'修改后的备注'}];
test('SVG exact-hash discovery, direct preview, same-card native PPTX publication and immutable engineering',async t=>{
 const f=await fixture(t),{service,scope}=f,original=readFileSync(f.file),page2=readFileSync(path.join(f.project,'svg_final','p02.svg'));
 const discovery=await service.svgDecks.discover(scope);assert.equal(discovery.status,'matched');assert.equal(discovery.candidates[0].path,'projects/课件');
 const draft=await service.svgDecks.open({scope,candidateId:discovery.candidates[0].id});assert.equal(draft.document.sourceFormat,'svg');assert.equal(draft.document.slides.length,2);
 const saved=service.deck.saveDraft({draftId:draft.id,revision:0,pages:change(draft,'人工修改标题')});
 const preview=await service.deck.preview({draftId:draft.id,revision:saved.revision});assert.equal(preview.sourceFormat,'svg');
 const page=await service.deck.readPreviewPage({draftId:draft.id,revision:saved.revision,page:1});assert.equal(page.mime,'image/svg+xml');assert.match(page.bytes.toString(),/人工修改标题/);assert.equal(service.store.db.prepare('SELECT count(*) n FROM ppt_editor_renders').get().n,0);
 const later=service.deck.saveDraft({draftId:draft.id,revision:saved.revision,pages:change(draft,'后续输入')});
 const oldPage=await service.deck.readPreviewPage({draftId:draft.id,revision:saved.revision,page:1});assert.match(oldPage.bytes.toString(),/人工修改标题/);assert.doesNotMatch(oldPage.bytes.toString(),/后续输入/);
 const restored=service.deck.saveDraft({draftId:draft.id,revision:later.revision,pages:change(draft,'人工修改标题')});saved.revision=restored.revision;
 const op=randomUUID(),result=await service.deck.saveVersion({draftId:draft.id,revision:saved.revision,operationId:op});
 assert.equal(result.descriptor.version.number,2);assert.equal(result.descriptor.card.id,scope.cardId);assert.equal(result.artifact.validation.editability.ok,true);
 assert.deepEqual(readFileSync(f.file),original);assert.deepEqual(readFileSync(path.join(f.project,'svg_final','p02.svg')),page2);assert.match(readFileSync(path.join(f.project,'svg_final','p01.svg'),'utf8'),/第1页标题/);
 const next={...scope,versionId:result.descriptor.version.id,artifactId:result.artifact.id,hash:result.artifact.hash};
 const bound=await service.svgDecks.discover(next);assert.equal(bound.candidates.length,1);assert.match(bound.candidates[0].id,/^snapshot:/);
 const reopened=await service.svgDecks.open({scope:next,candidateId:bound.candidates[0].id});assert.equal(reopened.document.slides[0].elements[0].text,'人工修改标题');assert.equal(reopened.document.slides[0].notes,'修改后的备注');
 const frozen=service.svgDecks.validate(reopened.scope);assert.deepEqual(readFileSync(path.join(f.root,frozen.path,'svg_final','p02.svg')),page2);
 const actual=spawnSync('python3',['-c','import sys,json;from pptx import Presentation;p=Presentation(sys.argv[1]);print(json.dumps({"text":[s.text for s in p.slides[0].shapes if s.has_text_frame],"notes":p.slides[0].notes_slide.notes_text_frame.text},ensure_ascii=False))',path.join(f.root,result.artifact.path)],{encoding:'utf8'});assert.equal(actual.status,0,actual.stderr);assert.match(actual.stdout,/人工修改标题/);assert.match(actual.stdout,/修改后的备注/);
 assert.equal((await service.deck.saveVersion({draftId:draft.id,revision:saved.revision,operationId:op})).artifact.id,result.artifact.id);
 // The source snapshot is part of publication: a later external edit cannot silently become a draft.
 writeFileSync(path.join(f.root,frozen.path,'svg_final','p01.svg'),'tampered');await assert.rejects(service.svgDecks.discover(next),/外部修改/);
});
test('SVG ambiguous candidates require explicit selection; stale, linked and active sources fail without fallback',async t=>{
 const f=await fixture(t),{service,scope}=f;cpSync(f.project,path.join(f.root,'projects','另一个'),{recursive:true});
 const found=await service.svgDecks.discover(scope);assert.equal(found.status,'choose');assert.equal(found.candidates.length,2);await assert.rejects(service.svgDecks.open({scope,candidateId:'guess'}),/候选已变化/);
 const candidate=found.candidates.find(c=>c.path==='projects/课件');writeFileSync(path.join(f.project,'svg_final','p01.svg'),'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><script>alert(1)</script></svg>');
 await assert.rejects(service.svgDecks.open({scope,candidateId:candidate.id}),/主动内容/);
 rmSync(path.join(f.project,'svg_final','p01.svg'));symlinkSync('/etc/passwd',path.join(f.project,'svg_final','p01.svg'));
 await assert.rejects(service.svgDecks.open({scope,candidateId:candidate.id}),/符号链接/);
 await assert.rejects(service.svgDecks.discover({...scope,hash:hash('wrong')}),/不匹配|变化/);
});
test('SVG single-page AI proposals stay pending, reject unrelated pages and publish only after confirmation',async t=>{
 const f=await fixture(t),found=await f.service.svgDecks.discover(f.scope),draft=await f.service.svgDecks.open({scope:f.scope,candidateId:found.candidates[0].id});
 const created=await f.service.deck.createAiTask({draftId:draft.id,revision:0,slideId:draft.document.slides[0].id,elementIds:[],instruction:'改标题',operationId:randomUUID()});
 const sessionId=`technical:${created.task.id}`;f.service.tasks.bindSession({taskId:created.task.id,sessionId});
 await assert.rejects(f.service.deck.propose({taskId:created.task.id,sessionId,pages:[{slideId:'p02',changes:[{elementId:draft.document.slides[1].elements[0].id,text:'不允许'}]}]}),/授权页面/);
 const proposal=await f.service.deck.propose({taskId:created.task.id,sessionId,pages:change(draft,'AI人工模拟候选')});assert.equal(proposal.status,'pending');assert.equal(f.service.tasks.get(created.task.id).files.length,0);
 const result=await f.service.deck.confirm({taskId:created.task.id,proposalId:proposal.proposal.id,operationId:randomUUID()});assert.equal(result.descriptor.version.number,2);assert.ok(f.service.store.db.prepare('SELECT snapshot_id FROM svg_deck_bindings WHERE artifact_id=?').get(result.artifact.id));
});
