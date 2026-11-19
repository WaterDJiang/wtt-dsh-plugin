import { createHash, randomUUID } from 'node:crypto';
import { ProjectMemory } from './project-memory.mjs';
import { extractSkillNames } from './skill-commands.mjs';

export const modes = ['plan','auto','step'];
const supported = ['text','pptx','image','video'];
const checkText = (v,n) => typeof v === 'string' && !!v.trim() && v.length <= n;
const json = JSON.stringify;
const parse = JSON.parse;
const summary = ({cardId,requirementId,title,hash,versionId,outputCardId})=>({cardId,requirementId,title,hash,versionId,outputCardId});
const openPlans = "('approval','running','paused')";
const activePhases = ['awaiting-input','awaiting-approval','generating','unknown','failed'];

function limitSourceContent(sources) {
  let remaining=60000;
  return sources.map(source=>{
    const text=source.content||'';
    const size=Math.min(remaining,text.length,12000);
    remaining-=size;
    return size===text.length?source:{...source,content:text.slice(0,size),noteTruncated:'正文超过本次上下文上限，以下仅为节选；未包含的内容需按路径进一步读取'};
  });
}

export class ProjectAgent {
  constructor(service,host) {
    this.service=service; this.host=host; this.db=service.store.db; this.activeTurns=new Set(); this.stops=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS pa_session(singleton INTEGER PRIMARY KEY CHECK(singleton=1),session_id TEXT);
      CREATE TABLE IF NOT EXISTS pa_owned_sessions(id TEXT PRIMARY KEY);
      INSERT OR IGNORE INTO pa_owned_sessions SELECT session_id FROM pa_session WHERE session_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS pa_turns(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pa_plans(id TEXT PRIMARY KEY REFERENCES pa_turns(id),title TEXT NOT NULL,mode TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pa_steps(id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES pa_plans(id),seq INTEGER NOT NULL,data TEXT NOT NULL,
        authorized INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'ready',task_id TEXT,receipt TEXT,error TEXT, UNIQUE(plan_id,seq));
      CREATE TABLE IF NOT EXISTS pa_changes(id TEXT PRIMARY KEY REFERENCES pa_turns(id),plan_id TEXT NOT NULL REFERENCES pa_plans(id),start INTEGER NOT NULL,data TEXT NOT NULL,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pa_step_status ON pa_steps(state,task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS pa_open_change ON pa_changes(plan_id) WHERE state='pending';
      CREATE TABLE IF NOT EXISTS pa_suggestions(id TEXT PRIMARY KEY,data TEXT NOT NULL);`);
    const columns=new Set(this.db.prepare('PRAGMA table_info(pa_steps)').all().map(c=>c.name));
    if(!columns.has('interaction'))this.db.exec('ALTER TABLE pa_steps ADD COLUMN interaction TEXT');
    if(!columns.has('handoff'))this.db.exec('ALTER TABLE pa_steps ADD COLUMN handoff INTEGER NOT NULL DEFAULT 0');
    if(!columns.has('kept_version'))this.db.exec('ALTER TABLE pa_steps ADD COLUMN kept_version TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS pa_step_task ON pa_steps(task_id); CREATE INDEX IF NOT EXISTS pa_task_session ON course_tasks(session_id) WHERE session_id IS NOT NULL');
    // Older versions marked a plan stopped before the host acknowledged cancellation.
    this.db.exec(`UPDATE pa_plans SET state='stopping' WHERE state='stopped' AND EXISTS
      (SELECT 1 FROM pa_steps s WHERE s.plan_id=pa_plans.id AND s.task_id IS NOT NULL AND s.state NOT IN ('done','stopped'))`);
    this.memory=new ProjectMemory(service);
  }
  sessionId(){return this.db.prepare('SELECT session_id AS id FROM pa_session').get()?.id;}
  async session(replace) {
    const current=this.sessionId();
    if(replace!==undefined && replace!==current)throw Error('项目会话已更新，请重新打开助手');
    if(this.opening)return this.opening;
    if(replace===undefined && current)return {sessionId:current};
    if(current && this.host.sessionRunning?.(current))throw Error('项目助手正在回复，请等本轮结束后再新建对话');
    this.opening=(async()=>{
      const id=await this.host.createSession(this.service);
      this.db.prepare('INSERT OR IGNORE INTO pa_owned_sessions VALUES(?)').run(id);
      this.host.bound?.(this.service,id);
      this.db.prepare('INSERT INTO pa_session VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET session_id=excluded.session_id').run(id);
      return {sessionId:id};
    })().finally(()=>{this.opening=null});
    return this.opening;
  }
  requireSession(id) {if (!id || id!==this.sessionId()) throw Error('只能由本项目已绑定的助手对话操作');}
  canvas(id){const r=this.service.store.getRequirement(id);if(!r)throw Error('目标画布已失效或不属于当前项目');return r;}
  freeze(requirementId, refs, options) {
    if (!Array.isArray(refs)||refs.length>24)throw Error('一次最多引用 24 张卡片');
    if (!refs.length)return [];
    this.canvas(requirementId);
    const visible=this.service.canvas.getBoard(requirementId).nodes;
    const identities=refs.map(ref=>{
      const card=visible.find(n=>n.id===ref.cardId||n.sourceId===ref.cardId||n.outputCard?.id===ref.cardId);
      if(!card)throw Error('所选卡片已移除或不属于来源画布');
      const output=card.outputCard;
      if(output&&!output.versionId)throw Error('「'+card.title+'」尚未生成正式版本');
      const v=output?this.service.cards.describe({requirementId,cardId:output.id,versionId:ref.versionId||output.versionId}).version:null;
      const sourceId=v?.primaryRef||card.sourceId||card.id;
      const attachment=this.db.prepare("SELECT role FROM output_card_outputs WHERE source_ref=?").get(sourceId);
      if(attachment?.role==='attachment')throw Error('请选择正式成果卡或其主版本');
      return {cardId:sourceId,hash:ref.hash,requirementId,outputCardId:output?.id,versionId:v?.id};
    });
    const prepared=this.service.prepareCanvas({requirementId,selectedCardIds:identities.map(r=>r.cardId),instruction:'冻结项目引用'},options);
    return identities.map(r=>{
      const src=prepared.context.find(s=>s.cardId===r.cardId);
      if(!src || (r.hash && src.hash!==r.hash))throw Error('引用内容已变化，请重新选择');
      return {...src,requirementId,outputCardId:r.outputCardId,versionId:r.versionId};
    });
  }
  freezeByCanvas(refs, defaultCanvas) {
    const groups=new Map(), result=new Array(refs.length);
    refs.forEach((ref,index)=>{
      const canvas=ref.requirementId||defaultCanvas;
      if(!groups.has(canvas))groups.set(canvas,[]);
      groups.get(canvas).push({ref,index});
    });
    for(const [canvas,items] of groups){
      const sources=this.freeze(canvas,items.map(item=>item.ref),{deferCombinedBudget:true});
      items.forEach((item,i)=>{result[item.index]=sources[i];});
    }
    return result;
  }
  turn({sessionId,requirementId,refs=[],mode,text}) {
    if(this.opening)throw Error('项目会话正在切换，请稍后发送');
    this.requireSession(sessionId); if(!modes.includes(mode)||!checkText(text,8000))throw Error('执行档位或创作要求无效');
    this.canvas(requirementId);
    if(!Array.isArray(refs)||refs.length>24)throw Error('一次最多引用 24 张卡片');
    const sources=limitSourceContent(this.freezeByCanvas(refs,requirementId));
    const id=randomUUID();
    this.db.prepare('INSERT INTO pa_turns VALUES(?,?,?)').run(id,sessionId,json({sessionId,requirementId,mode,sources,text,skills:extractSkillNames(text)}));
    return {id};
  }
  promptContext(sessionId,requestId){
    const row=this.db.prepare('SELECT data FROM pa_turns WHERE id=? AND session_id=?').get(requestId,sessionId);
    if(!row)return null;
    this.activeTurns.add(requestId);
    const turn=parse(row.data);
    const context={turnId:requestId,mode:turn.mode,canvas:{id:turn.requirementId,title:this.canvas(turn.requirementId).title},sources:turn.sources.map(summary)};
    if(turn.skills?.length)context.skills=turn.skills;
    return '[工作台发送现场] '+json(context)+'\n你是这个项目的画布助手。使用 workbench_project，通过 context 查委托、有效设定及相关日志，必要时用 cards 找其他画布的卡、read-card 查指定版本节选，search 可按画布／版本筛选，evidence 用 eventId 读日志原文。生成成果用 plan 提交步骤，追加交付或更改尚未派发的范围用 amend。发送现场的 skills 是用户为本轮调用的技能。委托步骤需要其中的技能时，在该步骤 instruction 中用独立的 /技能名 标明，使原任务也加载该技能。按真实回执报告结果。多份匹配先请用户选择。用 suggest 提请用户保存长期设定，log 记录事实和原因。暂停和停止可调用对应工具。等待任务时说明进度，无须循环查询。';
  }
  steps(id){return this.db.prepare('SELECT * FROM pa_steps WHERE plan_id=? ORDER BY seq').all(id).map(r=>({...r,data:parse(r.data),receipt:r.receipt?parse(r.receipt):null}));}
  waitingConsumers(step){
    return this.db.prepare(`SELECT json_extract(s.data,'$.title') AS title FROM pa_steps s
      JOIN json_each(s.data,'$.deps') d ON d.value=? LEFT JOIN operations o ON o.id=s.id AND o.kind='create-task'
      WHERE s.plan_id=? AND s.seq>? AND s.state IN ('ready','blocked') AND s.task_id IS NULL AND o.id IS NULL
      ORDER BY s.seq`).all(step.seq,step.plan_id,step.seq).map(row=>row.title);
  }
  linkedCard({requirementId,cardId,taskId,stepId}={}){
    if(typeof requirementId!=='string'||(!cardId&&!taskId))return null;
    // The card is assigned by the original task. Another version's task can locate that same card.
    const card=cardId||this.service.cards.binding(taskId)?.outputCardId;
    if(!card)return null;
    return this.db.prepare(`SELECT s.*,c.id AS card_id,c.requirement_id
      FROM output_cards c JOIN output_card_tasks b ON b.card_id=c.id JOIN pa_steps s ON s.task_id=b.task_id
      JOIN pa_plans p ON p.id=s.plan_id WHERE c.id=? AND c.requirement_id=? AND p.state IN ${openPlans}
      AND (? IS NULL OR s.id=?) ORDER BY s.rowid DESC LIMIT 1`).get(card,requirementId,stepId??null,stepId??null)||null;
  }
  versionChoice(step){
    const receipt=typeof step.receipt==='string'?parse(step.receipt):step.receipt;
    const cardId=step.card_id||receipt?.cardId;
    if(!cardId||(!step.handoff&&!receipt))return null;
    const head=this.db.prepare(`SELECT v.id AS versionId,v.number,v.task_id AS taskId,c.requirement_id AS requirementId
      FROM output_cards c JOIN output_card_versions v ON v.id=c.head_version_id
      WHERE c.id=? AND v.card_id=c.id AND v.legacy=0`).get(cardId);
    if(!head||(!step.handoff && [receipt.versionId,step.kept_version].includes(head.versionId)))return null;
    if(receipt && head.versionId!==receipt.versionId && !this.db.prepare(`WITH RECURSIVE ancestors(id) AS (
        SELECT ? UNION SELECT v.base_version_id FROM output_card_versions v JOIN ancestors a ON a.id=v.id
        WHERE v.card_id=? AND v.base_version_id IS NOT NULL) SELECT 1 FROM ancestors WHERE id=?`).get(head.versionId,cardId,receipt.versionId))return null;
    return {...head,cardId};
  }
  cardHandoff(input){
    const s=this.linkedCard(input);
    if(!s)return null;
    const consumers=this.waitingConsumers(s);
    if(s.state==='done'&&!consumers.length&&!s.handoff)return null;
    return {planId:s.plan_id,stepId:s.id,taskId:s.task_id,cardId:s.card_id,requirementId:s.requirement_id,
      handoff:Boolean(s.handoff),title:parse(s.data).title,receipt:s.receipt?parse(s.receipt):null,choice:this.versionChoice(s),consumers};
  }
  takeOver(input){
    const s=this.linkedCard(input);
    if(!s||(s.state==='done'&&!this.waitingConsumers(s).length))return null;
    if(input.id&&input.id!==s.plan_id)throw Error('委托已变化，请重新打开卡片');
    if(this.db.prepare('UPDATE pa_steps SET handoff=1 WHERE id=? AND handoff=0').run(s.id).changes){
      this.memory.event(randomUUID(),'任务交接',parse(s.data).title,'用户接管此步骤',{planId:s.plan_id,taskId:s.task_id,cardId:s.card_id});
    }
    return this.cardHandoff({...input,cardId:s.card_id});
  }
  nativeInput(sessionId,requestIds){
    const rows=this.db.prepare(`SELECT t.requirement_id AS requirementId,t.id AS taskId,t.request_id AS requestId
      FROM course_tasks t JOIN pa_steps s ON s.task_id=t.id JOIN pa_plans p ON p.id=s.plan_id
      WHERE t.session_id=? AND p.state IN ${openPlans}`).all(sessionId);
    for(const row of rows)if(!requestIds||requestIds.some(id=>id!==row.requestId))this.takeOver(row);
  }
  async chooseVersion(input){
    const read=()=>this.cardHandoff(input);
    const current=read();
    if(!current||current.planId!==input.id||current.stepId!==input.stepId)throw Error('步骤已变化，请重新打开卡片');
    if(!current.handoff&&current.receipt?.versionId===input.versionId&&input.command!=='keep-version')return current;
    if(!current.choice||current.choice.versionId!==input.versionId)throw Error('卡片版本已变化，请核对当前成果');
    const keep=input.command==='keep-version';
    if(keep){
      if(current.handoff||!current.receipt)throw Error('请先选择此步骤的交付版本');
      this.db.prepare('UPDATE pa_steps SET kept_version=? WHERE id=?').run(input.versionId,input.stepId);
      return read();
    }
    for(const taskId of new Set([current.taskId,current.choice.taskId])){
      const task=this.service.tasks.get(taskId);
      if(task.kind==='ai' && (task.dispatchStatus==='submitting'||await this.host.pending?.(this.service,task)||
        (task.sessionId&&this.host.settled&&!await this.host.settled(this.service,task))))throw Error('卡片任务仍在运行或待确认，请先在原对话处理');
    }
    const latest=read();
    if(!latest||json(latest)!==json(current)){
      if(latest&&!latest.handoff&&latest.receipt?.versionId===input.versionId)return latest;
      throw Error('任务状态已变化，请重新核对版本');
    }
    const {number,cardId,requirementId,versionId,taskId}=current.choice;
    const {node}=this.service.cards.describe({requirementId,cardId,versionId});
    if(!node.sourceHash||['missing','changed','modified','unavailable'].includes(node.status))throw Error('正式成果文件不可用，请重新核对版本');
    this.db.prepare("UPDATE pa_steps SET state='done',handoff=0,receipt=?,kept_version=NULL,interaction=NULL,error=NULL WHERE id=?")
      .run(json({number,cardId,requirementId,versionId,hash:node.sourceHash}),input.stepId);
    this.memory.event(randomUUID(),'任务交接',current.title,`已采用 V${number}`,{planId:current.planId,taskId,cardId,versionId});
    return read();
  }
  approvalToken(id){
    const ids=this.db.prepare('SELECT id FROM pa_steps WHERE plan_id=? ORDER BY seq').all(id);
    return createHash('sha256').update(json(ids)).digest('hex');
  }
  pendingEvents(){
    const rows=this.db.prepare(`SELECT p.id AS planId,p.state AS planState,s.id,s.state,s.authorized,s.interaction,s.task_id AS taskId,s.error,s.handoff
      FROM pa_plans p JOIN pa_steps s ON s.id=(SELECT t.id FROM pa_steps t WHERE t.plan_id=p.id AND (t.state!='done' OR t.handoff=1) ORDER BY seq LIMIT 1)
      WHERE p.state IN ('approval','running','paused','stopping')`).all();
    const changes=this.db.prepare("SELECT c.id,c.plan_id AS planId FROM pa_changes c JOIN pa_plans p ON p.id=c.plan_id WHERE c.state='pending' AND p.state NOT IN ('stopping','stopped','done')").all();
    const pending=changes.map(c=>({planId:c.planId,key:'change:'+c.id}));
    for(const row of rows){
      let key;
      if(row.planState==='stopping')key='stop:'+row.planId;
      else if(row.planState==='approval')key='plan:'+row.planId;
      else if(row.interaction)key=json([row.taskId,row.interaction]);
      else if(row.handoff)key='handoff:'+row.id;
      else if(row.planState==='running'&&(row.state==='blocked'||!row.authorized||row.error))key=row.state+':'+row.id;
      if(key)pending.push({planId:row.planId,key});
    }
    return pending;
  }
  attention(){
    const completed=this.db.prepare("SELECT task_id FROM pa_steps WHERE state='done' AND task_id IS NOT NULL ORDER BY rowid DESC LIMIT 100").all();
    return this.pendingEvents().map(({key})=>({key,type:'pending'})).concat(completed.map(r=>({key:'task:'+r.task_id,type:'completed'})));
  }
  progress(){
    const counts=this.db.prepare("SELECT count(*) AS total,count(*) FILTER(WHERE state NOT IN ('done','stopped')) AS active,count(*) FILTER(WHERE state='approval') AS approvals FROM pa_plans").get();
    const steps=this.db.prepare(`SELECT count(task_id) AS assigned,count(*) FILTER(WHERE state='done') AS completed,
      count(*) FILTER(WHERE state='blocked') AS blocked,count(*) FILTER(WHERE state='stopped') AS stopped FROM pa_steps`).get();
    return {...counts,waiting:new Set(this.pendingEvents().map(e=>e.planId)).size,signature:[steps.assigned,steps.completed,steps.blocked,steps.stopped].join('/')};
  }
  plans(page=0){
    if(!Number.isSafeInteger(page)||page<0||page>1000000)throw Error('委托页码无效');
    return this.db.prepare("SELECT * FROM pa_plans ORDER BY CASE WHEN state='approval' THEN 0 WHEN state IN ('done','stopped') THEN 2 ELSE 1 END,rowid DESC LIMIT 20 OFFSET ?").all(page*20).map(plan=>this.planView(plan));
  }
  reviews(sessionId,page=0){
    if(!Number.isSafeInteger(page)||page<0)throw Error('确认页码无效');
    const read=this.db.prepare(`SELECT p.*,count(*) OVER() AS total,
      CASE WHEN amendment.session_id=$session THEN 'change' WHEN p.state='approval' THEN 'plan' ELSE 'step' END AS kind,
      s.id AS stepId
      FROM pa_plans p JOIN pa_turns t ON t.id=p.id
      LEFT JOIN pa_changes c ON c.plan_id=p.id AND c.state='pending'
      LEFT JOIN pa_turns amendment ON amendment.id=c.id
      LEFT JOIN pa_steps s ON s.id=(SELECT n.id FROM pa_steps n WHERE n.plan_id=p.id AND (n.state<>'done' OR n.handoff=1) ORDER BY n.seq LIMIT 1)
      WHERE p.state IN ${openPlans} AND (amendment.session_id=$session OR (t.session_id=$session AND
        (p.state='approval' OR (p.state='running' AND s.state='ready' AND s.authorized=0 AND s.handoff=0 AND (c.id IS NULL OR s.seq<c.start)))))
      ORDER BY p.rowid LIMIT 1 OFFSET $page`);
    const at=index=>read.get({session:sessionId??null,page:index});
    let index=page,row=at(page);
    if(!row&&page>0){
      const first=at(0);
      if(first){index=first.total-1;row=index?at(index):first;}
    }
    if(!row)return {total:0,page:0,item:null};
    const {kind,stepId,total,...plan}=row;
    return {total,page:index,item:{kind,stepId,plan:this.planView(plan)}};
  }
  planView(plan){
    const describe=d=>({title:d.title,instruction:d.instruction,target:this.db.prepare('SELECT title FROM requirements WHERE id=?').get(d.requirementId)?.title||'已移除的画布',requirementId:d.requirementId,type:d.type,refs:d.sources.map(summary),deps:d.deps});
    const change=this.change(plan.id);
    return {...plan,scopeToken:this.approvalToken(plan.id),change:change&&{id:change.id,start:change.start,steps:change.data.map(describe)},
      steps:this.steps(plan.id).map(s=>{
        const binding=s.task_id?this.service.cards.binding(s.task_id):null;
        const cardId=binding?.outputCardId;
        const active=!['done','stopped','stopping'].includes(plan.state);
        const consumers=cardId&&active&&(s.handoff||s.receipt)?this.waitingConsumers(s):[];
        const choice=cardId&&active&&(s.handoff||consumers.length)?this.versionChoice({...s,card_id:cardId}):null;
        return {id:s.id,...describe(s.data),state:s.state,authorized:!!s.authorized,error:s.error,interaction:s.interaction,
          taskId:s.task_id,outputCardId:cardId,receipt:s.receipt,handoff:active&&Boolean(s.handoff),choice,consumers};
      })};
  }
  normalizeSteps(data,turn,offset=0) {
    if(!Array.isArray(data.steps)||!data.steps.length||data.steps.length+offset>20)throw Error('每份委托最多 20 项交付');
    return data.steps.map((step,i)=>{
      const requirementId=step.requirementId||turn.requirementId;
      this.canvas(requirementId);
      if(!supported.includes(step.type)||!checkText(step.title,160)||!checkText(step.instruction,4000))throw Error('步骤缺少标题、类型或指令');
      const deps=step.dependsOn||[];
      if (!Array.isArray(deps)||deps.some(d=>!Number.isInteger(d)||d<1||d>i+offset))throw Error('依赖请使用前面步骤的序号（从 1 开始）');
      if(step.refs!==undefined&&(!Array.isArray(step.refs)||step.refs.length>24))throw Error('每步最多引用 24 张卡');
      const sources=new Map((step.useSelection===false?[]:turn.sources).map(r=>[r.cardId,r]));
      for(const source of this.freezeByCanvas(step.refs||[],turn.requirementId))sources.set(source.cardId,source);
      if(sources.size+deps.length>24)throw Error('每步引用与依赖总数不可超过 24');
      const scope=step.scope||'';
      if(typeof scope!=='string'||scope.length>120)throw Error('设定范围无效');
      const revisions=this.memory.effective([requirementId,scope].filter(Boolean)).map(s=>[s.id,s.revision]);
      return {title:step.title,type:step.type,instruction:step.instruction,requirementId,revisions,deps:[...new Set(deps)],sources:limitSourceContent([...sources.values()]),scope,review:step.review===true,sessionId:turn.sessionId};
    });
  }
  change(planId){
    const row=this.db.prepare("SELECT * FROM pa_changes WHERE plan_id=? AND state='pending'").get(planId);
    return row && {...row,data:parse(row.data)};
  }
  amend(turnId,data,turn){
    const plan=this.db.prepare('SELECT * FROM pa_plans WHERE id=?').get(data.planId||'');
    if(!plan||['done','stopped','stopping'].includes(plan.state))throw Error('请选择尚未结束的委托');
    const prior=this.db.prepare('SELECT state FROM pa_changes WHERE id=?').get(turnId);
    if(prior)return prior;
    if(this.change(plan.id))throw Error('请先处理现有范围变更');
    const previous=this.steps(plan.id),start=data.replaceFrom??previous.length+1;
    if(!Number.isInteger(start)||start<1||start>previous.length+1||previous.slice(start-1).some(s=>s.task_id||s.state!=='ready'))throw Error('只能变更未派发的步骤');
    const steps=this.normalizeSteps(data,turn,start-1);
    this.db.prepare("INSERT INTO pa_changes VALUES(?,?,?,?, 'pending')").run(turnId,plan.id,start,json(steps));
    this.memory.event('change-'+turnId,'委托',plan.title,'提出范围变更：'+steps.map(s=>s.title).join('、'),{planId:plan.id});
    if(plan.mode==='auto'&&turn.mode==='auto')this.resolveChange(plan,turnId,true);
    return {planId:plan.id,changeId:turnId};
  }
  resolveChange(plan,changeId,approve){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const change=this.change(plan.id);
      if(!change||change.id!==changeId)throw Error('范围变更已处理，请刷新');
      if(approve){
        const affected=this.steps(plan.id).slice(change.start-1);
        if(affected.some(s=>s.task_id||s.state!=='ready'))throw Error('步骤已经派发，请重新拟定变更');
        this.db.prepare('DELETE FROM pa_steps WHERE plan_id=? AND seq>=?').run(plan.id,change.start);
        for(const [i,item] of change.data.entries())this.db.prepare('INSERT INTO pa_steps(id,plan_id,seq,data,authorized) VALUES(?,?,?,?,?)')
          .run(randomUUID(),plan.id,change.start+i,json(item),Number(plan.mode!=='step'&&plan.state!=='approval'&&!item.review));
      }
      this.db.prepare('UPDATE pa_changes SET state=? WHERE id=?').run(approve?'accepted':'rejected',change.id);
      this.memory.event('decision-'+change.id,'委托',plan.title,approve?'已批准范围变更':'已保留原计划',{planId:plan.id});
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  proposal(turnId,data,turn) {
    if (this.db.prepare('SELECT 1 FROM pa_plans WHERE id=?').get(turnId))return {planId:turnId,alreadyRecorded:true};
    if(!checkText(data.title,120)||!Array.isArray(data.steps)||!data.steps.length||data.steps.length>20)throw Error('计划需有标题和 1–20 项交付');
    const steps=this.normalizeSteps(data,turn);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO pa_plans VALUES(?,?,?,?)').run(turnId,data.title,turn.mode,turn.mode==='plan'?'approval':'running');
      steps.forEach((s,i)=>this.db.prepare('INSERT INTO pa_steps(id,plan_id,seq,data,authorized) VALUES(?,?,?,?,?)').run(randomUUID(),turnId,i+1,json(s),Number(turn.mode==='auto'&&!s.review)));
      this.memory.event('plan-'+turnId,'委托',data.title,steps.map(s=>s.title).join(' → '),{planId:turnId});
      this.db.exec('COMMIT');
    } catch(e){this.db.exec('ROLLBACK');throw e;}
    return {planId:turnId,mode:turn.mode,steps:steps.map(s=>s.title)};
  }
  tool(sessionId,action,turnId,data={}) {
    this.requireSession(sessionId);
    if(action==='cards') return this.service.canvas.getBoard(this.canvas(data.requirementId).id).nodes.filter(n=>!n.outputCard||n.outputCard.versionId).filter(n=>!data.query||n.title?.includes(data.query)).slice(0,80).map(n=>({cardId:n.id,title:n.title,versionId:n.outputCard?.versionId,hash:n.sourceHash}));
    if(action==='search')return this.memory.search(data.query,data);
    if(action==='evidence')return this.memory.entry(data.eventId);
    if(action==='read-card'){
      const [source]=this.freeze(data.requirementId,[{cardId:data.cardId,versionId:data.versionId}]);
      return {...summary(source),kind:source.kind,excerpt:(source.content||source.excerpt||'').slice(0,3000)};
    }
    const row=this.db.prepare('SELECT data FROM pa_turns WHERE id=? AND session_id=?').get(turnId||'',sessionId);
    if(!row)throw Error('请使用本条用户消息的发送现场 turnId');
    const turn=parse(row.data);
    if(action==='details'){
      const plan=this.db.prepare('SELECT * FROM pa_plans WHERE id=?').get(data.planId||'');
      if(!plan)throw Error('委托不存在');return {...plan,steps:this.steps(plan.id).map(s=>({title:s.data.title,instruction:s.data.instruction,refs:s.data.sources.map(summary),state:s.state,handoff:Boolean(s.handoff),taskId:s.task_id,receipt:s.receipt}))};
    }
    if(action==='context') return {current:{canvas:turn.requirementId,sources:turn.sources.map(summary)},canvases:this.db.prepare('SELECT id,title FROM requirements ORDER BY updated_at DESC,id').all(),settings:this.memory.effective([turn.requirementId,data.scope].filter(Boolean)),scopes:this.db.prepare('SELECT DISTINCT scope FROM pa_settings WHERE rev IS NOT NULL ORDER BY scope LIMIT 60').all().map(s=>s.scope),plans:this.plans().slice(0,8).map(p=>({id:p.id,title:p.title,state:p.state,next:p.steps.find(s=>s.state!=='done'||s.handoff)?.title,handoff:p.steps.find(s=>s.handoff)?.title,lastResult:p.steps.filter(s=>s.receipt).at(-1)?.receipt})),history:this.memory.search(data.query||turn.text).slice(0,2)};
    if(action==='pause'||action==='stop')return this.control({id:data.planId,command:action});
    if(action==='amend')return this.amend(turnId,data,turn);
    if(action==='plan')return this.proposal(turnId,data,turn);
    if(action==='log'){
      if(!checkText(data.title,120)||!checkText(data.body,3000))throw Error('请填写事实标题和日志原文');
      const evidence={turnId,requirementId:turn.requirementId};
      if(data.taskId){const task=this.service.tasks.get(data.taskId);Object.assign(evidence,{taskId:task.id,requirementId:task.requirementId});}
      if(data.cardId){const [ref]=this.freeze(data.requirementId||evidence.requirementId,[{cardId:data.cardId,versionId:data.versionId}]);Object.assign(evidence,summary(ref),{cardId:ref.outputCardId||ref.cardId});}
      this.memory.event(turnId+'-'+data.title,'创作日志',data.title,data.body,evidence);return {saved:true};
    }
    if(action==='suggest'){
      if(!checkText(data.name,80)||!checkText(data.body,4000)||data.scope&&!checkText(data.scope,120))throw Error('设定名称或正文无效');
      const item={name:data.name,body:data.body,scope:data.scope||'项目'};
      this.db.prepare('INSERT OR IGNORE INTO pa_suggestions VALUES(?,?)').run(turnId+'-'+data.name,json(item));return {awaitingUser:true};
    }
    throw Error('未知的项目工具操作');
  }
  async finishStop(id, inspectOnly=false){
    if(this.stops.has(id))return this.stops.get(id);
    const operation=(async()=>{
      const pending=this.db.prepare(`SELECT s.id,coalesce(s.task_id,o.result_id) AS taskId,json_extract(s.data,'$.requirementId') AS canvas
        FROM pa_steps s LEFT JOIN operations o ON o.id=s.id AND o.kind='create-task'
        WHERE s.plan_id=? AND s.handoff=0 AND s.state NOT IN ('done','stopped') AND coalesce(s.task_id,o.result_id) IS NOT NULL`).all(id);
      for(const step of pending){
        this.db.prepare('UPDATE pa_steps SET task_id=? WHERE id=? AND task_id IS NULL').run(step.taskId,step.id);
        try{
          if(inspectOnly){
            if(!await this.host.stopConfirmed?.(this.service,step.canvas,step.taskId))return;
          }else await this.host.stop(this.service,step.canvas,step.taskId);
          this.db.prepare("UPDATE pa_steps SET state='stopped',error=NULL,interaction=NULL WHERE id=?").run(step.id);
        }catch(error){
          this.db.prepare('UPDATE pa_steps SET error=? WHERE id=?').run(String(error.message).slice(0,1200),step.id);
          if(!inspectOnly)throw error;
          return;
        }
      }
      this.db.prepare("UPDATE pa_steps SET state=CASE WHEN state='done' THEN state ELSE 'stopped' END,handoff=0,interaction=NULL,error=NULL WHERE plan_id=? AND handoff=1").run(id);
      if(this.db.prepare("UPDATE pa_plans SET state='stopped' WHERE id=? AND state='stopping'").run(id).changes){
        this.memory.event('stopped-'+id,'授权与控制','停止委托','已停止派发并核对助手负责的步骤',{planId:id});
      }
    })();
    this.stops.set(id,operation);
    try{await operation;}finally{this.stops.delete(id);}
  }
  async control(input) {
    const {id,command,stepId,changeId,mode,scopeToken}=input;
    if(command==='take-over'){
      const current=this.takeOver(input);
      if(!current)throw Error('此卡没有可接管的委托步骤');
      return current;
    }
    if(['use-version','keep-version'].includes(command))return this.chooseVersion(input);
    const plan=this.db.prepare('SELECT * FROM pa_plans WHERE id=?').get(id);
    if(!plan||['done','stopped'].includes(plan.state))throw Error('委托已结束或不存在');
    if(plan.state==='stopping'&&command!=='stop')throw Error('正在核对原任务停止状态');
    const setState=s=>this.db.prepare('UPDATE pa_plans SET state=? WHERE id=?').run(s,id);
    const steps=this.steps(id);
    if(command==='approve-plan' && this.approvalToken(id)!==scopeToken)throw Error('批准范围已变化，请刷新后核对计划');
    if(command==='recheck'){
      const s=steps.find(s=>s.id===stepId);
      if(!s||s.state!=='blocked'||s.task_id||this.db.prepare('SELECT 1 FROM operations WHERE id=?').get(s.id))throw Error('已有发送记录，请核对原任务');
      this.db.prepare("UPDATE pa_steps SET state='ready',error=NULL WHERE id=?").run(s.id);return this.plans();
    }
    if(command==='accept-change'||command==='reject-change'){this.resolveChange(plan,changeId,command==='accept-change');return this.plans();}
    if(command==='approve-plan' && plan.state==='approval' && plan.mode==='plan'){
      this.db.prepare("UPDATE pa_steps SET authorized=1 WHERE plan_id=? AND state='ready' AND json_extract(data,'$.review')=0").run(id);setState('running');
    } else if(command==='approve-step' && plan.state==='running'){
      const next=steps.find(s=>s.state!=='done'||s.handoff);
      if(next?.state!=='ready'||next.id!==stepId||next.authorized)throw Error('当前步骤已变化');
      this.db.prepare('UPDATE pa_steps SET authorized=1 WHERE id=?').run(stepId);
    } else if(command==='pause' && plan.state==='running')setState('paused');
    else if(command==='resume' && plan.state==='paused')setState(plan.mode==='plan'&&steps.some(s=>s.state==='ready'&&!s.authorized&&!s.data.review)?'approval':'running');
    else if(command==='mode' && modes.includes(mode)){
      this.db.prepare('UPDATE pa_plans SET mode=?,state=? WHERE id=?').run(mode,plan.state==='paused'?'paused':mode==='plan'?'approval':'running',id);
      this.db.prepare("UPDATE pa_steps SET state='ready',authorized=CASE WHEN ?='auto' AND json_extract(data,'$.review')=0 THEN 1 ELSE 0 END WHERE plan_id=? AND (state='ready' OR (state='working' AND task_id IN (SELECT id FROM course_tasks WHERE status='draft')))").run(mode,id);
    } else if(command==='stop'){
      setState('stopping');
      if(this.stops.has(id))await this.stops.get(id);
      if(this.db.prepare('SELECT state FROM pa_plans WHERE id=?').get(id).state==='stopping')await this.finishStop(id);
      return this.plans();
    } else throw Error('委托状态已变化，请刷新');
    this.memory.event(randomUUID(),'授权与控制',plan.title,command,{planId:id,stepId});
    return this.plans();
  }
  live(id){return !this.service.store.closed && this.db.prepare("SELECT 1 FROM pa_plans WHERE id=? AND state='running'").get(id);}
  async tick() {
    if(this.busy || this.service.store.closed)return;
    this.busy=true;
    try {
      if(this.host.stopConfirmed)for(const {id} of this.db.prepare("SELECT id FROM pa_plans WHERE state='stopping'").all())await this.finishStop(id,true);
      for(const {id,state} of this.db.prepare(`SELECT id,state FROM pa_plans p WHERE state IN ('running','paused') OR
        (state='approval' AND EXISTS (SELECT 1 FROM pa_steps s WHERE s.plan_id=p.id AND s.task_id IS NOT NULL AND s.state<>'done'))
        ORDER BY rowid`).all()){
        const pending=this.db.prepare(`SELECT s.*,o.result_id AS recovered_task FROM pa_steps s
          LEFT JOIN operations o ON s.task_id IS NULL AND o.id=s.id AND o.kind='create-task'
          WHERE s.plan_id=? AND (s.state<>'done' OR s.handoff=1) ORDER BY s.seq LIMIT 1`).get(id);
        const s=pending&&{...pending,data:parse(pending.data)};
        const change=this.change(id);
        if(!s){if(state==='running'&&!change){this.db.prepare("UPDATE pa_plans SET state='done' WHERE id=?").run(id);this.memory.event('done-'+id,'委托',this.db.prepare('SELECT title FROM pa_plans WHERE id=?').get(id).title,'已完成全部交付',{planId:id});}continue;}
        const dispatch=state==='running'&&s.authorized&&!s.handoff&&(!change||s.seq<change.start);
        if(!s.task_id&&!s.recovered_task&&(!dispatch||s.state==='blocked'))continue;
        try {await this.advance(id,s,dispatch);}
        catch(e){if(!this.service.store.closed){this.db.prepare("UPDATE pa_steps SET state='blocked',error=? WHERE id=? AND state<>'done'").run(String(e.message).slice(0,1200),s.id);
          this.memory.event('blocked-'+s.id,'步骤待核对',s.data.title,String(e.message).slice(0,1200),{planId:id,taskId:s.task_id});}}
      }
      this.memory.project();
    } finally {this.busy=false;}
  }
  dependencyReceipts(id,deps){
    if(!deps.length)return [];
    const read=this.db.prepare("SELECT * FROM pa_steps WHERE plan_id=? AND seq=? AND state='done' AND handoff=0");
    return deps.map(seq=>{
      const step=read.get(id,seq);
      return step?.receipt&&!this.versionChoice(step)?parse(step.receipt):null;
    });
  }
  async advance(id,s,dispatch) {
    const d=s.data;
    let receipts;
    const allowed=()=>dispatch&&this.live(id)&&this.db.prepare("SELECT authorized FROM pa_steps WHERE id=? AND handoff=0 AND state<>'done' AND NOT EXISTS (SELECT 1 FROM pa_changes WHERE plan_id=? AND state='pending' AND start<=?)").get(s.id,id,s.seq)?.authorized
      &&(!receipts||json(receipts)===json(this.dependencyReceipts(id,d.deps)));
    const stillObserving=()=>!this.service.store.closed&&this.db.prepare(`SELECT 1 FROM pa_steps s JOIN pa_plans p ON p.id=s.plan_id
      WHERE s.id=? AND s.task_id=? AND (s.state<>'done' OR s.handoff=1) AND p.state IN ${openPlans}`).get(s.id,task.id);
    const existingId=s.task_id||s.recovered_task;
    let task=existingId&&this.service.tasks.get(existingId);
    if(task&&!s.task_id)this.db.prepare("UPDATE pa_steps SET task_id=?,state='working' WHERE id=?").run(task.id,s.id);
    if(task){
      const saved=this.db.prepare('SELECT v.id AS versionId,v.card_id AS cardId,c.requirement_id AS requirementId,v.number FROM output_card_versions v JOIN output_card_tasks b ON b.card_id=v.card_id AND b.task_id=v.task_id JOIN output_cards c ON c.id=v.card_id WHERE v.task_id=? ORDER BY v.number LIMIT 1').get(task.id);
      const pending=await this.host.pending?.(this.service,task);
      if(!stillObserving())return;
      if(pending){
        if(s.interaction!==pending.callId)this.db.prepare("UPDATE pa_steps SET interaction=?,error='原任务待确认' WHERE id=?").run(pending.callId,s.id);
        return;
      }
      if(s.interaction)this.db.prepare('UPDATE pa_steps SET interaction=NULL,error=NULL WHERE id=?').run(s.id);
      const phase=task.runtimeState?.phase;
      const budget=this.service.production.usage(task.id)?.budgetStop;
      if(budget)throw Error(budget);
      if(saved && !s.handoff && !activePhases.includes(phase) && (!this.host.settled || await this.host.settled(this.service,task))){
        if(stillObserving())this.db.prepare("UPDATE pa_steps SET state='done',receipt=?,error=NULL WHERE id=? AND handoff=0").run(json(saved),s.id);
        return;
      }
      if(!stillObserving())return;
      if(s.state==='blocked')return;
      if(task.dispatchStatus==='submitting')return;
      if(['failed','unknown','cancelled'].includes(task.dispatchStatus))throw Error(task.error||'发送回执待核对，请打开原任务');
      if(task.dispatchStatus!=='draft'){
        const message=phase?.startsWith('awaiting')?'原任务待确认':phase==='failed'||phase==='idle'?'本轮已结束，请在原任务补齐正式成果':null;
        if(message!==s.error)this.db.prepare('UPDATE pa_steps SET error=? WHERE id=?').run(message,s.id);
        return;
      }
    } else {
      receipts=this.dependencyReceipts(id,d.deps);
      if(receipts.some(r=>!r)){
        if(!s.error)this.db.prepare("UPDATE pa_steps SET error='请在上游步骤选择成果版本' WHERE id=?").run(s.id);
        return;
      }
      const files=d.sources.filter(src=>src.path||src.importedFile||src.generatedFile);
      const verified=this.freezeByCanvas([...files.map(src=>({...src,cardId:src.outputCardId||src.cardId})),...receipts],d.requirementId);
      const sources=[...d.sources,...verified.slice(files.length)];
      const settings=this.memory.effective([d.requirementId,d.scope].filter(Boolean));
      const revisions=settings.map(s=>[s.id,s.revision]);
      if(d.revisions && json(revisions)!==json(d.revisions)){
        this.db.prepare("UPDATE pa_steps SET data=?,authorized=0,error='适用设定已更新，请核对后执行' WHERE id=?")
          .run(json({...d,revisions,review:true}),s.id);
        return;
      }
      const origin=d.sessionId||this.db.prepare('SELECT session_id AS id FROM pa_turns WHERE id=?').get(id)?.id;
      const created=await this.host.createTask(this.service,{requirementId:d.requirementId,operationId:s.id,selectedCardIds:[],generation:{mode:'new'},outputType:d.type,instruction:d.instruction},limitSourceContent([...new Map(sources.map(r=>[r.cardId,r])).values()]),settings,allowed,d.title,origin);
      if(!created)return;
      task=created.task;
      this.db.prepare("UPDATE pa_steps SET task_id=?,state='working',error=NULL WHERE id=?").run(task.id,s.id);
      // The creation transaction froze these dependencies. Later edits affect future steps only.
      receipts=undefined;
    }
    if(!allowed())return;
    const prepared=this.service.prepareTask({taskId:task.id}).prepared;
    let sessionId=task.sessionId;
    if(!sessionId){
      sessionId=await this.host.createSession(this.service,prepared.agentPreset);
      if(!allowed())return;
      sessionId=this.service.tasks.get(task.id).sessionId||sessionId;
      this.service.tasks.bindSession({taskId:task.id,sessionId});
    }
    await this.host.verify?.(this.service,task.id);
    if(!allowed()||!this.service.tasks.claimDraftDispatch(task.id,sessionId))return;
    try{
      const ack=await this.host.prompt(this.service,sessionId,prepared);
      if(ack?.accepted!==true)throw Error('DSH 没有返回受理回执');
      this.service.tasks.setDispatch({taskId:task.id,status:'accepted'});
    }catch(e){this.service.tasks.setDispatch({taskId:task.id,status:'unknown',error:e.message});throw e;}
  }
}
