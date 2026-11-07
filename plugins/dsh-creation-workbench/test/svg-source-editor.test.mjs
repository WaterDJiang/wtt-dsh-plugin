import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {readFileSync} from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {svgFixture} from './fixtures/svg-editor.mjs';
const svg=(title,color='#003396',image='')=>`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="${color}"/><text x="80" y="120" font-family="Arial" font-size="40">${title}</text>${image}</svg>`;
async function open(f){const found=await f.service.svgDecks.discover(f.scope);return f.service.svgEditor.open({scope:f.scope,candidateId:found.candidates[0].id});}
async function task(f,draft,input={}){const created=await f.service.svgEditor.createTask({draftId:draft.id,revision:draft.revision,pageId:draft.document.slides[0].id,instruction:'按要求修改SVG，不调用真实模型',operationId:randomUUID(),...input}),sessionId=`technical:${created.task.id}`;f.service.tasks.bindSession({taskId:created.task.id,sessionId});return {...created,sessionId};}
async function propose(f,created,operations,summary='人工协议候选'){return f.service.svgEditor.propose({taskId:created.task.id,sessionId:created.sessionId,operations,summary});}

test('SVG完整页面／插页／换图应用到源稿后继续迭代，最终同卡导出，原件不变',async t=>{
 const f=await svgFixture(t),original=readFileSync(f.file),page2=readFileSync(path.join(f.project,'svg_final','p02.svg'));let draft=await open(f);
 const png=spawnSync('python3',['-c','import sys,io;from PIL import Image;b=io.BytesIO();Image.new("RGB",(120,80),(24,99,180)).save(b,format="PNG");sys.stdout.buffer.write(b.getvalue())']);assert.equal(png.status,0);
 const ref=await f.service.svgEditor.addImage({draftId:draft.id,operationId:randomUUID(),filename:'参考图.png',bytes:png.stdout});
 const first=await task(f,draft,{referenceIds:[ref.id]});assert.deepEqual(first.prepared.explicitSkills,[]);assert.equal(first.task.input.svgEdit.sources.length,1);assert.match(first.prepared.prompt,/course_propose_svg_edit/);
 let pending=await propose(f,first,[{type:'replace-page',pageId:'p01',svg:svg('重绘页面','#edf6ff',`<image x="600" y="200" width="120" height="80" href="${ref.href}"/>`),notes:'新版讲师备注'},{type:'insert-page',pageId:'summary',afterId:'p01',svg:svg('新增总结页')}]);
 assert.equal(pending.revision,0);assert.equal(pending.document.slides.length,2);assert.equal(f.service.tasks.get(first.task.id).files.length,0);assert.equal(f.service.store.db.prepare('SELECT count(*) n FROM ppt_editor_renders').get().n,0,'候选不得提前导出PPT');
 let candidate=pending.turns[0].proposal;assert.equal(candidate.status,'pending');const preview=await f.service.svgEditor.readPage({draftId:draft.id,sourceId:candidate.sourceId,page:1});assert.match(preview.bytes.toString(),/data:image\/png;base64/);
 draft=f.service.svgEditor.apply({draftId:draft.id,revision:0,proposalId:candidate.id});assert.equal(draft.revision,1);assert.deepEqual(draft.document.slides.map(p=>p.id),['p01','summary','p02']);assert.equal(draft.document.slides[0].notes,'新版讲师备注');assert.equal(f.service.tasks.get(first.task.id).status,'applied');
 assert.equal(f.service.svgEditor.apply({draftId:draft.id,revision:0,proposalId:candidate.id}).revision,1,'应用重试不可新增修订');
 const second=await task(f,draft,{range:'deck'});assert.equal(second.task.input.svgEdit.sources.length,3);assert.equal(second.task.input.svgEdit.recentChanges.length,1);
 pending=await propose(f,second,[{type:'delete-page',pageId:'p02'},{type:'reorder-pages',pageIds:['summary','p01']}]);candidate=pending.turns[1].proposal;
 draft=f.service.svgEditor.apply({draftId:draft.id,revision:1,proposalId:candidate.id});assert.deepEqual(draft.document.slides.map(p=>p.id),['summary','p01']);
 const restored=await open(f);assert.equal(restored.id,draft.id);
 const foundAgain=await f.service.svgDecks.discover({...f.scope,outcome:true});const throughPreview=await f.service.svgEditor.open({scope:{...f.scope,outcome:true},candidateId:foundAgain.candidates[0].id});assert.equal(throughPreview.id,draft.id);assert.equal(throughPreview.turns.length,2);assert.equal(restored.revision,2);assert.equal(restored.turns.length,2);
 const operationId=randomUUID(),saved=await f.service.svgEditor.save({draftId:draft.id,revision:2,operationId});assert.equal(saved.descriptor.version.number,2);assert.equal(saved.descriptor.card.id,f.scope.cardId);assert.equal(saved.artifact.validation.editability.ok,true);
 const actual=spawnSync('python3',['-c','import sys,json;from pptx import Presentation;p=Presentation(sys.argv[1]);print(json.dumps([[s.text for s in page.shapes if s.has_text_frame] for page in p.slides],ensure_ascii=False))',path.join(f.root,saved.artifact.path)],{encoding:'utf8'});assert.equal(actual.status,0,actual.stderr);const texts=JSON.parse(actual.stdout);assert.ok(texts[0].some(x=>x.includes('新增总结页')));assert.ok(texts[1].some(x=>x.includes('重绘页面')));
 assert.equal((await f.service.svgEditor.save({draftId:draft.id,revision:2,operationId})).artifact.id,saved.artifact.id);assert.deepEqual(readFileSync(f.file),original);assert.deepEqual(readFileSync(path.join(f.project,'svg_final','p02.svg')),page2);
 const bound=await f.service.svgDecks.discover({...f.scope,versionId:saved.descriptor.version.id,artifactId:saved.artifact.id,hash:saved.artifact.hash});assert.equal(bound.candidates.length,1);
});

