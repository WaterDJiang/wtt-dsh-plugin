import React,{useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {PanelHeader,UiButton} from './ui/controls.jsx';
import {ToolButton} from './canvas-chrome.jsx';
import {CanvasPopover} from './ui/canvas-popover.jsx';
import {ProjectInputContext} from './conversation-references.jsx';
import {ProjectMemoryPanel} from './project-agent-memory.jsx';
import {StepHandoff} from './project-agent-handoff.jsx';
import {creationSource, usableCreationSource} from './creation-context.mjs';
import wattterAgentLogo from './assets/wattter-agent.png';
import './project-agent.css';

const labels={auto:'全自动',plan:'先规划后执行',step:'逐项确认'};
const statuses={done:'已完成',running:'执行中',paused:'已暂停',approval:'待授权',stopped:'已停止',stopping:'停止待核对',blocked:'待核对',working:'执行中',ready:'待执行'};
const reviewLabel='授权并执行';
function stored(storage,key,fallback){try{return JSON.parse(storage.getItem(key))??fallback;}catch{return fallback;}}
function persist(storage,key,value){try{storage.setItem(key,JSON.stringify(value));}catch{/* Position is optional in read-only browser storage. */}}
function ModeMenu({value,onChange,label='执行方式'}){
  const anchor=useRef(null),[open,setOpen]=useState(false);
  return <><UiButton ref={anchor} size="compact" aria-label={label+' · '+labels[value]} aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{labels[value]} ⌄</UiButton>
    {open&&<CanvasPopover className="wtt-agent-mode" anchorRef={anchor} onDismiss={()=>setOpen(false)} onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);anchor.current?.focus();}}} role="menu">
      {Object.entries(labels).map(([id,name])=><UiButton key={id} role="menuitemradio" aria-checked={value===id} onClick={()=>{setOpen(false);onChange(id);}}>{name}{value===id?' ✓':''}</UiButton>)}</CanvasPopover>}</>;
}
function Plans({plans,act,locate,busy}){
  if(!plans?.length)return null;
  return <div className="wtt-agent-plans">{plans.map((p,index)=>{
    const next=p.steps.find(s=>s.state!=='done'||s.handoff),ended=['done','stopped'].includes(p.state);
    const completed=p.steps.filter(step=>step.state==='done'&&!step.handoff).length;
    const waitingVersion=p.steps.some(s=>s.choice&&!s.handoff);
    const status=p.state==='running'&&next?.interaction?'待确认'
      :p.state==='running'&&next?.handoff?'你正在处理'
      :p.state==='running'&&waitingVersion?'待选择版本'
      :p.state==='running'&&next?.state==='blocked'?'待核对':statuses[p.state];
    return <details className="wtt-agent-plan" key={p.id} open={!ended&&index===0||undefined}>
      <summary><span>{p.title}</span><small>{status}</small>
        <span className="wtt-agent-plan-progress"><progress value={completed} max={p.steps.length||1} aria-label={p.title+'进度'}/><span>完成 {completed}/{p.steps.length}</span></span>
      </summary>
      {p.steps.map(s=><div key={s.id} className="wtt-agent-step"><details><summary>{s.title} · {s.target}</summary><p>{s.instruction}</p>{!!s.deps.length&&<small>依赖步骤 {s.deps.join('、')}</small>}</details>{s.receipt?<UiButton size="compact" onClick={()=>locate(s.receipt)}>定位 V{s.receipt.number}</UiButton>:<small>{s.error||statuses[s.state]}</small>}
        {!!s.refs?.length&&<details><summary>{s.refs.length} 份引用</summary>{s.refs.map(r=><div key={r.cardId}>{r.title}{r.versionId&&<UiButton size="compact" onClick={()=>locate({...r,cardId:r.outputCardId})}>查看引用版本</UiButton>}</div>)}</details>}
        {s.state==='blocked'&&!s.taskId&&<UiButton size="compact" onClick={()=>act(p,'recheck',{stepId:s.id})}>重新核对来源</UiButton>}
        {s.taskId&&s.outputCardId&&(!s.receipt||s.handoff||s.choice)&&<UiButton size="compact" onClick={()=>locate({requirementId:s.requirementId,taskId:s.taskId,cardId:s.outputCardId})}>打开卡片对话</UiButton>}
        {!ended&&p.state!=='stopping'&&<StepHandoff step={s} busy={busy} act={command=>act(p,command,{stepId:s.id,cardId:s.outputCardId,requirementId:s.requirementId,versionId:s.choice?.versionId})}/>}
        {s.id===next?.id&&p.state==='running'&&!s.authorized&&!s.handoff&&<UiButton disabled={busy} size="compact" onClick={()=>act(p,'approve-step',{stepId:s.id})}>执行此项</UiButton>}</div>)}
      {!ended&&p.state!=='stopping'&&p.change&&<div><strong>范围变更 · 从第 {p.change.start} 项起</strong>{p.change.steps.map((s,i)=><details key={i}><summary>{s.title} · {s.target}</summary><p>{s.instruction}</p>{s.refs.map(r=><small key={r.cardId}>{r.title} </small>)}</details>)}
        <UiButton disabled={busy} onClick={()=>act(p,'accept-change',{changeId:p.change.id})}>批准变更</UiButton><UiButton disabled={busy} onClick={()=>act(p,'reject-change',{changeId:p.change.id})}>保留原计划</UiButton></div>}
      {!ended&&<div className="wtt-agent-actions">{p.state==='approval'&&<UiButton variant="primary" size="compact" disabled={busy} onClick={()=>act(p,'approve-plan')}>{reviewLabel}</UiButton>}
        {['running','paused'].includes(p.state)&&<UiButton disabled={busy} onClick={()=>act(p,p.state==='paused'?'resume':'pause')}>{p.state==='paused'?'继续剩余步骤':'暂停'}</UiButton>}
        {p.state!=='stopping'&&<ModeMenu label="委托执行方式" value={p.mode} onChange={mode=>act(p,'mode',{mode})}/>}<UiButton disabled={busy} onClick={()=>act(p,'stop')}>{p.state==='stopping'?'重试停止':'停止委托'}</UiButton></div>}</details>;
  })}</div>;
}
export const ProjectAgentFloat=React.memo(function ProjectAgentFloat({notices,project,requirement,selected,request,renderConversation,canvasActions,picking,cardId}){
  const key='wtt-project-agent:'+project.id;
  const [tracking,setTracking]=useState(()=>stored(sessionStorage,key+':tracking',false));
  const [open,setOpen]=useState(()=>stored(sessionStorage,key+':open',false)),[tab,setTab]=useState('chat');
  const [pinned,setPinned]=useState(()=>stored(sessionStorage,key+':references',null));
  const [mode,setMode]=useState(()=>stored(localStorage,key+':mode','plan'));
  const [position,setPosition]=useState(()=>stored(localStorage,key+':pos',{x:.98,y:.66}));
  const [windowSize,setWindowSize]=useState(()=>stored(localStorage,key+':size',{w:540,h:680}));
  const [size,setSize]=useState({w:0,h:0}),[session,setSession]=useState(null),[state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const launcher=useRef(null),drag=useRef(null),resizeStart=useRef(null),lastProgress=useRef(''),alive=useRef(true);
  const panelId=useId();
  const [canvas,setCanvas]=useState(null);
  const call=useCallback((action,data={})=>request('project-agent-'+action,data),[request]);
  const [page,setPage]=useState(0),[waiting,setWaiting]=useState(0);
  const readEpoch=useRef(0),sendEpoch=useRef(0),sending=useRef(0);
  const refresh=useCallback(async(full=true)=>{
    const epoch=++readEpoch.current, sent=sendEpoch.current;
    const cardRead=cardId?canvasActions.current.cardRead():null;
    const v=await call(full?'state':'progress',{...(full?{page}:{}),...(cardId?{cardId,requirementId:requirement.id}:{})});
    if(!alive.current||epoch!==readEpoch.current)return;
    if(full){setState(v);if(v.page!==page)setPage(v.page);}
    if(cardId)canvasActions.current.showCardStep(cardId,v.card,cardRead);
    setWaiting(v.waiting);
    if(lastProgress.current&&v.signature!==lastProgress.current)canvasActions.current.refresh();
    lastProgress.current=v.signature;
    if(sent===sendEpoch.current&&!sending.current){
      const follow=Boolean(v.active||v.running);
      setTracking(follow);persist(sessionStorage,key+':tracking',follow);
    }
  },[call,page,key,cardId,requirement.id,canvasActions]);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!open)return;
    let live=true;
    call('session').then(v=>{if(live){notices?.watchProject(project);setSession(v.sessionId);setError('');}}).catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;};
  },[open,call]);
  useEffect(()=>{
    if(!open&&!tracking&&!cardId)return;
    let live=true,timer;
    if(!open&&!tracking){
      const cardRead=canvasActions.current.cardRead();
      call('card',{cardId,requirementId:requirement.id}).then(({card:value})=>{
        if(!live)return;
        canvasActions.current.showCardStep(cardId,value,cardRead);
        if(value){setTracking(true);persist(sessionStorage,key+':tracking',true);}
      }).catch(e=>{if(live)setError(e.message);});
      return ()=>{live=false;};
    }
    async function poll(){
      try {await refresh(open);}catch(e){if(live)setError(e.message);}
      if(live&&(open||tracking))timer=setTimeout(poll,2200);
    }
    void poll();return ()=>{live=false;readEpoch.current++;clearTimeout(timer);};
  },[open,tracking,cardId,refresh,call,requirement.id,canvasActions,key]);
  useLayoutEffect(()=>{
    if(!open)return;
    const el=launcher.current?.closest('.wtt-course-canvas');
    if(!el)return;
    const resize=()=>setSize({w:Math.max(0,el.clientWidth-16),h:Math.max(0,el.clientHeight-16)});
    setCanvas(el);resize();
    const observer=new ResizeObserver(resize);observer.observe(el);
    return ()=>observer.disconnect();
  },[open]);
  const width=Math.min(windowSize.w,size.w),height=Math.min(windowSize.h,size.h);
  const dx=Math.max(0,size.w-width),dy=Math.max(0,size.h-height);
  const clamp=n=>Math.min(1,Math.max(0,n));
  const resolveSize=(w,h)=>({w:Math.min(size.w,Math.max(340,w)),h:Math.min(size.h,Math.max(350,h))});
  function resizeTo(w,h,right,top){
    const next=resolveSize(w,h);
    const newDx=size.w-next.w,newDy=size.h-next.h;
    const pos={x:newDx?clamp((right-next.w)/newDx):0,y:newDy?clamp(top/newDy):0};
    setPosition(pos);setWindowSize(next);
    return {pos,next};
  }
  function saveResize({pos,next}){
    persist(localStorage,key+':pos',pos);persist(localStorage,key+':size',next);
  }
  const resizeGrip={
    onPointerDown(event){
      if(event.button!==0)return;
      event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
      resizeStart.current={x:event.clientX,y:event.clientY,w:width,h:height,right:position.x*dx+width,top:position.y*dy};
    },
    onPointerMove(event){
      const start=resizeStart.current;
      if(start)start.result=resizeTo(start.w+start.x-event.clientX,start.h+event.clientY-start.y,start.right,start.top);
    },
    onLostPointerCapture(){
      if(resizeStart.current?.result)saveResize(resizeStart.current.result);
      resizeStart.current=null;
    },
    onKeyDown(event){
      const delta={ArrowLeft:[20,0],ArrowRight:[-20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[event.key];
      if(!delta)return;
      event.preventDefault();event.stopPropagation();
      saveResize(resizeTo(width+delta[0],height+delta[1],position.x*dx+width,position.y*dy));
    },
  };
  const move=e=>{if(!drag.current)return;const d=drag.current,mx=e.clientX-d.x,my=e.clientY-d.y;
    if(!d.last&&Math.hypot(mx,my)<4)return;
    const next={x:dx?clamp((d.left+mx)/dx):0,y:dy?clamp((d.top+my)/dy):0};setPosition(next);d.last=next;};
  const grip={onPointerDown:e=>{if(e.button!==0||e.target.closest('button'))return;drag.current={x:e.clientX,y:e.clientY,left:position.x*dx,top:position.y*dy};e.currentTarget.setPointerCapture(e.pointerId);},onPointerMove:move,
    onPointerUp:()=>{if(drag.current?.last)persist(localStorage,key+':pos',drag.current.last);drag.current=null;},onPointerCancel:()=>{drag.current=null;}};
  const toggle=v=>{setOpen(v);persist(sessionStorage,key+':open',v);};
  const act=async(p,command,extra)=>{if(busy)return;setBusy(true);try{await call('control',{id:p.id,scopeToken:p.scopeToken,command,...extra});await refresh();setError('');}catch(e){setError(e.message);}finally{setBusy(false);}};
  const toReference=card=>({
    cardId:card.outputCard?.id||card.nodeId||card.id,
    sourceId:creationSource(card).id,
    versionId:card.outputCard?.versionId,hash:card.sourceHash,title:card.title,
    requirementId:requirement.id,canvasTitle:requirement.title,
  });
  const references=pinned??(open?selected.filter(usableCreationSource).map(toReference):[]);
  function updateReferences(next){
    setPinned(next);
    persist(sessionStorage,key+':references',next);
  }
  const owner={
    references,requirementId:requirement.id,showError:setError,
    addReferences(cards){
      const next=[...new Map([...references,...cards.map(toReference)].map(ref=>[ref.requirementId+':'+ref.sourceId,ref])).values()];
      if(next.length>24)throw Error('一次最多引用 24 张卡片，请先移除部分引用。');
      updateReferences(next);
    },
    removeReference(ref){updateReferences(references.filter(item=>item!==ref));},
    freeze:async(id,text)=>({...await call('turn',{sessionId:id,requirementId:requirement.id,
      refs:references.map(({cardId,requirementId,versionId,hash})=>({cardId,requirementId,versionId,hash})),mode,text}),text}),
    submitting:()=>{
      sendEpoch.current++;sending.current++;
      setTracking(true);persist(sessionStorage,key+':tracking',true);
      return ()=>{sending.current--;sendEpoch.current++;};
    }
  };
  const locate=ref=>{toggle(false);canvasActions.current.locate(ref);};
  return <>
    <ToolButton label="打开项目助手" buttonRef={launcher} className={`wtt-agent-launch${open?' is-active':''}`}
      expanded={open} controlsId={open?panelId:undefined} description={waiting>0?waiting+' 项待确认':undefined}
      onClick={()=>toggle(!open)}>
      <img src={wattterAgentLogo} alt="" draggable={false}/>
      {waiting>0&&<span className="wtt-agent-badge" aria-hidden="true">{waiting}</span>}
    </ToolButton>
    {open&&canvas&&createPortal(<div className="wtt-agent-layer"><div id={panelId} className="wtt-agent-float is-open" data-picking={picking||undefined} style={{width,height,left:Math.round(clamp(position.x)*dx),top:Math.round(clamp(position.y)*dy)}}
      onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
    <div className="wtt-agent-grip" {...grip}><PanelHeader title="项目助手" subtitle={requirement.title} onClose={()=>{toggle(false);launcher.current?.focus({preventScroll:true});}} closeLabel="收起项目助手"/></div>
    <nav className="wtt-agent-nav" aria-label="项目助手视图">
      <UiButton variant="ghost" size="compact" aria-pressed={tab==='chat'} onClick={()=>setTab('chat')}>对话</UiButton>
      <UiButton variant="ghost" size="compact" aria-pressed={tab==='plans'} aria-label="委托" onClick={()=>setTab('plans')}>委托{waiting>0&&<span className="wtt-agent-tab-count" title={waiting+' 项待确认'}>{waiting}</span>}</UiButton>
      <UiButton variant="ghost" size="compact" aria-pressed={tab==='memory'} onClick={()=>setTab('memory')}>项目记忆{state?.suggestions.length>0&&<span className="wtt-agent-tab-count">{state.suggestions.length}</span>}</UiButton>
      {tab==='chat'&&<div className="wtt-agent-mode-anchor"><ModeMenu value={mode} onChange={v=>{setMode(v);persist(localStorage,key+':mode',v);}}/></div>}
    </nav>
    {error&&<div className="wtt-agent-feedback" role="alert"><span>{error}</span><UiButton size="compact" onClick={()=>setError('')}>关闭提示</UiButton></div>}
    {tab==='chat'&&state?.approvals>0&&<div className="wtt-agent-review">
      <UiButton variant="quiet" size="compact" onClick={()=>{setPage(0);setTab('plans');}}>查看待授权计划</UiButton>
    </div>}
    <section className="wtt-agent-chat" aria-label="项目助手对话" hidden={tab!=='chat'}>
      {session?<ProjectInputContext.Provider value={owner}>{renderConversation({identity:'project-agent:'+session,sessionId:session,label:'项目助手',editing:false,onSettled:()=>refresh().catch(e=>setError(e.message))})}</ProjectInputContext.Provider>
        :!error&&<p className="wtt-agent-empty" role="status">正在打开对话…</p>}
    </section>
    {tab==='plans'&&<section className="wtt-agent-queue" aria-label="项目委托">
      {!state?.plans?.length&&<p className="wtt-agent-empty">{state?'暂无委托':'正在读取委托…'}</p>}
      <Plans plans={state?.plans} act={act} locate={locate} busy={busy}/>
      {state?.total>20&&<div className="wtt-agent-actions" aria-label="委托分页">
        <UiButton size="compact" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</UiButton>
        <span>{page+1} / {Math.ceil(state.total/20)}</span>
        <UiButton size="compact" disabled={(page+1)*20>=state.total} onClick={()=>setPage(page+1)}>下一页</UiButton></div>}
    </section>}
    {tab==='memory'&&<><ProjectMemoryPanel call={call} onChanged={()=>refresh().catch(e=>setError(e.message))} suggestions={state?.suggestions} onLocate={locate}/>
      {session&&<div className="wtt-agent-footer"><UiButton size="compact" onClick={async()=>{try{const v=await call('session',{replace:session});setSession(v.sessionId);setTab('chat');}catch(e){setError(e.message);}}}>用项目记忆开新对话</UiButton></div>}</>}
    {size.w>600&&<UiButton variant="custom" className="wtt-agent-resize" aria-label="调整浮窗大小" title="拖动调整浮窗大小" {...resizeGrip}/>}
  </div></div>,canvas)}
  </>;
});
