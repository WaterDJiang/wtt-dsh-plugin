import React,{useCallback,useContext,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {CanvasConversationReferenceContext,ProjectInputContext} from './conversation-references.jsx';
import {UiButton, UiIcon} from './ui/controls.jsx';
import {CanvasPopover} from './ui/canvas-popover.jsx';
import {skillSearchText} from './skill-presentation.mjs';

const TOKEN='/项目';
const noop=()=>{};

function nativeSkillsOpen(controller){
  const menu=controller?.menu?.getSnapshot();
  return menu?.open&&menu.hit?.trigger==='/'&&menu.groups.some(group=>group.source==='skill');
}

// The host caret counts each command or reference chip as one character.
function triggerDraft(draft,occurrences){
  let offset=TOKEN.length;
  let projected='\uFFFC';
  for(const {offset:start,length} of occurrences){
    projected+=draft.slice(offset,start)+'\uFFFC';
    offset=start+length;
  }
  return projected+draft.slice(offset);
}

function typedSkillHit(draft,end,draftRev){
  const before=draft.slice(0,end);
  const match=/(?:^|[^\p{L}\p{N}_/])\/([^/\s]*)$/u.exec(before);
  if(!match)return;
  const query=match[1],start=end-query.length-1;
  if(before[start-1]===':'&&start>1&&/\S/u.test(before[start-2]))return;
  return {trigger:'/',query,quoted:false,position:'inline',span:{start,end,draftRev}};
}

function fitNativeMenu(tools){
  const chat=tools?.closest('.wtt-agent-chat');
  const anchor=chat?.querySelector('[data-composer-overlay]');
  if(!anchor)return;
  const composer=anchor.closest('[data-composer-card]');
  function place(){
    const top=tools.getBoundingClientRect().top;
    const bounds=chat.getBoundingClientRect();
    chat.style.setProperty('--wtt-agent-trigger-offset',`${anchor.getBoundingClientRect().top-top}px`);
    chat.style.setProperty('--wtt-agent-trigger-space',`${Math.max(0,top-Math.max(0,bounds.top))}px`);
  }
  place();
  const observer=new ResizeObserver(place);
  for(const element of [chat,tools,composer])if(element)observer.observe(element);
  return ()=>{
    observer.disconnect();
    chat.style.removeProperty('--wtt-agent-trigger-offset');
    chat.style.removeProperty('--wtt-agent-trigger-space');
  };
}

function waitForSkillCandidates(menu,signal){
  return new Promise(resolve=>{
    const finish=visible=>{
      stop();signal.removeEventListener('abort',abort);resolve(visible);
    };
    const abort=()=>finish(false);
    const read=()=>{
      const current=menu.getSnapshot();
      const skills=current.groups.find(group=>group.source==='skill');
      if(!current.open||skills?.status==='ready')finish(Boolean(current.open&&skills?.items.length));
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
      const done=owner?.current.submitting?.();
      try {
        const turn=frozen||await owner.current.freeze(id,text);
        const response=await ctx.remote.session.prompt({sessionId:id,requestId:turn.id,mode:'queue',
          content:[...attachments,{type:'text',text:turn.text}],clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
        if(!response.ok || response.value?.accepted!==true)throw Error(response.error?.message||'DSH 未返回受理回执，请核对原对话');
        return {kind:'success'};
      } finally {done?.();}
    }});
  return {owners,claim,begin(id,span){
    const scope=ctx.sessions.binding(id)?.ctx;
    return scope?.bail(scope,'slash/input-begin-command',{claim:claim(id),span});
  },skillController(id){
    const scope=ctx.sessions.binding(id)?.ctx;
    return scope&&ctx.inputTriggers?.sessionOf(scope);
  },async openSkills(controller,span,draft,signal){
    if(!controller?.toggleSource||!controller.menu)return false;
    controller.toggleSource('skill',{
      trigger:'/',query:'',quoted:false,position:draft.slice(0,span.start).trim()?'inline':'leading',span,
    });
    const found=await waitForSkillCandidates(controller.menu,signal);
    if(!found&&!signal.aborted&&nativeSkillsOpen(controller))controller.dismiss();
    return found;
  },async listSkills(id,signal){
    const result=await ctx.remote.skills.list({sessionId:id},signal);
    if(!result.ok)throw Error(result.error?.message||'技能目录暂时无法读取');
    return result.value.skills;
  },source:{trigger:'/',name:'wtt-project-agent',order:3,showGroupTitle:false,
    async candidates({sessionId},{query,position}){return owners.has(sessionId)&&position==='leading'&&'项目'.includes(query)?[{name:'项目',label:'WTT 项目助手'}]:[];},
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
  const tools=useRef(null),skillButton=useRef(null),skillQuery=useRef(null),skillAttempt=useRef(null);
  const typedSkillFrame=useRef(0);
  const pressedOpen=useRef(false);
  const [skillMenu,setSkillMenu]=useState(null),[query,setQuery]=useState('');
  latest.current=owner;
  const draft=useInput(v=>v.draft),phase=useInput(v=>v.phase),draftRev=useInput(v=>v.draftRev);
  const projectClaim=useInput(v=>v.claim?.token===TOKEN+' ');
  const occurrences=useInput(v=>v.occurrences);
  const controller=owner&&bridge.skillController(sessionId);
  const subscribe=useCallback(notify=>controller?.menu?.subscribe(notify)??noop,[controller]);
  const nativeOpen=useSyncExternalStore(subscribe,()=>controller?.menu?.getSnapshot().open??false);
  useLayoutEffect(()=>{
    if(nativeOpen&&owner?.chatActive)return fitNativeMenu(tools.current);
  },[nativeOpen,owner?.chatActive,sessionId]);
  useLayoutEffect(()=>{
    if(!owner)return;
    const window=skillButton.current?.ownerDocument.defaultView;
    const chat=tools.current?.closest('.wtt-agent-chat');
    if(!window||!chat)return;
    function onPointerDown(event){
      window.cancelAnimationFrame(typedSkillFrame.current);
      const onSkillButton=skillButton.current?.contains(event.target);
      const open=nativeSkillsOpen(controller);
      // DSH dismisses dock clicks at document capture, before React receives click.
      pressedOpen.current=onSkillButton&&open;
      if(onSkillButton||(!open&&!skillAttempt.current)||chat.querySelector('[data-trigger-menu]')?.contains(event.target))return;
      skillAttempt.current?.abort();
      if(open)controller.dismiss();
    }
    function onKeyDown(event){
      if(event.key!=='Escape'||!chat.contains(event.target))return;
      window.cancelAnimationFrame(typedSkillFrame.current);
      skillAttempt.current?.abort();
      if(!nativeSkillsOpen(controller))return;
      event.preventDefault();
      event.stopPropagation();
      controller.dismiss();
    }
    window.addEventListener('pointerdown',onPointerDown,true);
    window.addEventListener('keydown',onKeyDown,true);
    return ()=>{
      window.removeEventListener('pointerdown',onPointerDown,true);
      window.removeEventListener('keydown',onKeyDown,true);
      if(nativeSkillsOpen(controller))controller.dismiss();
    };
  },[controller,!!owner]);
  useLayoutEffect(()=>{
    if(owner?.chatActive!==false)return;
    skillAttempt.current?.abort();
    if(nativeSkillsOpen(controller))controller.dismiss();
    setSkillMenu(null);
  },[controller,owner?.chatActive]);
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
  useLayoutEffect(()=>{
    if(!owner?.chatActive||phase!=='claimed'||!projectClaim||!controller?.toggleSource||!draft.includes('/',TOKEN.length))return;
    // Let DSH finish its editor selection updates before launching the skill list.
    const frame=requestAnimationFrame(()=>{
      if(controller.menu?.getSnapshot().hit?.trigger==='@')return;
      const chat=tools.current?.closest('.wtt-agent-chat');
      const focused=chat?.ownerDocument.activeElement;
      if(!focused?.isContentEditable||!chat.contains(focused))return;
      const {start,end,draftRev:revision}=inputActions.captureInsertion();
      if(start!==end||revision!==draftRev)return;
      const hit=typedSkillHit(triggerDraft(draft,occurrences??[]),end,revision);
      if(!hit)return;
      // A launched source survives the host's next claimed-input caret update.
      if(controller.launcher?.getSnapshot()==='skill'&&nativeSkillsOpen(controller))controller.dismiss();
      controller.toggleSource('skill',hit);
    });
    typedSkillFrame.current=frame;
    return ()=>cancelAnimationFrame(frame);
  },[owner?.chatActive,phase,projectClaim,draft,draftRev,occurrences,controller,inputActions]);
  if(!owner)return null;
  const locked=owner.switching||['adjudicating','submitting'].includes(phase);
  async function openSkillMenu(event){
    const wasOpen=event.detail>0&&pressedOpen.current;
    pressedOpen.current=false;
    if(visibleSkillMenu||wasOpen||nativeSkillsOpen(controller)||skillAttempt.current){
      setSkillMenu(null);
      skillAttempt.current?.abort();
      if(nativeSkillsOpen(controller))controller.dismiss();
      return;
    }
    const attempt=new AbortController(),{signal}=attempt;
    skillAttempt.current=attempt;
    try{
      inputActions.focus?.();
      const span=inputActions.captureInsertion();
      if(await bridge.openSkills(controller,span,draft,signal)||signal.aborted)return;
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
  const expanded=Boolean(visibleSkillMenu||nativeSkillsOpen(controller));
  return <div ref={tools} className="wtt-agent-input-tools" aria-label="WTT 项目助手输入工具">
    <div className="wtt-agent-input-actions">
      <UiButton ref={skillButton} size="compact" variant="ghost" disabled={locked} aria-label="技能" aria-expanded={expanded}
        onMouseDown={event=>event.preventDefault()} onClick={openSkillMenu}>
        技能 <span aria-hidden="true">{expanded?'⌃':'⌄'}</span>
      </UiButton>
      {visibleSkillMenu&&<CanvasPopover className="wtt-agent-skill-menu" anchorRef={skillButton} initialFocusRef={skillQuery}
        boundary={tools.current?.closest('.wtt-agent-chat')} placement="top-start" role="region" aria-label="选择技能" onDismiss={()=>setSkillMenu(null)}
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
