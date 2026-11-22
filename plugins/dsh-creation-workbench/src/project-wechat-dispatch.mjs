import { createHash, randomBytes } from 'node:crypto';
import { wechatGivenName, wechatIntent, wechatOptionNumber } from './project-wechat-language.mjs';
import { wechatTextLimit } from './project-wechat-state.mjs';

const keyFor = value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,20);
const short = id=>id.slice(0,8);
const labelOf = item=>item.title||item.name;
const location = (project,canvas)=>'「'+project.name+(canvas?' / '+canvas.title:'')+'」';
const status = {approval:'等你确认',running:'进行中',paused:'已暂停',done:'已完成',stopped:'已停止',stopping:'正在停止'};
const askForPlan = '我需要先把计划发给你核对。你可以说「刚才的计划发我看看」。';

function filterChoices(items,value) {
  if(!value)return items;
  const key=value.normalize('NFKC').toLowerCase();
  const exact=items.filter(item=>item.id===value||short(item.id)===key||labelOf(item).normalize('NFKC').toLowerCase()===key);
  return exact.length?exact:items.filter(item=>labelOf(item).normalize('NFKC').toLowerCase().includes(key));
}

function choiceList(kind,items,current,projectId,query) {
  const title=kind==='project'?'项目':'画布';
  if(!items.length)return query?'我没找到「'+query+'」。可以说「换'+(kind==='project'?'个项目':'张画布')+'」看看。':'这里还没有可选的'+title+'。可以告诉我想新建的名字。';
  const shown=items.slice(0,6);
  const rows=shown.map((item,index)=>{
    const label=labelOf(item);
    const parent=kind==='project'&&items.some(other=>other.id!==item.id&&labelOf(other)===label)
      ? '（'+item.path.split(/[\\/]/u).slice(-3,-1).join(' / ')+'）':'';
    return (index+1)+'. '+label+parent+(item.id===current?' · 当前':'');
  });
  const heading=query?'这几个'+title+'的名字很像，想选哪个？':kind==='project'?'想去哪一个项目？':'想去哪张画布？';
  if(items.length>shown.length)rows.push('还有 '+(items.length-shown.length)+' 个。');
  return {text:[heading,...rows,'回名字，或说「第一个」。'].join('\n'),
    dialog:{kind:'choice',target:kind,projectId,ids:shown.map(item=>item.id)}};
}

function needsApproval(plan) {
  if(!plan||!['approval','running','paused'].includes(plan.state))return null;
  if(plan.change)return {command:'accept-change',changeId:plan.change.id};
  if(plan.state==='approval')return {command:'approve-plan'};
  const next=plan.steps.find(step=>step.state!=='done'||step.handoff);
  if(plan.state==='running'&&next?.state==='ready'&&!next.authorized&&!next.handoff)return {command:'approve-step',stepId:next.id};
  return null;
}

function describePlan(plan) {
  const completed=plan.steps.filter(step=>step.state==='done'&&!step.handoff).length;
  const current=plan.steps.find(step=>step.state!=='done'||step.handoff);
  const summary=[status[plan.state]||plan.state,`完成 ${completed}/${plan.steps.length}`];
  if(current&&plan.state==='running'){
    if(current.interaction)summary.push('原 DSH 任务待确认');
    else if(current.handoff)summary.push('等待你交回成果');
    else if(current.error)summary.push(current.error);
    else if(current.state==='checking')summary.push('正在验收 '+current.title);
    else if(current.revising)summary.push('正在修订 '+current.title);
  }
  return summary.join(' · ');
}

export class ProjectWeChatDispatch {
  constructor(state,projects,coordinators) {
    this.state=state;this.db=state.db;this.projects=projects;this.coordinators=coordinators;
  }

  selection(account) {
    const requested=this.state.peer(account.key).project_id;
    const project=this.projects.records.get(requested)||this.projects.records.get(account.parentProjectId)||
      this.projects.records.get(this.projects.defaultProjectId);
    const service=this.projects.get(project.id);
    const canvases=service.store.listCanvases();
    const canvas=canvases.find(item=>item.id===this.state.canvas(account.key,project.id))||canvases[0];
    return {project,service,canvas,canvases};
  }

  home(account) {
    const {project,canvas}=this.selection(account);
    return '现在在'+location(project,canvas)+'。\n直接告诉我想做什么。想换地方，说「换个项目」或「换张画布」。';
  }

