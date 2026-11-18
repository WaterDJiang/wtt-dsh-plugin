import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {PanelHeader,UiButton} from './ui/controls.jsx';
import {CanvasPopover} from './ui/canvas-popover.jsx';
import {ProjectInputContext} from './project-agent-input.jsx';
import {ProjectMemoryPanel} from './project-agent-memory.jsx';
import './project-agent.css';

const labels={auto:'全自动',plan:'按计划授权',step:'逐项确认'};
const statuses={done:'已完成',running:'执行中',paused:'已暂停',approval:'待授权',stopped:'已停止',stopping:'停止待核对',blocked:'待核对',working:'已派发',ready:'待执行'};
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
  return <div className="wtt-agent-plans">{plans.map(p=>{
    const next=p.steps.find(s=>s.state!=='done'),ended=['done','stopped'].includes(p.state);
    return <details key={p.id} open={!ended||undefined}><summary>{p.title} · {statuses[p.state]}</summary>
      {p.steps.map(s=><div key={s.id} className="wtt-agent-step"><details><summary>{s.title} · {s.target}</summary><p>{s.instruction}</p>{!!s.deps.length&&<small>依赖步骤 {s.deps.join('、')}</small>}</details>{s.receipt?<UiButton size="compact" onClick={()=>locate(s.receipt)}>定位 V{s.receipt.number}</UiButton>:<small>{s.error||statuses[s.state]}</small>}
        {!!s.refs?.length&&<details><summary>{s.refs.length} 份引用</summary>{s.refs.map(r=><div key={r.cardId}>{r.title}{r.versionId&&<UiButton size="compact" onClick={()=>locate({...r,cardId:r.outputCardId})}>查看引用版本</UiButton>}</div>)}</details>}
        {s.state==='blocked'&&!s.taskId&&<UiButton size="compact" onClick={()=>act(p,'recheck',{stepId:s.id})}>重新核对来源</UiButton>}
        {s.taskId&&!s.receipt&&<UiButton size="compact" onClick={()=>locate({requirementId:s.requirementId,taskId:s.taskId,cardId:s.outputCardId})}>查看原任务</UiButton>}
        {s.id===next?.id&&p.state==='running'&&!s.authorized&&<UiButton disabled={busy} size="compact" onClick={()=>act(p,'approve-step',{stepId:s.id})}>执行此项</UiButton>}</div>)}
      {!ended&&p.state!=='stopping'&&p.change&&<div><strong>范围变更 · 从第 {p.change.start} 项起</strong>{p.change.steps.map((s,i)=><details key={i}><summary>{s.title} · {s.target}</summary><p>{s.instruction}</p>{s.refs.map(r=><small key={r.cardId}>{r.title} </small>)}</details>)}
        <UiButton disabled={busy} onClick={()=>act(p,'accept-change',{changeId:p.change.id})}>批准变更</UiButton><UiButton disabled={busy} onClick={()=>act(p,'reject-change',{changeId:p.change.id})}>保留原计划</UiButton></div>}
      {!ended&&<div className="wtt-agent-actions">{p.state==='approval'&&<UiButton disabled={busy} onClick={()=>act(p,'approve-plan')}>按计划执行</UiButton>}
        {['running','paused'].includes(p.state)&&<UiButton disabled={busy} onClick={()=>act(p,p.state==='paused'?'resume':'pause')}>{p.state==='paused'?'继续执行':'暂停'}</UiButton>}
        {p.state!=='stopping'&&<ModeMenu label="委托执行方式" value={p.mode} onChange={mode=>act(p,'mode',{mode})}/>}<UiButton disabled={busy} onClick={()=>act(p,'stop')}>{p.state==='stopping'?'重试停止':'停止委托'}</UiButton></div>}</details>;
  })}</div>;
}
export const ProjectAgentFloat=React.memo(function ProjectAgentFloat({notices,project,requirement,selected,request,renderConversation,canvasActions}){
  const key='wtt-project-agent:'+project.id;
  const [tracking,setTracking]=useState(()=>stored(sessionStorage,key+':tracking',false));
  const [open,setOpen]=useState(()=>stored(sessionStorage,key+':open',false)),[tab,setTab]=useState('chat');
  const [mode,setMode]=useState(()=>stored(localStorage,key+':mode','plan'));
  const [position,setPosition]=useState(()=>stored(localStorage,key+':pos',{x:.98,y:.66}));
  const [size,setSize]=useState({w:0,h:0}),[session,setSession]=useState(null),[state,setState]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const layer=useRef(null),drag=useRef(null),didDrag=useRef(false),lastProgress=useRef(''),alive=useRef(true);
  const call=useCallback((action,data={})=>request('project-agent-'+action,data),[request]);
  const [page,setPage]=useState(0),[waiting,setWaiting]=useState(0);
  const readEpoch=useRef(0),sendEpoch=useRef(0),sending=useRef(0);
  const refresh=useCallback(async(full=true)=>{
    const epoch=++readEpoch.current, sent=sendEpoch.current;
    const v=await call(full?'state':'progress',full?{page}:{});
    if(!alive.current||epoch!==readEpoch.current)return;
    if(full){setState(v);if(v.page!==page)setPage(v.page);}
    setWaiting(v.waiting);
    if(lastProgress.current&&v.signature!==lastProgress.current)canvasActions.current.refresh();
    lastProgress.current=v.signature;
    if(sent===sendEpoch.current&&!sending.current){
      const follow=Boolean(v.active||v.running);
      setTracking(follow);persist(sessionStorage,key+':tracking',follow);
    }
  },[call,page,key]);
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!open)return;
    let live=true;
    call('session').then(v=>{if(live){notices?.watchProject(project);setSession(v.sessionId);setError('');}}).catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;};
  },[open,call]);
  useEffect(()=>{
    if(!open&&!tracking)return;
    let live=true,timer;
    async function poll(){
      try {await refresh(open);}catch(e){if(live)setError(e.message);}
      if(live)timer=setTimeout(poll,2200);
    }
    void poll();return ()=>{live=false;readEpoch.current++;clearTimeout(timer);};
  },[open,tracking,refresh]);
  useLayoutEffect(()=>{const el=layer.current?.parentElement;if(!el)return;const resize=()=>setSize({w:Math.max(0,el.clientWidth-16),h:Math.max(0,el.clientHeight-16)});resize();const ob=new ResizeObserver(resize);ob.observe(el);return ()=>ob.disconnect();},[]);
  const width=open?Math.min(490,size.w):Math.min(88,size.w),height=open?Math.min(570,size.h):Math.min(38,size.h);
  const dx=Math.max(0,size.w-width),dy=Math.max(0,size.h-height);
  const clamp=n=>Math.min(1,Math.max(0,n));
  const move=e=>{if(!drag.current)return;const d=drag.current,mx=e.clientX-d.x,my=e.clientY-d.y;
    if(!didDrag.current&&Math.hypot(mx,my)<4)return;
    didDrag.current=true;const next={x:dx?clamp((d.left+mx)/dx):0,y:dy?clamp((d.top+my)/dy):0};setPosition(next);d.last=next;};
  const grip={onPointerDown:e=>{if(e.button!==0||open&&e.target.closest('button'))return;didDrag.current=false;drag.current={x:e.clientX,y:e.clientY,left:position.x*dx,top:position.y*dy};e.currentTarget.setPointerCapture(e.pointerId);},onPointerMove:move,
    onPointerUp:()=>{if(drag.current?.last)persist(localStorage,key+':pos',drag.current.last);drag.current=null;},onPointerCancel:()=>{drag.current=null;}};
  const toggle=v=>{setOpen(v);persist(sessionStorage,key+':open',v);};
  const act=async(p,command,extra)=>{if(busy)return;setBusy(true);try{await call('control',{id:p.id,scopeToken:p.scopeToken,command,...extra});await refresh();setError('');}catch(e){setError(e.message);}finally{setBusy(false);}};
  const owner={
    freeze:async(id,text)=>({...await call('turn',{sessionId:id,requirementId:requirement.id,refs:selected.map(n=>({cardId:n.outputCard?.id||n.id,versionId:n.outputCard?.versionId,hash:n.sourceHash})),mode,text}),text}),
    submitting:()=>{
      sendEpoch.current++;sending.current++;
      setTracking(true);persist(sessionStorage,key+':tracking',true);
      return ()=>{sending.current--;sendEpoch.current++;};
    }
  };
  const locate=ref=>{toggle(false);canvasActions.current.locate(ref);};
  return <div className="wtt-agent-layer" ref={layer}><div className={'wtt-agent-float '+(open?'is-open':'is-closed')} style={{width,height,left:Math.round(clamp(position.x)*dx),top:Math.round(clamp(position.y)*dy)}}
    onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
    {!open?<UiButton className="wtt-agent-launch" aria-label="打开项目总 Agent" {...grip} onClick={()=>{if(!didDrag.current)toggle(true);didDrag.current=false;}}>总 Agent{waiting>0&&<span aria-label={waiting+' 项待确认'}>{waiting}</span>}</UiButton>:<>
    <div className="wtt-agent-grip" {...grip}><PanelHeader title="项目总 Agent" onClose={()=>toggle(false)} closeLabel="收起项目总 Agent"/></div>
    <nav aria-label="总 Agent 视图"><UiButton size="compact" aria-pressed={tab==='chat'} onClick={()=>setTab('chat')}>对话</UiButton><UiButton size="compact" aria-pressed={tab==='memory'} onClick={()=>setTab('memory')}>项目记忆{state?.suggestions.length?' · '+state.suggestions.length:''}</UiButton>
      <ModeMenu value={mode} onChange={v=>{setMode(v);persist(localStorage,key+':mode',v);}}/></nav>
    {error&&<div role="alert">{error} <UiButton onClick={()=>{setError('');toggle(false);}}>收起</UiButton></div>}
    {tab==='chat'?<>
      <div className="wtt-agent-context"><span title={requirement.title}>{requirement.title}</span>{!!selected.length&&<details><summary>已选 {selected.length} 张</summary>{selected.map(n=><div key={n.id}>{n.title}</div>)}</details>}</div>
      <Plans plans={state?.plans} act={act} locate={locate} busy={busy}/>
      {state?.total>20&&<div className="wtt-agent-actions" aria-label="委托分页">
        <UiButton size="compact" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</UiButton>
        <span>{page+1} / {Math.ceil(state.total/20)}</span>
        <UiButton size="compact" disabled={(page+1)*20>=state.total} onClick={()=>setPage(page+1)}>下一页</UiButton></div>}
      {session&&<ProjectInputContext.Provider value={owner}>{renderConversation({identity:'project-agent:'+session,sessionId:session,label:'项目总 Agent',onSettled:()=>refresh().catch(e=>setError(e.message))})}</ProjectInputContext.Provider>}
    </>:<><ProjectMemoryPanel call={call} onChanged={()=>refresh().catch(e=>setError(e.message))} suggestions={state?.suggestions} onLocate={locate}/>
      {session&&<UiButton size="compact" onClick={async()=>{try{const v=await call('session',{replace:session});setSession(v.sessionId);setTab('chat');}catch(e){setError(e.message);}}}>用项目记忆开新对话</UiButton>}</>}
    </>}
  </div></div>;
});
