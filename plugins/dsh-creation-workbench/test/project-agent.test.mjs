import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {WorkbenchService} from '../src/service.mjs';
import {ProjectAgent} from '../src/project-agent.mjs';

async function fixture(t,mode='plan'){
  const root=mkdtempSync(path.join(tmpdir(),'wtt-project-agent-'));
  let service=new WorkbenchService({workspaceRoot:root}),agent;
  const sent=[];
  const host={createSession:async()=>randomUUID(),prompt:async(_service,sid,prepared)=>{sent.push({sid,prepared});return {accepted:true};},
    createTask:(svc,input,sources,settings,authorized,title)=>authorized()&&svc.createTask({...input,selectedSkills:[]},{projectInputs:{title,sources,settings}}),stop:async()=>{}};
  agent=new ProjectAgent(service,host);
  t.after(()=>{service.close();rmSync(root,{recursive:true,force:true});});
  const a=service.store.createCanvas({title:'采访',operationId:randomUUID()}).id,b=service.store.createCanvas({title:'制作',operationId:randomUUID()}).id;
  const {material}=service.canvas.addMaterial({requirementId:a,title:'采访甲',content:'采访的冻结正文',operationId:randomUUID()});
  const session=(await agent.session()).sessionId;
  const turn=agent.turn({sessionId:session,requirementId:a,refs:[{cardId:'material:'+material.id}],mode,text:'用采访写脚本，再做分镜'});
  const plan={title:'两项交付',steps:[{type:'text',title:'脚本',instruction:'写脚本',requirementId:b},{type:'text',title:'分镜',instruction:'按脚本制作分镜',useSelection:false,dependsOn:[1],requirementId:a}]};
  const propose=()=>agent.tool(session,'plan',turn.id,plan);
  function restart(){service.close();service=new WorkbenchService({workspaceRoot:root});agent=new ProjectAgent(service,host);}
  async function publish(i,extra={}){
    const {sid,prepared}=sent[i],file=prepared.deliveryDirectory+'/result'+i+(extra.primary===false?'attach':'')+'.md';
    writeFileSync(path.join(root,file),'# 已保存的内容');
    return service.tasks.files.register({operationId:randomUUID(),taskId:prepared.taskId,kind:'text',title:'成果 '+i,path:file,...extra},{sessionId:sid});
  }
  return {get agent(){return agent},get service(){return service},host,sent,a,b,root,session,turn,plan,propose,restart,publish};
}
for(const [mode,approvals] of [['auto',0],['plan',1],['step',2]])test('跨画布冻结、冷启动、实际主产物与 '+mode+' 授权',async t=>{
  const f=await fixture(t,mode);f.agent.memory.save({name:'画幅',body:'横屏'});f.propose();f.propose();
  let count=0;const approve=async(command,stepId)=>{count++;await f.agent.control({id:f.turn.id,command,stepId,scopeToken:f.agent.approvalToken(f.turn.id)});};
  await f.agent.tick();if(mode!=='auto'){assert.equal(f.sent.length,0);await approve(mode==='plan'?'approve-plan':'approve-step',f.agent.steps(f.turn.id)[0].id);}
  f.restart();await f.agent.tick();await f.agent.tick();assert.equal(f.sent.length,1);
  const first=f.service.tasks.get(f.sent[0].prepared.taskId);assert.equal(first.input.sources[0].requirementId,f.a);assert.equal(first.requirementId,f.b);
  assert.match(first.input.sources[0].content,/冻结正文/);assert.match(f.sent[0].prepared.prompt,/横屏/);
  await f.publish(0,{primary:false,presentation:'attachment'});await f.agent.tick();assert.equal(f.sent.length,1);
  await f.publish(0,{primary:true});await f.agent.tick();f.restart();await f.agent.tick();
  if(mode==='step'){assert.equal(f.sent.length,1);await approve('approve-step',f.agent.steps(f.turn.id)[1].id);await f.agent.tick();}
  assert.equal(f.sent.length,2);const second=f.service.tasks.get(f.sent[1].prepared.taskId);
  assert.equal(second.input.sources[0].versionId,first.cardVersionId||f.service.tasks.get(first.id).cardVersionId);
  assert.equal(second.input.sources[0].requirementId,f.b);await f.publish(1,{primary:true});
  await f.agent.tick();await f.agent.tick();assert.equal(f.agent.plans()[0].state,'done');assert.equal(count,approvals);
  assert.ok(f.agent.memory.search('成果').length);assert.equal(f.agent.sessionId(),f.session);
});
test('暂停、回执未知、重开和更换总会话均不会重新派发',async t=>{
  const f=await fixture(t,'auto');f.propose();await f.agent.control({id:f.turn.id,command:'pause'});f.restart();await f.agent.tick();assert.equal(f.sent.length,0);
  f.host.prompt=async()=>{f.sent.push('received');throw Error('通信中断');};
  await f.agent.control({id:f.turn.id,command:'resume'});await f.agent.tick();f.restart();await f.agent.tick();
  assert.equal(f.sent.length,1);assert.match(f.agent.steps(f.turn.id)[0].error,/通信中断/);
  await f.agent.session(f.session);assert.throws(()=>f.propose(),/已绑定/);await f.agent.control({id:f.turn.id,command:'stop'});await f.agent.tick();assert.equal(f.sent.length,1);
});
test('设定读取外部原文、并发保护、局部覆盖、撤销和跨月检索',async t=>{
  const f=await fixture(t);const m=f.agent.memory;
  const general=m.save({name:'画幅',body:'竖屏'}).setting;
  const item=m.save({name:'画幅',scope:'第二集',body:'横屏'}).setting;
  const file=path.join(f.root,'.wtt-workbench/memory',item.relative);
  writeFileSync(file,'外部校正');assert.equal(m.effective(['第二集'])[0].body,'外部校正');
  const conflict=m.save({...item,body:'草稿',baseRevision:item.revision});assert.equal(conflict.current.body,'外部校正');
  m.save({...conflict.current,body:'',baseRevision:conflict.current.revision});m.project({rebuild:true});
  assert.equal(m.effective(['第二集'])[0].revision,general.revision);
  m.event('g08','修正','G08 视频可播放但无法引用','补登记为主产物',{cardId:'G08'},'2026-09-01');
  m.event('g06','修正','G06 视频不能拖动时间条','修复播放定位',{cardId:'G06'},'2026-11-01');
  for(let i=0;i<1000;i++)m.event('noise'+i,'记录','无关 '+i,'普通内容');
  m.project();assert.equal(m.search('之前 G08 视频无法引用')[0].id,'g08');assert.equal(m.search('拖动时间条')[0].id,'g06');
  assert.equal(m.search('能播但加不到引用',{cardId:'G08'})[0].id,'g08');
  assert.equal(m.search('视频',{cardId:'G06'}).length,1);assert.equal(m.search('2026-09 视频')[0].id,'g08');
  assert.equal(m.entry('g08').body,'补登记为主产物');
  assert.match(readFileSync(path.join(f.root,'.wtt-workbench/memory/log/2026-09.md'),'utf8'),/G08/);
  rmSync(path.join(f.root,'.wtt-workbench/memory/log/2026-09.md'));m.project({rebuild:true});
  assert.ok(readFileSync(path.join(f.root,'.wtt-workbench/memory/log/2026-09.md'),'utf8').includes('G08'));
  const other=await fixture(t);assert.equal(other.agent.memory.search('G08').length,0);
  rmSync(file,{force:true});symlinkSync(path.join(f.root,'.wtt-workbench/workbench.sqlite'),file);
  assert.throws(()=>m.effective(['第二集']),/普通文件/);
});
test('更改派发范围只审批变更，拒绝保留原授权，旧范围不能批准新版',async t=>{
  const f=await fixture(t);f.propose();
  const token=f.agent.approvalToken(f.turn.id);
  const extra=()=>f.agent.turn({sessionId:f.session,requirementId:f.a,mode:'plan',text:'追加一个文本成果'}).id;
  const amend=id=>f.agent.tool(f.session,'amend',id,{planId:f.turn.id,steps:[{title:'片尾',type:'text',instruction:'写片尾',dependsOn:[2]}]});
  const reject=extra();amend(reject);
  await f.agent.control({id:f.turn.id,command:'reject-change',changeId:reject});
  assert.equal(f.agent.steps(f.turn.id).length,2);
  const next=extra();amend(next);await f.agent.control({id:f.turn.id,command:'accept-change',changeId:next});
  await assert.rejects(f.agent.control({id:f.turn.id,command:'approve-plan',scopeToken:token}),/范围已变化/);
  assert.equal(f.agent.steps(f.turn.id).length,3);
  await f.agent.control({id:f.turn.id,command:'approve-plan',scopeToken:f.agent.approvalToken(f.turn.id)});
  await f.agent.tick();assert.equal(f.sent.length,1);
  await f.agent.control({id:f.turn.id,command:'mode',mode:'step'});await f.publish(0,{primary:true});
  await f.agent.tick();await f.agent.tick();assert.equal(f.sent.length,1);
});
test('现有 Markdown 单一原文、范围变更复核与外部文件保留',async t=>{
  const f=await fixture(t,'auto'), m=f.agent.memory;
  const file=path.join(f.root,'画幅.md');writeFileSync(file,'横屏');
  const {setting}=m.bind({name:'画幅',scope:'项目',document:'画幅.md'});
  assert.equal(setting.body,'横屏');assert.throws(()=>m.bind({name:'别名',document:'画幅.md'}),/已绑定/);
  assert.throws(()=>m.bind({name:'危险路径',document:'../例.md'}),/项目内/);
  f.propose();writeFileSync(file,'竖屏');await f.agent.tick();
  const step=f.agent.steps(f.turn.id)[0];assert.equal(step.authorized,0);assert.match(step.error,/设定已更新/);
  await f.agent.control({id:f.turn.id,command:'approve-step',stepId:step.id});await f.agent.tick();
  assert.match(f.sent[0].prepared.prompt,/竖屏/);
  const current=m.effective([])[0];m.save({...current,body:'',baseRevision:current.revision});
  assert.equal(readFileSync(file,'utf8'),'竖屏');assert.equal(m.effective([]).length,0);
});
test('原生待确认阻止下游，恢复确认后按冻结来源修改同一成果卡',async t=>{
  const f=await fixture(t,'auto');let settled=false;f.host.settled=async()=>settled;
  f.propose();await f.agent.tick();await f.publish(0,{primary:true});await f.agent.tick();
  assert.equal(f.agent.steps(f.turn.id)[0].state,'working');assert.equal(f.sent.length,1);
  settled=true;await f.agent.tick();await f.agent.tick();assert.equal(f.sent.length,2);
  const first=f.service.tasks.get(f.sent[0].prepared.taskId),ref=first.input.sources[0];
  const revised=f.service.createTask({requirementId:f.b,operationId:randomUUID(),outputType:'text',selectedSkills:[],instruction:'修订脚本',
    generation:{mode:'revise',cardId:first.outputCardId,baseVersionId:first.cardVersionId},selectedCardIds:[ref.cardId],sourceRefs:[{cardId:ref.cardId,hash:ref.hash}]});
  assert.equal(revised.task.input.sources[0].requirementId,f.a);
  assert.equal(revised.task.input.sources[0].content,ref.content);
});