  chooseProject(account,query) {
    const projects=this.projects.list().projects;
    const current=this.state.peer(account.key).project_id||account.parentProjectId;
    const choices=filterChoices(projects,query);
    if(!query||choices.length!==1)return choiceList('project',choices,current,null,query);
    const project=choices[0],service=this.projects.get(project.id);
    const canvases=service.store.listCanvases();
    const canvas=canvases.find(item=>item.id===this.state.canvas(account.key,project.id))||canvases[0];
    this.state.select(account.key,project.id,canvas?.id);
    return '已切到'+location(project,canvas)+'。'+(canvas?'':'给新画布起个名字就能开始。');
  }

  chooseCanvas(account,query) {
    const {project,canvas,canvases}=this.selection(account);
    const choices=filterChoices(canvases,query);
    if(!query||choices.length!==1)return choiceList('canvas',choices,canvas?.id,project.id,query);
    this.state.select(account.key,project.id,choices[0].id);
    return '已切到'+location(project,choices[0])+'。';
  }

  newProject(account,name) {
    if(!account.parentProjectId)throw new Error('请在电脑端微信设置选择新建项目的存放目录');
    const root=this.projects.get(account.parentProjectId);
    const result=root.projectFiles.create({name,kind:'folder'});
    const record=this.projects.open(root.projectFiles.resolve(result.path,{directory:true}),{activate:false});
    const canvas=this.projects.get(record.id).store.ensureDefaultCanvas();
    this.state.select(account.key,record.id,canvas.id);
    return '建好了。现在在'+location(record,canvas)+'。';
  }

  newCanvas(account,name,operationId) {
    const {project,service}=this.selection(account);
    const canvas=service.store.createCanvas({title:name,operationId});
    this.state.select(account.key,project.id,canvas.id);
    return '建好了。现在在'+location(project,canvas)+'。';
  }

  create(account,kind,value,row) {
    if(value)return kind==='new-project'?this.newProject(account,value):this.newCanvas(account,value,row.request_id);
    const projectId=kind==='new-project'?account.parentProjectId:this.selection(account).project.id;
    return {text:(kind==='new-project'?'新项目':'新画布')+'叫什么？回个名字就行。',
      dialog:{kind:'name',target:kind,projectId}};
  }

  continueChoice(account,dialog,text) {
    const {target,projectId,ids}=dialog;
    const selected=target==='canvas'?this.selection(account):null;
    if(selected&&selected.project.id!==projectId)return '这里已经换了项目。可以说「换张画布」看看。';
    const items=selected?selected.canvases:this.projects.list().projects;
    const choose=query=>selected?this.chooseCanvas(account,query):this.chooseProject(account,query);
    const number=wechatOptionNumber(text);
    if(number!==null) {
      const id=ids[number-1];
      if(items.some(item=>item.id===id))return choose(id);
      const retry=choiceList(target,ids.map(id=>items.find(item=>item.id===id)).filter(Boolean),
        selected?.canvas?.id??this.state.peer(account.key).project_id,projectId);
      return typeof retry==='string'?retry:{...retry,text:'这个选项找不到了。\n'+retry.text};
    }
    const value=wechatGivenName(text);
    if(value&&filterChoices(items,value).length)return choose(value);
  }

  planFor(service,row) {
    const runner=this.coordinators.get(service);
    const saved=runner.db.prepare(`SELECT * FROM pa_plans WHERE id=? OR id=(SELECT plan_id FROM pa_changes WHERE id=?) LIMIT 1`)
      .get(row.request_id,row.request_id);
    return saved?runner.planView(saved):null;
  }

  approvalCode(row,plan,action) {
    const scope=keyFor([plan.id,plan.scopeToken,action]);
    const now=Date.now();
    const prior=this.db.prepare('SELECT code FROM wx_approvals WHERE account=? AND job=? AND scope=? AND expires_at>? AND used=0').get(row.account,row.seq,scope,now);
    if(prior)return prior.code;
    const insert=this.db.prepare('INSERT OR IGNORE INTO wx_approvals(code,account,job,scope,expires_at) VALUES(?,?,?,?,?)');
    for(let attempt=0;attempt<4;attempt++){
      const code=randomBytes(4).toString('hex').slice(0,7).toUpperCase();
      if(insert.run(code,row.account,row.seq,scope,now+86400000).changes)return code;
    }
    throw new Error('暂时无法生成确认码，请重新查询进度');
  }

