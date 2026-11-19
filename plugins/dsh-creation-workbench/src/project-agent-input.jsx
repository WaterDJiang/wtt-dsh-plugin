import React,{useContext,useLayoutEffect,useRef} from 'react';
import {CanvasConversationReferenceContext,ProjectInputContext} from './conversation-references.jsx';
import {UiButton, UiIcon} from './ui/controls.jsx';

const TOKEN='/项目';

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
  },openSkills(id,span,draft){
    const scope=ctx.sessions.binding(id)?.ctx;
    if(!scope)throw Error('请等待对话加载后再选择技能。');
    ctx.inputTriggers.sessionOf(scope).toggleSource('skill',{
      trigger:'/',query:'',quoted:false,position:draft.slice(0,span.start).trim()?'inline':'leading',span,
    });
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
  latest.current=owner;
  const draft=useInput(v=>v.draft),phase=useInput(v=>v.phase),draftRev=useInput(v=>v.draftRev);
  useLayoutEffect(()=>{
    if(!owner)return;
    live.current=true;
    bridge.owners.set(sessionId,latest);
    return ()=>{live.current=false;cancelPick.current?.();if(bridge.owners.get(sessionId)===latest)bridge.owners.delete(sessionId);};
  },[sessionId,!!owner]);
  useLayoutEffect(()=>{
    if(!owner||phase!=='plain')return;
    const hasToken=/^\/项目(?:\s|$)/u.test(draft);
    if(!bridge.begin(sessionId,{start:0,end:hasToken?TOKEN.length:0,draftRev})&&!hasToken)
      inputActions.setDraft(TOKEN+' '+draft);
  },[!!owner,phase,draft,draftRev,inputActions,bridge,sessionId]);
  if(!owner)return null;
  const locked=['adjudicating','submitting'].includes(phase);
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
      <UiButton size="compact" variant="ghost" disabled={locked}
        onClick={()=>{try{bridge.openSkills(sessionId,inputActions.captureInsertion(),draft);}catch(error){owner.showError(error.message);}}}>技能</UiButton>
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
