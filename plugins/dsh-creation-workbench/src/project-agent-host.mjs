import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { ProjectAgent } from './project-agent.mjs';
import { extractSkillNames } from './skill-commands.mjs';

export function projectAgents(ctx,projects,{catalogReady,verifyTaskSkills,taskControl}) {
  const runners=new Map(),owners=new Map();
  let closed=false;
  const getService=name=>ctx.get?.(name)||ctx[name];
  const controller=name=>{const v=getService(name);if(!v)throw Error('当前 DSH 尚未加载 '+name);return v;};
  async function skillScope(sessionId){
    const result=await controller('sessionController').resolveAgent(sessionId);
    if(result.error)throw result.error;
    if(!result.agent)throw Error('无法读取原生会话的技能范围');
    return result.agent;
  }
  // Standard questions and approvals live in the host waterfall while the user decides.
  const interactions=new Map();
  const observeInteraction=async(req,next)=>{
    const session=req.agent?.session;
    const runner=session&&[...runners.entries()].find(([service])=>!service.store.closed&&service.workspaceRoot===session.header?.cwd)?.[1];
    if(!runner?.db.prepare('SELECT 1 FROM course_tasks t JOIN pa_steps s ON s.task_id=t.id WHERE t.session_id=? LIMIT 1').get(session.id))return next();
    const callId=String(req.callId||req.id||randomUUID());
    const active=interactions.get(session.id)||new Set();active.add(callId);interactions.set(session.id,active);
    try{return await next();}finally{active.delete(callId);if(!active.size)interactions.delete(session.id);}
  };
  const disposers=['user-questions/request','approval/request'].map(event=>ctx.on?.(event,observeInteraction,{prepend:true,global:true}));
  const host={
    bound(service,sessionId){owners.set(sessionId,projects.idOf(service));},
    async createSession(service,agentPreset){
      const {workspace}=await controller('workspaceController').create({path:service.workspaceRoot});
      const {sessionId}=await controller('sessionController').create({workspaceId:workspace.workspaceId,...(agentPreset?{agentPreset}:{})});
      if(!sessionId)throw Error('DSH 未返回会话编号');return sessionId;
    },
    async createTask(service,input,sources,settings,authorized,title){
      const names=extractSkillNames(input.instruction);
      const sessionId=runners.get(service)?.sessionId();
      const scope=names.length&&sessionId?await skillScope(sessionId):undefined;
      const skillRefs=names.length?await (await catalogReady).resolve(service.workspaceRoot,names,scope):[];
      if(!authorized())return null;
      return service.createTask({...input,selectedSkills:names},{skillRefs,projectInputs:{sources,settings,title}});
    },
    async prompt(service,sessionId,prepared) {
      const args={sessionId,requestId:prepared.requestId,mode:'queue',content:[{type:'text',text:projects.prepared(service,prepared).prompt}]};
      return controller('sessionController').prompt(args,new AbortController().signal);
    },
    async verify(service,taskId){
      const task=service.tasks.get(taskId);
      if(!task.input.skillRefs?.length)return;
      const scope=await skillScope(task.sessionId);
      await verifyTaskSkills(service,taskId,scope);
    },
    async pending(service,task){
      if(!task.sessionId)return null;
      const callId=interactions.get(task.sessionId)?.values().next().value;
      if(callId)return {callId};
      const agent=getService('agents')?.get(task.sessionId);
      if(agent){if(agent.session?.header?.cwd!==service.workspaceRoot)throw Error('原任务会话项目不符');
        return getService('sessionProjections')?.stateOf(agent.session,'userQuestions')?.questions?.active?.[0]||null;}
      const lease=await getService('sessionQuery')?.observeSession?.(task.sessionId);
      if(!lease)return null;
      try{if(lease.header.cwd!==service.workspaceRoot)throw Error('原任务会话项目不符');
        return lease.projections?.values.userQuestions?.active?.[0]||null;
      }finally{lease[Symbol.dispose]();}
    },
    async settled(service,task){
      const state=await taskControl.inspect(service,{requirementId:task.requirementId,taskId:task.id});
      return state.state==='idle' && !state.canStop;
    },
    async stopConfirmed(service,requirementId,taskId){
      const task=service.tasks.get(taskId);
      if(task.dispatchStatus==='cancelled')return true;
      if(task.dispatchStatus==='submitting')return false;
      const state=await taskControl.inspect(service,{requirementId,taskId});
      return !state.canStop && ['idle','failed','cancelled','succeeded'].includes(state.state) &&
        (task.dispatchStatus!=='unknown'||['idle','failed'].includes(task.runtimeState?.phase));
    },
    async stop(service,requirementId,taskId){
      const task=service.tasks.get(taskId);
      if(task.requirementId!==requirementId)throw Error('任务不属于当前画布');
      if(task.dispatchStatus==='draft'&&task.sessionId){
        service.tasks.cancelDraft(taskId,task.sessionId);
        return;
      }
      const input={requirementId,taskId}, current=await taskControl.inspect(service,input);
      if(current.canStop&&current.relatedCount>1)throw Error('原会话还关联其他任务，请在原对话核对停止范围');
      const outcome=current.canStop?await taskControl.stop(service,{...input,token:current.token}):current;
      if(outcome.stopping||!await host.stopConfirmed(service,requirementId,taskId)){
        throw Error('原任务尚未确认停止，请核对原对话或重试停止');
      }
    }
  };
  const get=service=>{
    if(!runners.has(service))runners.set(service,new ProjectAgent(service,host));
    return runners.get(service);
  };
  const warn=e=>ctx.logger?.warn?.('项目助手：'+e.message);
  const tick=()=>{for(const [service,agent] of runners)if(service.store.closed)runners.delete(service);else void agent.tick().catch(warn);};
  const recover=()=>{
    for(const record of projects.records.values()){
      let db;
      try {
        const dir=path.join(record.path,'.wtt-workbench'),file=path.join(dir,'workbench.sqlite');
        if(!lstatSync(dir).isDirectory()||!lstatSync(file).isFile())continue;
        db=new DatabaseSync(file,{readOnly:true});
        const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('pa_session','pa_owned_sessions','pa_plans')").all().map(r=>r.name));
        if(tables.has('pa_owned_sessions'))for(const r of db.prepare('SELECT id FROM pa_owned_sessions').all())owners.set(r.id,record.id);
        else if(tables.has('pa_session')){const r=db.prepare('SELECT session_id FROM pa_session').get();if(r?.session_id)owners.set(r.session_id,record.id);}
        if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='pa_plans'").get()&&db.prepare("SELECT 1 FROM pa_plans WHERE state IN ('running','stopping') LIMIT 1").get())get(projects.get(record.id));
      }catch(e){if(e.code!=='ENOENT')warn(e);}finally{db?.close();}
    }
    if(!closed)tick();
  };
  const start=setTimeout(recover,100), timer=setInterval(tick,1800);
  start.unref?.();timer.unref?.();
  function bySession(agent){
    if(!agent?.id)return false;
    const id=owners.get(agent.id);
    if(id && projects.records.get(id)?.path===agent.session?.header?.cwd)return get(projects.get(id));
    return false;
  }
  return {get,bySession,close(){closed=true;clearTimeout(start);clearInterval(timer);for(const dispose of disposers)dispose?.();interactions.clear();runners.clear();owners.clear();},
    async api(service,action,data={}){
      const agent=get(service);
      switch(action){
        case 'attention':return agent.attention();
        case 'session':{const bound=await agent.session(data.replace);host.bound(service,bound.sessionId);return bound;}
        case 'turn':return agent.turn(data);
        case 'progress':
        case 'state':{
          const sessionId=agent.sessionId(), native=sessionId&&getService('agents')?.get(sessionId);
          const info={...agent.progress(),running:Boolean(native?.status==='running'||native?.inbox?.nextTurn?.length||native?.inbox?.nextStep?.length)};
          if(action==='progress')return info;
          const page=Math.min(data.page??0,Math.max(0,Math.ceil(info.total/20)-1));
          return {sessionId,...info,page,plans:agent.plans(page),suggestions:agent.db.prepare('SELECT * FROM pa_suggestions ORDER BY rowid DESC LIMIT 12').all().map(r=>({id:r.id,...JSON.parse(r.data)}))};
        }
        case 'control':return agent.control(data);
        case 'memory':{const settings=agent.memory.settings();agent.memory.project({rebuild:data.rebuild===true});return {settings:settings.filter(s=>!s.missing||s.document),hits:agent.memory.search(data.query)};}
        case 'bind-document':return agent.memory.bind(data);
        case 'save':{const result=agent.memory.save(data);if(!result.conflict && data.suggestionId)agent.db.prepare('DELETE FROM pa_suggestions WHERE id=?').run(data.suggestionId);return result;}
        case 'dismiss':agent.db.prepare('DELETE FROM pa_suggestions WHERE id=?').run(data.id);return {dismissed:true};
        default:throw Error('未知的项目助手 操作');
      }
    }
  };
}
