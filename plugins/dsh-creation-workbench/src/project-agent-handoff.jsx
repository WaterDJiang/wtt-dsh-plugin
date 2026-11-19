import React from 'react';
import { UiButton } from './ui/controls.jsx';

export function StepHandoff({step,act,busy,offerTakeover=false}){
  const {handoff,choice,receipt,consumers}=step;
  if(!handoff&&!choice&&!offerTakeover)return null;
  return <div className="wtt-agent-handoff">
    <span role="status">{handoff?'你正在处理':choice?`已有 V${choice.number} · 当前使用 V${receipt.number}`:'项目助手在跟进'}</span>
    {choice&&<UiButton size="compact" variant="primary" disabled={busy} onClick={()=>act('use-version')}>
      {handoff?`交回助手 · V${choice.number}`:`采用 V${choice.number}`}
    </UiButton>}
    {choice&&!handoff&&<UiButton size="compact" disabled={busy} onClick={()=>act('keep-version')}>保留 V{receipt.number}</UiButton>}
    {!handoff&&!choice&&offerTakeover&&<UiButton size="compact" disabled={busy} onClick={()=>act('take-over')}>接管这一步</UiButton>}
    {handoff&&choice&&consumers?.length>0&&<small>接下来 · {consumers.join('、')}</small>}
  </div>;
}
