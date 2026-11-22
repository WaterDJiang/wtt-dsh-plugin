import React,{useCallback,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {PanelHeader,UiButton} from './ui/controls.jsx';
import {ToolButton} from './canvas-chrome.jsx';
import {CanvasPopover} from './ui/canvas-popover.jsx';
import {ProjectInputContext} from './conversation-references.jsx';
import {ProjectMemoryPanel} from './project-agent-memory.jsx';
import {StepHandoff} from './project-agent-handoff.jsx';
import {creationSource, usableCreationSource} from './creation-context.mjs';
import {EFFORT_LABELS} from './model-selection.mjs';
import wattterAgentLogo from './assets/wattter-agent.png';
import './project-agent.css';

const labels={auto:'全自动',plan:'先规划后执行',step:'逐项确认'};
const statuses={done:'已完成',running:'执行中',paused:'已暂停',approval:'待授权',stopped:'已停止',stopping:'停止待核对',blocked:'待核对',working:'执行中',ready:'待执行',checking:'待验收','review-waiting':'需要你'};
const reviewLabel='授权并执行';
const assistantName='WTT 项目助手';
function stored(storage,key,fallback){try{return JSON.parse(storage.getItem(key))??fallback;}catch{return fallback;}}
function persist(storage,key,value){try{storage.setItem(key,JSON.stringify(value));}catch{/* Position is optional in read-only browser storage. */}}
function ModeMenu({value,onChange,label='执行方式'}){
  const anchor=useRef(null),[open,setOpen]=useState(false);
  return <><UiButton ref={anchor} size="compact" aria-label={label+' · '+labels[value]} aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{labels[value]} ⌄</UiButton>
    {open&&<CanvasPopover className="wtt-agent-mode" anchorRef={anchor} onDismiss={()=>setOpen(false)} onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);anchor.current?.focus();}}} role="menu">
      {Object.entries(labels).map(([id,name])=><UiButton key={id} role="menuitemradio" aria-checked={value===id} onClick={()=>{setOpen(false);onChange(id);}}>{name}{value===id?' ✓':''}</UiButton>)}</CanvasPopover>}</>;
}
function PlanStepDetails({step,locate}){
  const model=step.modelSelection;
  const executor=step.executor==='codex'?'Codex CLI':model?[model.model,model.provider,EFFORT_LABELS[model.reasoningEffort]||model.reasoningEffort].filter(Boolean).join(' · '):'DSH 默认模型';
  return <>
    <details className="wtt-agent-step-details"><summary>{step.title} · {step.target}{step.executor==='codex'&&' · Codex'}</summary><p>{step.instruction}</p>
      <div className="wtt-agent-step-note">执行者 · {executor}</div>
      {!!step.deps.length&&<small>依赖步骤 {step.deps.join('、')}</small>}
      {step.acceptance&&<div className="wtt-agent-step-note">验收 · 至少 {step.acceptance.minCards} 张正式成果
        <ul>{step.acceptance.criteria.map((criterion,index)=><li key={index}>{criterion}</li>)}</ul>
      </div>}
      {step.resultReview?.reason&&step.resultReview.reason!==step.error&&<div className="wtt-agent-step-note">{step.resultReview.reason}</div>}
    </details>
    {!!step.refs?.length&&<details><summary>{step.refs.length} 份引用</summary>{step.refs.map(ref=><div key={ref.cardId}>
      {ref.title}{ref.versionId&&<UiButton size="compact" onClick={()=>locate({...ref,cardId:ref.outputCardId})}>查看引用版本</UiButton>}
    </div>)}</details>}
  </>;
}
function ReviewActions({kind,plan,stepId,act,busy}){
  if(kind==='change')return <>
    <UiButton variant="primary" size="compact" disabled={busy} onClick={()=>act(plan,'accept-change',{changeId:plan.change.id})}>批准变更</UiButton>
    <UiButton size="compact" disabled={busy} onClick={()=>act(plan,'reject-change',{changeId:plan.change.id})}>保留原计划</UiButton>
  </>;
  return <UiButton variant="primary" size="compact" disabled={busy} onClick={()=>act(plan,kind==='plan'?'approve-plan':'approve-step',kind==='step'?{stepId}:undefined)}>
    {kind==='plan'?reviewLabel:'执行此项'}
  </UiButton>;
}
function ChatReview({review,act,locate,busy,onPage}){
  if(!review?.item)return null;
  const {plan,kind,stepId}=review.item;
  const steps=kind==='change'?plan.change.steps:kind==='plan'?plan.steps:plan.steps.filter(step=>step.id===stepId);
  return <section className="wtt-agent-review" aria-label="对话授权">
    <div className="wtt-agent-review-heading">
      <strong title={plan.title}>{plan.title}</strong>
      <small role="status">{kind==='change'?('范围变更 · 从第 '+plan.change.start+' 项起'):kind==='step'?'待确认步骤':'计划已生成 · 待授权'}</small>
    </div>
    <div className="wtt-agent-review-steps" key={plan.id+':'+kind+':'+(stepId||'')}>
      {steps.map((step,index)=><div key={step.id||index}>
        <PlanStepDetails step={step} locate={ref=>locate(ref,plan.id)}/>
        {kind==='step'&&step.error&&<small>{step.error}</small>}
      </div>)}
    </div>
    <div className="wtt-agent-actions">
      <ReviewActions kind={kind} plan={plan} stepId={stepId} act={act} busy={busy}/>
      {review.total>1&&<div className="wtt-agent-review-pager" aria-label="对话待授权分页">
        <UiButton size="compact" disabled={busy||review.page===0} onClick={()=>onPage(review.page-1)}>上一项</UiButton>
        <small>{review.page+1} / {review.total}</small>
        <UiButton size="compact" disabled={busy||review.page+1===review.total} onClick={()=>onPage(review.page+1)}>下一项</UiButton>
      </div>}
    </div>
  </section>;
}
function Plans({plans,act,locate,busy,focusPlan}){
  if(!plans?.length)return null;
  return <div className="wtt-agent-plans">{plans.map((p,index)=>{
    const next=p.steps.find(s=>s.state!=='done'||s.handoff),ended=['done','stopped'].includes(p.state);
    const completed=p.steps.filter(step=>step.state==='done'&&!step.handoff).length;
    const waitingVersion=p.steps.some(s=>s.choice&&!s.handoff);
    const target=ref=>locate(ref,p.id);
    const stepStatus=s=>s.state==='working'&&s.revising?'修订中':statuses[s.state];
    const status=p.state==='running'&&next?.interaction?'待确认'
      :p.state==='running'&&next?.handoff?'你正在处理'
      :p.state==='running'&&waitingVersion?'待选择版本'
      :p.state==='running'&&next&&(['checking','review-waiting','blocked'].includes(next.state)||next.revising)?stepStatus(next):statuses[p.state];
    return <details className="wtt-agent-plan" key={p.id} open={focusPlan===p.id||!focusPlan&&!ended&&index===0||undefined}>
      <summary><span>{p.title}</span><small>{status}</small>
        <span className="wtt-agent-plan-progress"><progress value={completed} max={p.steps.length||1} aria-label={p.title+'进度'}/><span>完成 {completed}/{p.steps.length}</span></span>
      </summary>
      {p.steps.map(s=>{
        const receipts=s.receipts||[s.receipt].filter(Boolean);
        const currentTarget=s.choice?.cardId||s.outputCardId;
        const context=s.choice?{...s,receipt:receipts.find(card=>card.cardId===s.choice.cardId)||s.receipt}:s;
        const canDecide=p.state==='running'&&s.id===next?.id&&s.state==='review-waiting'&&!s.handoff&&s.resultReviewId;
        return <div key={s.id} className="wtt-agent-step">
          <PlanStepDetails step={s} locate={target}/>
          {s.state!=='done'&&<small role={s.id===next?.id?'status':undefined}>{s.revising&&s.state==='ready'&&s.authorized?'待修订':stepStatus(s)}</small>}
          {s.error&&<div className="wtt-agent-step-note">{s.error}</div>}
          {!!receipts.length&&<div className="wtt-agent-step-results" aria-label={s.title+'成果'}>
            {receipts.map(card=><UiButton key={card.cardId} size="compact" onClick={()=>target(card)}>
              {receipts.length>1?card.title+' · V'+card.number:'定位 V'+card.number}
            </UiButton>)}
          </div>}
          {s.canRecheck&&<UiButton disabled={busy} size="compact" onClick={()=>act(p,'recheck',{stepId:s.id})}>重新核对</UiButton>}
          {s.taskId&&s.outputCardId&&(!receipts.length||s.handoff||s.choice||canDecide)&&
            <UiButton size="compact" onClick={()=>target({requirementId:s.requirementId,taskId:s.taskId,cardId:s.outputCardId})}>{s.executor==='codex'?'查看执行卡':'打开卡片对话'}</UiButton>}
          {!ended&&p.state!=='stopping'&&<StepHandoff step={context} busy={busy} act={command=>act(p,command,{stepId:s.id,cardId:currentTarget,requirementId:s.choice?.requirementId||s.requirementId,versionId:s.choice?.versionId})}/>}
          {canDecide&&<div className="wtt-agent-step-results">
            {receipts.length>=s.acceptance?.minCards&&!s.choice&&<UiButton variant="primary" size="compact" disabled={busy} onClick={()=>act(p,'accept-result',{stepId:s.id,resultReviewId:s.resultReviewId})}>确认采用成果</UiButton>}
            {!s.choice&&<UiButton size="compact" disabled={busy} onClick={()=>act(p,'review-again',{stepId:s.id,resultReviewId:s.resultReviewId})}>重新验收</UiButton>}
          </div>}
          {s.id===next?.id&&p.state==='running'&&s.state==='ready'&&!s.authorized&&!s.handoff&&<UiButton disabled={busy} size="compact" onClick={()=>act(p,'approve-step',{stepId:s.id})}>执行此项</UiButton>}
        </div>;
      })}
      {!ended&&p.state!=='stopping'&&p.change&&<div><strong>范围变更 · 从第 {p.change.start} 项起</strong>{p.change.steps.map((s,i)=><PlanStepDetails key={i} step={s} locate={target}/>)}
        <ReviewActions kind="change" plan={p} act={act} busy={busy}/></div>}
      {!ended&&<div className="wtt-agent-actions">{p.state==='approval'&&<ReviewActions kind="plan" plan={p} act={act} busy={busy}/>}
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
  const [page,setPage]=useState(0),[reviewPage,setReviewPage]=useState(0),[waiting,setWaiting]=useState(0);
  const [returnPlan,setReturnPlan]=useState(()=>stored(sessionStorage,key+':return-plan',null));
  const [focusPlan,setFocusPlan]=useState(null);
  const [starting,setStarting]=useState(false),startPending=useRef(false);
  const readEpoch=useRef(0),sendEpoch=useRef(0),sending=useRef(0);
  const view=useRef({tab,page,reviewPage,focusPlan});
  view.current={tab,page,reviewPage,focusPlan};
  const refresh=useCallback(async(full=true)=>{
    const epoch=++readEpoch.current, sent=sendEpoch.current;
    const {tab,page,reviewPage,focusPlan}=view.current;
    const cardRead=cardId?canvasActions.current.cardRead():null;
    const v=await call(full?'state':'progress',{...(full?{page,view:tab,reviewPage,planId:tab==='plans'?focusPlan:undefined}:{}),...(cardId?{cardId,requirementId:requirement.id}:{})});
    if(!alive.current||epoch!==readEpoch.current)return;
    if(full&&(view.current.tab!==tab||view.current.page!==page||view.current.reviewPage!==reviewPage||view.current.focusPlan!==focusPlan))return;
    if(full){
      setState({...v,view:tab});if(v.page!==page)setPage(v.page);
      if(v.review&&v.review.page!==reviewPage)setReviewPage(v.review.page);
      if(v.sessionId&&!startPending.current)setSession(v.sessionId);
    }
    if(cardId)canvasActions.current.showCardStep(cardId,v.card,cardRead);
    setWaiting(v.waiting);
    if(lastProgress.current&&v.signature!==lastProgress.current)canvasActions.current.refresh();
    lastProgress.current=v.signature;
    if(sent===sendEpoch.current&&!sending.current){
      const follow=Boolean(v.active||v.running);
      setTracking(follow);persist(sessionStorage,key+':tracking',follow);
    }
  },[call,key,cardId,requirement.id,canvasActions]);
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
  },[open,tracking,cardId,refresh,call,requirement.id,canvasActions,key,tab,page,reviewPage,focusPlan]);
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
      if(event.button!==0||resizeStart.current)return;
      event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
      resizeStart.current={pointerId:event.pointerId,x:event.clientX,y:event.clientY,w:width,h:height,right:position.x*dx+width,top:position.y*dy};
    },
    onPointerMove(event){
      const start=resizeStart.current;
      if(start?.pointerId===event.pointerId)start.result=resizeTo(start.w+start.x-event.clientX,start.h+event.clientY-start.y,start.right,start.top);
    },
    onLostPointerCapture(event){
      if(resizeStart.current?.pointerId!==event.pointerId)return;
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
  const act=async(p,command,extra)=>{if(busy)return;setBusy(true);try{await call('control',{id:p.id,scopeToken:p.scopeToken,command,...extra});await refresh();setError('');}catch(e){setError(e.message);await refresh().catch(()=>{});}finally{setBusy(false);}};
  async function newConversation(){
    if(!session||startPending.current||sending.current||busy||state?.running)return;
    startPending.current=true;setStarting(true);setError('');
    try{
      const result=await call('session',{replace:session});
      readEpoch.current++;
      if(Array.isArray(pinned))persist(sessionStorage,key+':references',null);
      if(alive.current){setPinned(null);setSession(result.sessionId);setReviewPage(0);setTab('chat');}
    }catch(e){if(alive.current)setError(e.message);}
    finally{startPending.current=false;if(alive.current)setStarting(false);}
  }
  const toReference=card=>({
    cardId:card.outputCard?.id||card.nodeId||card.id,
    sourceId:creationSource(card).id,
    versionId:card.outputCard?.versionId,hash:card.sourceHash,title:card.title,
    requirementId:requirement.id,canvasTitle:requirement.title,
  });
  const pinnedReferences=Array.isArray(pinned)?pinned:pinned?.sessionId===session?pinned?.refs:null;
  const references=pinnedReferences??(open?selected.filter(usableCreationSource).map(toReference):[]);
  function updateReferences(next){
    const value={sessionId:session,refs:next};
    setPinned(value);
    persist(sessionStorage,key+':references',value);
  }
  const owner={
    references,requirementId:requirement.id,showError:setError,chatActive:tab==='chat'&&!picking&&!starting,switching:starting,
    addReferences(cards){
      const next=[...new Map([...references,...cards.map(toReference)].map(ref=>[ref.requirementId+':'+ref.sourceId,ref])).values()];
      if(next.length>24)throw Error('一次最多引用 24 张卡片，请先移除部分引用。');
      updateReferences(next);
    },
    removeReference(ref){updateReferences(references.filter(item=>item!==ref));},
    freeze:async(id,text)=>{
      if(startPending.current)throw Error('正在新建对话，请稍后发送');
      return {...await call('turn',{sessionId:id,requirementId:requirement.id,
        refs:references.map(({cardId,requirementId,versionId,hash})=>({cardId,requirementId,versionId,hash})),mode,text}),text};
    },
    submitting:()=>{
      sendEpoch.current++;sending.current++;
      setTracking(true);persist(sessionStorage,key+':tracking',true);
      return ()=>{sending.current--;sendEpoch.current++;};
    }
  };
  const updateReturn=planId=>{setReturnPlan(planId);persist(sessionStorage,key+':return-plan',planId);};
  const locate=(ref,planId)=>{updateReturn(planId||null);toggle(false);canvasActions.current.locate(ref);};
  const openAssistant=()=>{
    const target=returnPlan||stored(sessionStorage,key+':return-plan',null);
    if(!open&&target){setTab('plans');setFocusPlan(target);updateReturn(null);}
    toggle(!open);
  };
  const pageTo=value=>{setFocusPlan(null);setPage(value);};
  return <>
    <ToolButton label={'打开'+assistantName} buttonRef={launcher} className={`wtt-agent-launch${open?' is-active':''}`}
      expanded={open} controlsId={open?panelId:undefined} description={[!open&&returnPlan?'返回刚才的委托':'',waiting>0?waiting+' 项待确认':''].filter(Boolean).join('。')||undefined}
      hint={!open&&returnPlan?'返回委托':undefined} onClick={openAssistant}>
      <img src={wattterAgentLogo} alt="" draggable={false}/>
      {!open&&returnPlan&&<span className="wtt-agent-return" aria-hidden="true">↩</span>}
      {waiting>0&&<span className="wtt-agent-badge" aria-hidden="true">{waiting}</span>}
    </ToolButton>
    {open&&canvas&&createPortal(<div className="wtt-agent-layer"><div id={panelId} className="wtt-agent-float is-open" data-picking={picking||undefined} style={{width,height,left:Math.round(clamp(position.x)*dx),top:Math.round(clamp(position.y)*dy)}}
      onPointerDown={e=>e.stopPropagation()} onMouseDown={e=>e.stopPropagation()} onDoubleClick={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
    <div className="wtt-agent-grip" {...grip}><PanelHeader title={assistantName} subtitle={requirement.title} onClose={()=>{toggle(false);launcher.current?.focus({preventScroll:true});}} closeLabel={'收起'+assistantName}/></div>
    <nav className="wtt-agent-nav" aria-label={assistantName+'视图'}>
      <UiButton variant="ghost" size="compact" aria-pressed={tab==='chat'} onClick={()=>setTab('chat')}>对话</UiButton>
      <UiButton variant="ghost" size="compact" aria-pressed={tab==='plans'} aria-label="委托" onClick={()=>setTab('plans')}>委托{waiting>0&&<span className="wtt-agent-tab-count" title={waiting+' 项待确认'}>{waiting}</span>}</UiButton>
      <UiButton variant="ghost" size="compact" aria-pressed={tab==='memory'} onClick={()=>setTab('memory')}>项目记忆{state?.suggestions.length>0&&<span className="wtt-agent-tab-count">{state.suggestions.length}</span>}</UiButton>
      <div className="wtt-agent-mode-anchor">
        <UiButton variant="ghost" size="compact" disabled={!session||starting||busy||state?.running} onClick={newConversation}>{starting?'正在新建…':'新建对话'}</UiButton>
        {tab==='chat'&&<ModeMenu value={mode} onChange={v=>{setMode(v);persist(localStorage,key+':mode',v);}}/>}
      </div>
    </nav>
    {error&&<div className="wtt-agent-feedback" role="alert"><span>{error}</span><UiButton size="compact" onClick={()=>setError('')}>关闭提示</UiButton></div>}
    <section className="wtt-agent-chat" aria-label={assistantName+'对话'} hidden={tab!=='chat'}>
      {tab==='chat'&&state?.sessionId===session&&<ChatReview review={state?.review} act={act} locate={locate} busy={busy||starting} onPage={setReviewPage}/>}
      {session?<ProjectInputContext.Provider key={session} value={owner}>{renderConversation({identity:'project-agent:'+session,sessionId:session,label:assistantName,editing:false,onSettled:()=>refresh().catch(e=>setError(e.message))})}</ProjectInputContext.Provider>
        :!error&&<p className="wtt-agent-empty" role="status">正在打开对话…</p>}
    </section>
    {tab==='plans'&&<section className="wtt-agent-queue" aria-label="项目委托">
      {!state?.plans?.length&&<p className="wtt-agent-empty">{state?.view==='plans'?'暂无委托':'正在读取委托…'}</p>}
      <Plans plans={state?.plans} act={act} locate={locate} busy={busy} focusPlan={focusPlan}/>
      {state?.total>20&&<div className="wtt-agent-actions" aria-label="委托分页">
        <UiButton size="compact" disabled={page===0} onClick={()=>pageTo(page-1)}>上一页</UiButton>
        <span>{page+1} / {Math.ceil(state.total/20)}</span>
        <UiButton size="compact" disabled={(page+1)*20>=state.total} onClick={()=>pageTo(page+1)}>下一页</UiButton></div>}
    </section>}
    {tab==='memory'&&<><ProjectMemoryPanel call={call} onChanged={()=>refresh().catch(e=>setError(e.message))} suggestions={state?.suggestions} onLocate={locate}/>
      {session&&<div className="wtt-agent-footer"><UiButton size="compact" disabled={starting||busy||state?.running} onClick={newConversation}>用项目记忆开新对话</UiButton></div>}</>}
    <UiButton variant="custom" className="wtt-agent-resize" aria-label="调整浮窗大小" title="拖动调整浮窗大小" {...resizeGrip}/>
  </div></div>,canvas)}
  </>;
});