  formatPlan(row,plan,includeSteps=false) {
    const project=this.projects.records.get(row.project_id);
    const action=needsApproval(plan);
    const steps=action?.command==='accept-change'?plan.change.steps:action?.command==='approve-step'?
      plan.steps.filter(step=>step.id===action.stepId):plan.steps;
    const canvas=project&&this.projects.get(project.id).store.getCanvas(row.canvas_id);
    const header=['「'+plan.title+'」',project?location(project,canvas):'原项目',describePlan(plan)];
    const text=[...header];
    if(action?.command==='accept-change')text.push('计划从第 '+plan.change.start+' 步调整。');
    if(action?.command==='approve-step')text.push('这一步需要你确认。');
    if(includeSteps||action)for(const [index,step] of steps.entries()){
      const route=step.executor==='codex'?' · Codex':step.modelSelection?.model?' · '+step.modelSelection.model:'';
      text.push(`${index+1}. ${step.title} → ${step.target}${route}`);
    }
    let dialog;
    if(action){
      const footer='同意的话，回「按这个做」。想调整就直接告诉我。';
      if(text.join('\n').length+footer.length+1>wechatTextLimit)
        return {text:[...header,'计划较长，请在电脑的 WTT 项目助手里核对后确认。'].join('\n')};
      text.push(footer);
      dialog={kind:'approve',code:this.approvalCode(row,plan,action)};
    }
    for(const step of plan.steps){
      const receipts=step.receipts||[step.receipt].filter(Boolean);
      for(const card of receipts)text.push(`${card.title||step.title} · V${card.number}（${step.target}）`);
    }
    return {text:text.join('\n'),dialog};
  }

  async approve(account,value,request) {
    const token=this.db.prepare('SELECT * FROM wx_approvals WHERE code=? AND account=?').get(value.toUpperCase(),account.key);
    if(!token||token.expires_at<=Date.now())return askForPlan;
    if(token.used)return '这份计划已经确认过了。想看进展，可以问「做好了吗」。';
    const row=this.db.prepare('SELECT * FROM wx_inbox WHERE seq=? AND account=?').get(token.job,account.key);
    if(!row?.project_id)throw new Error('原委托不可用');
    const service=this.projects.get(row.project_id),plan=this.planFor(service,row);
    const action=needsApproval(plan);
    if(!action||keyFor([plan.id,plan.scopeToken,action])!==token.scope)
      return '计划状态有变化。'+askForPlan;
    await this.coordinators.get(service).control({id:plan.id,scopeToken:plan.scopeToken,...action});
    this.state.transaction(()=>{
      this.db.prepare('UPDATE wx_approvals SET used=1 WHERE code=?').run(token.code);
      this.db.prepare('UPDATE wx_inbox SET approval_seq=? WHERE seq=?').run(request.seq,row.seq);
    });
    return '「'+plan.title+'」'+(action.command==='approve-step'?'这一步已确认。':'已确认。')+'想看进展，可以问「做好了吗」。';
  }

  progress(account,value,recent=false) {
    const byProject=this.db.prepare('SELECT * FROM wx_inbox WHERE account=? AND project_id=? AND session_id IS NOT NULL ORDER BY seq DESC LIMIT 1');
    const latestPlan=this.db.prepare("SELECT * FROM wx_inbox WHERE account=? AND session_id IS NOT NULL AND (signature IS NOT NULL OR phase IN ('sending','submitted')) ORDER BY seq DESC LIMIT 1");
    const row=value ? (/^[1-9]\d{0,11}$/.test(value)?this.db.prepare('SELECT * FROM wx_inbox WHERE seq=? AND account=? AND session_id IS NOT NULL').get(Number(value),account.key):null)
      : (recent?latestPlan.get(account.key):null)||byProject.get(account.key,this.selection(account).project.id);
    if(!row)return '我还没有查到这次委托。';
    const plan=this.planFor(this.projects.get(row.project_id),row);
    return plan?this.formatPlan(row,plan):row.response||'我还在处理，准备好会发给你。';
  }