test('提交标记已落盘但没有回执时，重启仅核对原任务',async t=>{
  const f=await fixture(t,'auto');
  f.propose();await f.agent.tick();
  const id=f.sent[0].prepared.taskId;
  f.agent.db.prepare("UPDATE course_tasks SET status='submitting' WHERE id=?").run(id);
  f.restart();await f.agent.tick();await f.agent.tick();
  assert.equal(f.sent.length,1);
  assert.match(f.agent.steps(f.turn.id)[0].error,/回执.*核对/);
  await f.publish(0,{primary:true});await f.agent.tick();await f.agent.tick();
  assert.equal(f.sent.length,2);
});
test('取消失败保留停止请求，重开后重试原任务，后续步骤始终不派发',async t=>{
  const f=await fixture(t,'auto'); f.propose(); await f.agent.tick();
  const id=f.turn.id, taskId=f.sent[0].prepared.taskId, attempts=[];
  f.host.stop=async(_service,_canvas,task)=>{
    attempts.push(task); if(attempts.length===1)throw Error('取消暂时失败');
  };
  await assert.rejects(f.agent.control({id,command:'stop'}),/取消暂时失败/);
  assert.equal(f.agent.plans()[0].state,'stopping');
  f.restart();
  await assert.rejects(f.agent.control({id,command:'mode',mode:'auto'}));
  await f.agent.tick();await f.agent.control({id,command:'stop'});await f.agent.tick();
  assert.deepEqual(attempts,[taskId,taskId]);assert.equal(f.sent.length,1);assert.equal(f.agent.plans()[0].state,'stopped');
});

