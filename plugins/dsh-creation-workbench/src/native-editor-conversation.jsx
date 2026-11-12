import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {CANVAS_CONVERSATION_SLOT} from './embedded-conversation.jsx'
import {UiButton} from './ui/controls.jsx'
import {UserError} from './user-feedback.jsx'
import {EDIT_TOKEN} from './native-editor-bridge.mjs'

export function NativeEditorInputDock({sessionId,useInput,inputActions,bridge}){
  useSyncExternalStore(bridge.subscribe,bridge.getVersion,bridge.getVersion)
  const entry=bridge.get(sessionId),input=useInput(value=>value),owner=entry?.get();
  useEffect(()=>{if(entry?.mode&&owner?.ready&&input.phase==='plain'&&!input.draft.trim())inputActions.setDraft(EDIT_TOKEN+' ')},[entry?.mode,owner?.ready,input.phase,input.draft])
  useEffect(()=>{owner?.onDraft?.(input.draft.startsWith(EDIT_TOKEN)?input.draft.slice(EDIT_TOKEN.length).trim():input.draft)},[owner,input.draft])
  if(!owner)return null
  const switchMode=()=>{if(['adjudicating','submitting'].includes(input.phase))return;const enable=!entry.mode;let applied=true;if(enable&&!input.draft.startsWith(EDIT_TOKEN))applied=inputActions.insertText(EDIT_TOKEN+' ',{start:0,end:0,draftRev:input.draftRev});else if(!enable&&input.draft.startsWith(EDIT_TOKEN))applied=inputActions.insertText('',{start:0,end:EDIT_TOKEN.length+(input.draft[EDIT_TOKEN.length]===' '?1:0),draftRev:input.draftRev});if(applied)bridge.setMode(sessionId,enable)}
  return <div className="wtt-native-edit-reference" aria-label="课件修改引用"><div><span title={owner.label}>{entry.mode?owner.label:'普通对话'}</span><UiButton size="compact" disabled={['adjudicating','submitting'].includes(input.phase)||!owner.ready} onClick={switchMode}>{entry.mode?'普通对话':'引用当前内容'}</UiButton></div>{owner.controls}</div>
}

export function NativeEditorConversation({identity,project,sessionId,acquire,onSession,owner,bridge,SessionProvider,renderSlot,onSettled,label='课件'}){
  const [binding,setBinding]=useState(null),[error,setError]=useState(''),ownerRef=useRef(owner),sessionCallback=useRef(onSession);ownerRef.current=owner;sessionCallback.current=onSession;
  useEffect(()=>{let live=true,reference,unregister;setBinding(null);setError('');(async()=>{reference=await acquire(project,sessionId,identity);let actual=reference.sessionId;const bound=await sessionCallback.current?.(actual);if(bound?.sessionId&&bound.sessionId!==actual){reference.release();reference=await acquire(project,bound.sessionId,identity);actual=reference.sessionId}if(!live){reference.release();return}if(ownerRef.current)unregister=bridge.register(actual,()=>ownerRef.current);setBinding({identity,reference})})().catch(cause=>{if(live)setError(cause.message);reference?.release()});return()=>{live=false;unregister?.();reference?.release()}},[identity,project.id])
  useEffect(()=>{if(binding?.identity===identity&&owner)bridge.update(binding.reference.sessionId,JSON.stringify([owner.ready,owner.label,owner.autoCommand,owner.uiKey]))},[binding,identity,owner?.ready,owner?.label,owner?.autoCommand,owner?.uiKey])
  if(error)return <UserError error={`${label}对话未能打开：${error}`}/>
  if(binding?.identity!==identity)return <p role="status">正在打开{label}对话…</p>
  return <div className="wtt-native-editor-conversation"><SessionProvider session={binding.reference}>{renderSlot(CANVAS_CONVERSATION_SLOT,{onSettled,editing:true})}</SessionProvider></div>
}