  async replyTo(row,account) {
    const intent=wechatIntent(row.text);
    const dialog=this.state.dialog(row);
    const value=intent?.value||'';
    switch(intent?.kind){
      case 'home':return this.home(account);
      case 'project':return this.chooseProject(account,value);
      case 'canvas':return this.chooseCanvas(account,value);
      case 'new-project':
      case 'new-canvas':return this.create(account,intent.kind,value,row);
      case 'progress':return this.progress(account,value,!value);
      case 'recent':return this.progress(account,'',true);
      // A plain confirmation also has to refer to a delivered offer for the preceding message.
      case 'code':
      case 'agree':{
        const code=value||(dialog?.kind==='approve'?dialog.code:null);
        if(code)return this.approve(account,code,row);
        if(intent.brief){
          if(dialog?.kind==='name'||dialog?.kind==='choice')
            return {text:dialog.kind==='name'?'回个名字就行。':'回名字，或说「第一个」。',dialog};
          const pending=this.db.prepare("SELECT 1 FROM wx_approvals a JOIN wx_inbox w ON w.seq=a.job WHERE a.account=? AND a.used=0 AND a.expires_at>? AND w.phase='tracking' LIMIT 1").get(account.key,Date.now());
          if(!pending)return;
        }
        return askForPlan;
      }
      case 'cancel':if(dialog)return '好，先放着。';break;
    }

    if(dialog?.kind==='choice')return this.continueChoice(account,dialog,row.text);
    if(dialog?.kind==='name'){
      const name=wechatGivenName(row.text);
      if(!name)return;
      const current=dialog.target==='new-project'?account.parentProjectId:this.selection(account).project.id;
      if(current!==dialog.projectId)return '新建的位置变了。可以再说一次要在哪里建。';
      return this.create(account,dialog.target,name,row);
    }
    if(/^(?:就)?第/u.test(row.text)&&wechatOptionNumber(row.text)!==null)
      return '刚才的选项不在了。可以说「换个项目」或「换张画布」再看看。';
  }

  async process(row,account,active) {
    if(!row.text){this.state.finish(row,'可以直接打字告诉我想做什么。');return;}
    if(row.text.length>8000){this.state.finish(row,'这条消息超过 8000 字，请分段发送。');return;}
    const result=await this.replyTo(row,account);
    if(!active())return;
    if(result!==undefined){
      if(typeof result==='string')this.state.finish(row,result);
      else this.state.finish(row,result.text,result.dialog);
      return;
    }
    const {project,canvas,service}=this.selection(account);
    if(!canvas){this.state.finish(row,'这个项目还没有画布。给新画布起个名字就能开始。');return;}
    // Record the selection before resolving the session. Later mobile selections affect only new input.
    this.state.select(account.key,project.id,canvas.id);
    const {sessionId}=await this.coordinators.get(service).session();
    if(!active())return;
    this.db.prepare("UPDATE wx_inbox SET phase='sending',project_id=?,canvas_id=?,session_id=?,waited_at=? WHERE seq=?")
      .run(project.id,canvas.id,sessionId,Date.now(),row.seq);
    const request={sessionId,requestId:row.request_id,canvasId:canvas.id,text:row.text};
    try{
      await this.coordinators.sendWechat(service,request);
      if(active())this.db.prepare("UPDATE wx_inbox SET phase='submitted' WHERE seq=? AND phase='sending'").run(row.seq);
    }catch{
      // A local request can fail after the host has admitted it. Inspect the real session before reporting it.
    }
  }

  async inspect(row,active) {
    const service=this.projects.get(row.project_id);
    const plan=this.planFor(service,row);
    if(plan){
      const approval=needsApproval(plan);
      const final=['done','stopped'].includes(plan.state);
      const next=plan.steps.find(step=>step.state!=='done'||step.handoff);
      const attention=plan.state==='paused'||Boolean(next&&(next.handoff||next.interaction||next.error));
      const signature=keyFor([plan.id,plan.state,plan.scopeToken,approval,next?.id,next?.interaction,next?.handoff,next?.error]);
      if(row.signature!==signature&&(row.phase!=='tracking'||approval||attention||final)){
        const {text,dialog}=this.formatPlan(row,plan,row.phase!=='tracking');
        this.state.tracking(row,signature,text,dialog,final);
      }
      return;
    }
    if(row.phase==='tracking')return;
    const outcome=await this.coordinators.inspectWechat(service,row.session_id,row.request_id);
    if(!active())return;
    if(outcome.state==='ended'){
      const result=outcome.answer||'本轮已结束，请到原项目助手查看。';
      this.state.finish(row,result.slice(0,wechatTextLimit));
    }else if(outcome.state==='missing'&&Date.now()-row.waited_at>45000){
      this.state.finish(row,'我暂时无法确认刚才那条消息是否送达，可以在电脑的 WTT 项目助手里查看。');
    }
  }
}