test('SVG整页请求不能越页、伪造会话、引用或注入主动内容；旧候选不覆盖新草稿',async t=>{
 const f=await svgFixture(t),draft=await open(f),created=await task(f,draft);
 await assert.rejects(f.service.svgEditor.propose({taskId:created.task.id,sessionId:'other',summary:'错会话',operations:[{type:'replace-page',pageId:'p01',svg:svg('越权')}]}),/绑定/);
 await assert.rejects(propose(f,created,[{type:'delete-page',pageId:'p02'}]),/范围/);
 await assert.rejects(propose(f,created,[{type:'replace-page',pageId:'p01',svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><script>bad()</script></svg>'}]),/主动内容/);
 await assert.rejects(propose(f,created,[{type:'replace-page',pageId:'p01',svg:svg('外链','#ffffff','<image href="https://example.com/a.png"/>')}]),/图片超出|格式不支持/);
 const pending=await propose(f,created,[{type:'replace-page',pageId:'p01',svg:svg('待确认')}]),candidate=pending.turns[0].proposal;
 await assert.rejects(f.service.svgEditor.save({draftId:draft.id,revision:0,operationId:randomUUID()}),/先处理/);
 const changed=f.service.store.db.prepare('UPDATE svg_editor_drafts SET revision=1 WHERE id=?').run(draft.id);assert.equal(changed.changes,1);
 assert.throws(()=>f.service.svgEditor.apply({draftId:draft.id,revision:1,proposalId:candidate.id}),/不能覆盖/);
 f.service.store.db.prepare('UPDATE svg_editor_drafts SET revision=0 WHERE id=?').run(draft.id);f.service.svgEditor.discard({draftId:draft.id,proposalId:candidate.id});
 await assert.rejects(task(f,draft,{referenceIds:[randomUUID()]}),/不属于/);
 const next=await task(f,draft,{range:'deck'});await assert.rejects(propose(f,next,[{type:'delete-page',pageId:'p01'},{type:'delete-page',pageId:'p02'}]),/1–200/);
});

test('旧版待确认文字方案保留，明确导入只应用源稿草稿，不导出正式版本',async t=>{
 const f=await svgFixture(t),found=await f.service.svgDecks.discover(f.scope),legacy=await f.service.svgDecks.open({scope:f.scope,candidateId:found.candidates[0].id});
 const old=f.service.deck.createAiTask({draftId:legacy.id,revision:0,slideId:'p01',elementIds:[],instruction:'旧版改字',operationId:randomUUID()}),sessionId=`technical:${old.task.id}`;f.service.tasks.bindSession({taskId:old.task.id,sessionId});
 await f.service.deck.propose({taskId:old.task.id,sessionId,pages:[{slideId:'p01',changes:[{elementId:legacy.document.slides[0].elements[0].id,text:'保留旧方案'}]}]});
 const draft=await open(f);assert.equal(draft.legacy.status,'pending');assert.equal(f.service.tasks.get(old.task.id).status,'proposed');
 const applied=await f.service.svgEditor.applyLegacy({draftId:draft.id,revision:0});assert.equal(applied.revision,1);assert.equal(applied.legacy.status,'applied');assert.equal(applied.document.slides[0].elements[0].text,'保留旧方案');assert.equal(f.service.tasks.get(old.task.id).files.length,0);assert.equal(f.service.store.db.prepare('SELECT count(*) n FROM output_card_versions').get().n,1);
});

test('AI轮次和候选不锁手动改字备注，旧候选不能覆盖较新的手动草稿',async t=>{
 const f=await svgFixture(t);let draft=await open(f);const element=draft.document.slides[0].elements.find(e=>e.editable),created=await task(f,draft);
 draft=await f.service.svgEditor.editText({draftId:draft.id,revision:0,pages:[{slideId:'p01',changes:[{elementId:element.id,text:'手动修改仍然可用'}],notes:'任务保留时手动补充备注'}]});
 assert.equal(draft.revision,1);assert.equal(draft.document.slides[0].elements.find(e=>e.id===element.id).text,'手动修改仍然可用');assert.equal(draft.document.slides[0].notes,'任务保留时手动补充备注');assert.equal(draft.turns.length,1);
 const pending=await propose(f,created,[{type:'replace-page',pageId:'p01',svg:svg('旧轮次的独立候选')}]);assert.equal(pending.document.slides[0].elements.find(e=>e.id===element.id).text,'手动修改仍然可用');const proposal=pending.turns[0].proposal;
 draft=await f.service.svgEditor.editText({draftId:draft.id,revision:1,pages:[{slideId:'p01',notes:'候选保留时也能编辑备注'}]});assert.equal(draft.revision,2);assert.equal(draft.turns[0].status,'pending');
 assert.throws(()=>f.service.svgEditor.apply({draftId:draft.id,revision:2,proposalId:proposal.id}),/不能覆盖/);await assert.rejects(f.service.svgEditor.save({draftId:draft.id,revision:2,operationId:randomUUID()}),/先处理/);assert.equal(f.service.store.db.prepare('SELECT count(*) n FROM output_card_versions').get().n,1);
 await assert.rejects(f.service.svgEditor.editText({draftId:draft.id,revision:0,pages:[{slideId:'p01',notes:'过期手动请求'}]}),/源稿已变化/);
});

test('撤销恢复上一修订源稿，待确认候选时禁止撤销，可连续回退',async t=>{
 const f=await svgFixture(t);let draft=await open(f);const element=draft.document.slides[0].elements.find(e=>e.editable),before=element.text;
 draft=await f.service.svgEditor.editText({draftId:draft.id,revision:0,pages:[{slideId:'p01',changes:[{elementId:element.id,text:'撤销测试改字'}]}]});
 assert.equal(draft.revision,1);
 const undone=await f.service.svgEditor.undo({draftId:draft.id,revision:1});
 assert.equal(undone.revision,2);assert.equal(undone.document.slides[0].elements.find(e=>e.id===element.id).text,before);
 const created=await task(f,undone);
 await assert.rejects(f.service.svgEditor.undo({draftId:draft.id,revision:undone.revision}),/先处理AI候选/);
 f.service.svgEditor.endTurn({draftId:draft.id,taskId:created.task.id});
 const again=await f.service.svgEditor.undo({draftId:draft.id,revision:undone.revision});
 assert.equal(again.revision,3);assert.equal(again.document.slides[0].elements.find(e=>e.id===element.id).text,'撤销测试改字');
});

test('引用对象多选：跨页列表冻结，候选只能改列表内对象',async t=>{
 const f=await svgFixture(t),draft=await open(f);
 const p1=draft.document.slides[0].elements.filter(e=>e.editable),p2=draft.document.slides[1].elements.filter(e=>e.editable);assert.ok(p1.length>=1&&p2.length>=1,'夹具两页均有可编辑对象');
 const objects=[{pageId:'p01',elementId:p1[0].id},{pageId:'p02',elementId:p2[0].id}];
 const created=await f.service.svgEditor.createTask({draftId:draft.id,revision:draft.revision,pageId:'p01',objects,range:'objects',instruction:'只改加号选中的对象',operationId:randomUUID()});
 const sessionId=`technical:${created.task.id}`;f.service.tasks.bindSession({taskId:created.task.id,sessionId});
 await assert.rejects(f.service.svgEditor.propose({taskId:created.task.id,sessionId,summary:'越页',operations:[{type:'replace-page',pageId:'p01',svg:svg('越页')}]}),/引用对象/);
 await assert.rejects(f.service.svgEditor.propose({taskId:created.task.id,sessionId,summary:'列表外',operations:[{type:'replace-element',pageId:'p01',elementId:'n-9-9',svgFragment:svg('越权')}]}),/引用对象/);
 await assert.rejects(f.service.svgEditor.propose({taskId:created.task.id,sessionId,summary:'跨页列表外',operations:[{type:'replace-element',pageId:'p02',elementId:'n-9-9',svgFragment:svg('越权')}]}),/引用对象/);
 const pending=await f.service.svgEditor.propose({taskId:created.task.id,sessionId,summary:'跨页对象修改',operations:[{type:'replace-element',pageId:'p02',elementId:p2[0].id,svgFragment:svg('第2页对象修改')},{type:'replace-element',pageId:'p01',elementId:p1[0].id,svgFragment:svg('第1页对象修改')}]});assert.equal(pending.turns.at(-1).status,'pending');
 await assert.rejects(f.service.svgEditor.createTask({draftId:draft.id,revision:draft.revision,pageId:'p01',objects:[],range:'objects',instruction:'空引用',operationId:randomUUID()}),/加号|正在处理/);
});

test('原生编辑会话绑定冻结选页，短消息不塞工程；上下文只由当前绑定任务读取',async t=>{
 const f=await svgFixture(t);let draft=await open(f);const nativeSessionId='technical-native-editor';
 assert.deepEqual(f.service.svgEditor.bindConversation({draftId:draft.id,sessionId:nativeSessionId}),{sessionId:nativeSessionId});assert.equal(f.service.svgEditor.bindConversation({draftId:draft.id,sessionId:'race-empty-session'}).sessionId,nativeSessionId,'并发打开不覆盖原编辑会话');assert.equal((await open(f)).conversationSessionId,nativeSessionId);
 assert.throws(()=>f.service.svgEditor.contextForSession(nativeSessionId),/唯一待执行/);await assert.rejects(f.service.svgEditor.createTask({draftId:draft.id,revision:0,pageId:'p01',instruction:'修改',nativeSessionId:'wrong',operationId:randomUUID()}),/未绑定/);
 const created=await f.service.svgEditor.createTask({draftId:draft.id,revision:0,pageId:'p02',instruction:'只精简第2页标题',nativeSessionId,operationId:randomUUID()});assert.equal(created.prepared.sessionId,nativeSessionId);assert.match(created.prepared.prompt,/course_get_svg_edit_context/);assert.doesNotMatch(created.prepared.prompt,/<svg|pageIndex/);assert.equal(created.prepared.modelSelection,undefined);assert.deepEqual(created.prepared.explicitSkills,[]);
 f.service.tasks.bindSession({taskId:created.task.id,sessionId:nativeSessionId});f.service.tasks.setDispatch({taskId:created.task.id,status:'accepted'});const frozen=f.service.svgEditor.contextForSession(nativeSessionId);assert.equal(frozen.taskId,created.task.id);assert.deepEqual(frozen.sources.map(p=>p.pageId),['p02']);assert.match(frozen.contract,/course_propose_svg_edit/);assert.throws(()=>f.service.svgEditor.contextForSession('other-session'),/没有绑定/);
 const pending=await f.service.svgEditor.propose({taskId:created.task.id,sessionId:nativeSessionId,summary:'第2页候选',operations:[{type:'replace-page',pageId:'p02',svg:svg('精简标题')}]});assert.equal(pending.turns.at(-1).status,'pending');assert.throws(()=>f.service.svgEditor.contextForSession(nativeSessionId),/唯一待执行/);
});