test('交错指定跨画布引用按画布读取，重复卡去重且整步共享正文上限',async t=>{
  const f=await fixture(t), refs=[];
  for(let i=0;i<20;i++){
    const requirementId=i%2?f.a:f.b;
    const {material}=f.service.canvas.addMaterial({requirementId,title:'素材'+i,content:String(i%10).repeat(8192),operationId:randomUUID()});
    refs.push({requirementId,cardId:'material:'+material.id});
  }
  const getBoard=f.service.canvas.getBoard.bind(f.service.canvas),reads=[];
  f.service.canvas.getBoard=(id,...rest)=>{reads.push(id);return getBoard(id,...rest);};
  const plan={title:'跨画布',steps:[{...f.plan.steps[0],refs:[...refs,refs[0]],useSelection:false}]};
  f.agent.tool(f.session,'plan',f.turn.id,plan);const sources=f.agent.steps(f.turn.id)[0].data.sources;
  assert.deepEqual(reads,[f.b,f.a]);assert.deepEqual(sources.map(s=>s.cardId),refs.map(r=>r.cardId));
  assert.equal(sources.reduce((n,s)=>n+s.content.length,0),60000);
  assert.equal(sources[7].content.length,2656);assert.ok(sources[8].noteTruncated);
  const anchor=refs.at(-1);
  const next=f.agent.turn({sessionId:f.session,requirementId:anchor.requirementId,refs:[anchor],mode:'plan',text:'先读选中的卡'});
  f.agent.tool(f.session,'plan',next.id,{title:'按选区顺序取正文',steps:[{...f.plan.steps[0],refs}]});
  const combined=f.agent.steps(next.id)[0].data.sources;
  assert.equal(combined[0].cardId,anchor.cardId);
  assert.equal(combined[0].content.length,8192);
  assert.equal(combined.reduce((n,s)=>n+s.content.length,0),60000);
});

