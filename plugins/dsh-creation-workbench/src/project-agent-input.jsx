import React,{useContext,useLayoutEffect,useRef,useState} from 'react';
import {CanvasConversationReferenceContext,ProjectInputContext} from './conversation-references.jsx';
import {UiButton, UiIcon} from './ui/controls.jsx';
import {CanvasPopover} from './ui/canvas-popover.jsx';
import {skillSearchText} from './skill-presentation.mjs';

const TOKEN='/项目';

function waitForSkillCandidates(menu,signal){
  return new Promise(resolve=>{
    const finish=visible=>{
      stop();signal.removeEventListener('abort',abort);resolve(visible);
    };
    const abort=()=>finish(false);
    const read=()=>{
      const current=menu.getSnapshot();
      if(!current.open)finish(false);
      else if(current.groups.some(group=>group.source==='skill'&&group.status==='ready'&&group.items.length))finish(true);
    };
    const stop=menu.subscribe(read);
    if(signal.aborted)abort();
    else {signal.addEventListener('abort',abort,{once:true});read();}
  });
}

export function projectInputBridge(ctx){
  const owners=new Map();
  const claim=(id,frozen)=>({name:'项目',token:TOKEN+' ',hint:'交代任务或询问项目进展',attachments:true,
    async submit(text,_actx,attachments){
      const owner=owners.get(id);
      if(!owner&&!frozen)throw Error('请重新打开项目助手后发送');
      const turn=frozen||await owner.current.freeze(id,text);
      const done=owner?.current.submitting?.();
      try {
        const response=await ctx.remote.session.prompt({sessionId:id,requestId:turn.id,mode:'queue',
          content:[...attachments,{type:'text',text:turn.text}],clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
        if(!response.ok || response.value?.accepted!==true)throw Error(response.error?.message||'DSH 未返回受理回执，请核对原对话');
        return {kind:'success'};
      } finally {done?.();}
    }});
  return {owners,claim,begin(id,span){
    const scope=ctx.sessions.binding(id)?.ctx;
    return scope?.bail(scope,'slash/input-begin-command',{claim:claim(id),span});
  },openSkills(id,span,draft,signal){
    const scope=ctx.sessions.binding(id)?.ctx;
    if(!scope)throw Error('请等待对话加载后再选择技能。');
    const controller=ctx.inputTriggers.sessionOf(scope);
    if(!controller?.toggleSource||!controller.menu)return false;
    const closing=controller.launcher?.getSnapshot()==='skill'&&controller.menu.getSnapshot().open;
    controller.toggleSource('skill',{
      trigger:'/',query:'',quoted:false,position:draft.slice(0,span.start).trim()?'inline':'leading',span,
    });
    return closing||waitForSkillCandidates(controller.menu,signal);
  },async listSkills(id,signal){
    const result=await ctx.remote.skills.list({sessionId:id},signal);
    if(!result.ok)throw Error(result.error?.message||'技能目录暂时无法读取');
    return result.value.skills;
  },source:{trigger:'/',name:'wtt-project-agent',order:3,showGroupTitle:false,
    async candidates({sessionId},{query}){return owners.has(sessionId)&&'项目'.includes(query)?[{name:'项目',label:'项目助手'}]:[];},
    onPick(){return {text:TOKEN+' ',continue:true};},lexicon:()=>['项目'],
    matchSpace({sessionId},token){if(owners.has(sessionId)&&token===TOKEN)return {claim:claim(sessionId)};},
    async matchClaim({sessionId},token){if(owners.has(sessionId)&&token===TOKEN)return claim(sessionId);},
    async matchEnter({sessionId},line,signal){
      if(!owners.has(sessionId)||!/^\/项目(?:\s|$)/u.test(line))return;
      const frozen=await owners.get(sessionId).current.freeze(sessionId,line.slice(TOKEN.length).trim());
      signal.throwIfAborted();return {claim:claim(sessionId,frozen)};
    }}};
}

export function ProjectInputDock({sessionId,useInput,inputActions,bridge}){
  const owner=useContext(ProjectInputContext),latest=useRef(owner);
  const picker=useContext(CanvasConversationReferenceContext),pickButton=useRef(null),cancelPick=useRef(null),live=useRef(false);
  const skillButton=useRef(null),skillQuery=useRef(null),skillAttempt=useRef(null);
  const [skillMenu,setSkillMenu]=useState(null),[query,setQuery]=useState('');
  latest.current=owner;
  const draft=useInput(v=>v.draft),phase=useInput(v=>v.phase),draftRev=useInput(v=>v.draftRev);
  useLayoutEffect(()=>{
    if(!owner)return;
    live.current=true;
    bridge.owners.set(sessionId,latest);
    return ()=>{live.current=false;cancelPick.current?.();skillAttempt.current?.abort();if(bridge.owners.get(sessionId)===latest)bridge.owners.delete(sessionId);};
  },[sessionId,!!owner]);
  useLayoutEffect(()=>{
    if(!owner||phase!=='plain')return;
    const hasToken=/^\/项目(?:\s|$)/u.test(draft);
    if(!bridge.begin(sessionId,{start:0,end:hasToken?TOKEN.length:0,draftRev})&&!hasToken)
      inputActions.setDraft(TOKEN+' '+draft);
  },[!!owner,phase,draft,draftRev,inputActions,bridge,sessionId]);
  if(!owner)return null;
  const locked=['adjudicating','submitting'].includes(phase);
  async function openSkillMenu(){
    if(visibleSkillMenu){setSkillMenu(null);return;}
    skillAttempt.current?.abort();
    const attempt=new AbortController(),{signal}=attempt;
    skillAttempt.current=attempt;
    document.addEventListener('pointerdown',event=>{
      if(!skillButton.current?.contains(event.target)&&!event.target.closest?.('[data-trigger-menu]'))attempt.abort();
    },{capture:true,signal});
    document.addEventListener('keydown',event=>{if(event.key==='Escape')attempt.abort();},{capture:true,signal});
    try{
      inputActions.focus?.();
      const span=inputActions.captureInsertion();
      if(await bridge.openSkills(sessionId,span,draft,signal)||signal.aborted)return;
      const skills=await bridge.listSkills(sessionId,signal);
      if(!signal.aborted){setQuery('');setSkillMenu({sessionId,span,skills});}
    }catch(error){if(!signal.aborted)owner.showError(error.message);}
    finally{if(skillAttempt.current===attempt)skillAttempt.current=null;attempt.abort();}
  }
  function insertSkill(name){
    const {span}=skillMenu;
    const separator=span.start&&!/\s/u.test(draft[span.start-1]||' ')?' ':'';
    setSkillMenu(null);
    if(!inputActions.insertText(separator+'/'+name+' ',span))owner.showError('草稿已变化，请重新选择技能。');
    inputActions.focus?.();
  }
  const visibleSkillMenu=skillMenu?.sessionId===sessionId?skillMenu:null;
  const matchingSkills=visibleSkillMenu?.skills.filter(skill=>skillSearchText(skill).includes(query.trim().toLowerCase()))||[];
  function selectCards(){
    try {
      cancelPick.current=picker.start({
        sessionId,projectAssistant:true,maxReferences:Math.max(0,24-owner.references.length),
        excludedReferenceIds:owner.references.map(ref=>ref.sourceId),
        isCurrent:()=>live.current,
        restoreFocus:()=>pickButton.current?.focus({preventScroll:true}),
        stageCards:cards=>latest.current.addReferences(cards),
      });
    }catch(error){owner.showError(error.message);}
  }
  return <div className="wtt-agent-input-tools" aria-label="项目助手输入工具">
    <div className="wtt-agent-input-actions">
      <UiButton ref={skillButton} size="compact" variant="ghost" disabled={locked} aria-label="技能"
        onMouseDown={event=>event.preventDefault()} onClick={()=>void openSkillMenu()}>
        技能 <span aria-hidden="true">⌄</span>
      </UiButton>
      {visibleSkillMenu&&<CanvasPopover className="wtt-agent-skill-menu" anchorRef={skillButton} initialFocusRef={skillQuery}
        placement="top-start" role="region" aria-label="选择技能" onDismiss={()=>setSkillMenu(null)}
        onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setSkillMenu(null);skillButton.current?.focus();}}}>
        {!!visibleSkillMenu.skills.length&&<input ref={skillQuery} value={query} aria-label="搜索技能" placeholder="搜索技能" onChange={event=>setQuery(event.target.value)}/>}
        {matchingSkills.map(skill=><UiButton key={skill.name} variant="ghost" disabled={locked} onClick={()=>insertSkill(skill.name)}>{skill.name}</UiButton>)}
        {!matchingSkills.length&&<span ref={visibleSkillMenu.skills.length?undefined:skillQuery} tabIndex={visibleSkillMenu.skills.length?undefined:-1} role="status">
          {visibleSkillMenu.skills.length?'没有匹配的技能':'当前会话没有可选技能'}
        </span>}
      </CanvasPopover>}
      <UiButton ref={pickButton} size="compact" variant="ghost" disabled={!picker||picker.busy||locked||owner.references.length>=24}
        onClick={selectCards}><UiIcon name="folder" size={14}/>画布引用</UiButton>
    </div>
    {!!owner.references.length&&<details className="wtt-agent-selected">
      <summary>已选 {owner.references.length} 张</summary>
      <ul>{owner.references.map(ref=><li key={ref.requirementId+':'+ref.sourceId}>
        <span title={ref.canvasTitle+' · '+ref.title}>{ref.title}{ref.requirementId!==owner.requirementId&&<small> · {ref.canvasTitle}</small>}</span>
        <UiButton size="compact" variant="ghost" disabled={locked} aria-label={'移除引用 '+ref.title}
          onClick={()=>owner.removeReference(ref)}><UiIcon name="close" size={14}/></UiButton>
      </li>)}</ul>
    </details>}
  </div>;
}
