import React,{useEffect,useId,useRef,useState} from 'react'
import {DialogHeader,DialogBody,DialogFooter,UiButton} from './ui/controls.jsx'
import {UserError} from './user-feedback.jsx'
import './editor-exit-dialog.css'

export function EditorExitDialog({onCancel,onKeep,onSave,canSave=true,working=false,pending=false}){
  const dialog=useRef(null),heading=useId(),[action,setAction]=useState(''),[error,setError]=useState('')
  useEffect(()=>{dialog.current?.showModal();dialog.current?.querySelector('[data-continue-editing]')?.focus()},[])
  const busy=Boolean(action||working)
  async function run(kind,callback){if(busy)return;setAction(kind);setError('');try{await callback()}catch(cause){setError(cause.message||String(cause));setAction('')}}
  return <dialog ref={dialog} className="wtt-editor-exit" aria-labelledby={heading} onCancel={event=>{event.preventDefault();if(!busy)onCancel()}} onKeyDown={event=>event.stopPropagation()}>
    <DialogHeader title="退出编辑？" titleId={heading} onClose={onCancel} closeLabel="继续编辑" busy={busy}/>
    <DialogBody><p>{working?'正在保存新版本，请等待完成。':pending?'AI任务或待确认方案会保留，可回到白板继续处理。':'可保存为新版本，或保留草稿后返回白板。'}</p>{error&&<UserError error={error}/>}</DialogBody>
    <DialogFooter><UiButton data-continue-editing disabled={busy} onClick={onCancel}>继续编辑</UiButton><UiButton disabled={busy} onClick={()=>void run('keep',onKeep)}>{action==='keep'?'正在保存草稿…':'保留草稿退出'}</UiButton><UiButton variant="primary" disabled={busy||!canSave} onClick={()=>void run('save',onSave)}>{action==='save'?'正在保存…':'保存新版本并退出'}</UiButton></DialogFooter>
  </dialog>
}
