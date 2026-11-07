import React,{useState} from 'react'
import {UiButton} from './ui/controls.jsx'
import {buildQuestionAnswer,answerTaskInteraction} from './skill-interactions.mjs'
import {UserError} from './user-feedback.jsx'

export function SvgQuestion({entry,currentEntry,onNative}){
  const [drafts,setDrafts]=useState({}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[sent,setSent]=useState(false)
  const interaction=entry.interaction
  const edit=(id,value)=>setDrafts(previous=>({...previous,[id]:{...previous[id],...value}}))
  async function submit(){setBusy(true);setError('');try{await answerTaskInteraction(entry,buildQuestionAnswer(interaction,drafts,'answer'),()=>currentEntry(entry.key));setSent(true)}catch(cause){setError(cause.message)}finally{setBusy(false)}}
  if(interaction.kind==='approval')return <div className="wtt-svg-question"><p>需要你确认执行权限</p><UiButton onClick={onNative}>处理授权</UiButton></div>
  return <div className="wtt-svg-question" aria-label="AI需要你回答">
    {(interaction.questions||[]).map(question=><fieldset key={question.id} disabled={busy||sent}><legend>{question.question}</legend>
      {(question.options||[]).map(option=><label key={option.label}><input type={question.multiSelect?'checkbox':'radio'} name={`svg-${question.id}`} checked={(drafts[question.id]?.selected||[]).includes(option.label)} onChange={event=>edit(question.id,{selected:question.multiSelect?event.target.checked?[...(drafts[question.id]?.selected||[]),option.label]:(drafts[question.id]?.selected||[]).filter(x=>x!==option.label):[option.label]})}/><span>{option.label}{option.description&&<small>{option.description}</small>}</span></label>)}
      <textarea aria-label={`补充回答：${question.header||question.id}`} value={drafts[question.id]?.custom||''} onChange={event=>edit(question.id,{custom:event.target.value})} maxLength={8000} placeholder="补充你的意见…"/>
    </fieldset>)}
    {error&&<UserError error={error}/>}<UiButton variant="primary" disabled={busy||sent} onClick={()=>void submit()}>{sent?'已回答':busy?'正在发送…':'发送回答'}</UiButton>
  </div>
}