test('待办统计与分页包含最早的委托，百条完成记录不会挤走待确认',async t=>{
  const f=await fixture(t);const ids=[];
  for(let i=0;i<101;i++){
    const {id}=f.agent.turn({sessionId:f.session,requirementId:f.a,mode:'plan',text:'创建计划'});
    f.agent.tool(f.session,'plan',id,{...f.plan,steps:[f.plan.steps[0]]});ids.push(id);
  }
  const all=Array.from({length:6},(_,page)=>f.agent.plans(page)).flat();
  assert.equal(new Set(all.map(p=>p.id)).size,101);
  assert.equal(f.agent.attention().filter(n=>n.type==='pending').length,101);
  assert.equal(f.agent.progress().waiting,101);
  f.agent.db.prepare("UPDATE pa_steps SET state='done',task_id=id WHERE plan_id<>?").run(ids[0]);
  f.agent.db.prepare("UPDATE pa_plans SET state='done' WHERE id<>?").run(ids[0]);
  assert.ok(f.agent.attention().some(n=>n.key==='plan:'+ids[0]));
});
test('旧项目升级短词索引后可查跨月旧日志、过滤卡片并重建',async t=>{
  const f=await fixture(t),m=f.agent.memory;
  m.event('archived','验收','原文末尾霞','最后二字云海',{cardId:'A'},'2025-01-01');
  m.event('second','验收','云海','需排除',{cardId:'B'},'2025-01-01');
  f.agent.db.exec('DROP TRIGGER pa_index_short; DROP TABLE pa_short_vocab; DROP TABLE pa_short_fts');
  f.restart();
  for(let round=0;round<2;round++){
    assert.deepEqual(f.agent.memory.search('2025-01 云海',{cardId:'A'}).map(r=>r.id),['archived']);
    assert.equal(f.agent.memory.search('霞')[0].id,'archived');
    f.agent.memory.project({rebuild:true});
  }
  f.agent.memory.event('later','复核','雪','已归档');
  assert.equal(f.agent.memory.search('雪')[0].id,'later');
});
