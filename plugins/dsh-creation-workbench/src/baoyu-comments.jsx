import { PanelHeader, UiButton } from './ui/controls.jsx'
import { UserError } from './user-feedback.jsx'
import React, { useEffect, useState } from 'react'

const commentCopies=new Map()
export function BaoyuComments({ draftKey='default', draft, snapshot, pending, error, onSubmit, onClose }) {
  const key=JSON.stringify([draftKey,draft?.anchor||'list']),copy=commentCopies.get(key)||{}
  const [text, setText] = useState(copy.text||''), [send, setSend] = useState(copy.send||false), [replyTo, setReplyTo] = useState(copy.replyTo||null)
  useEffect(()=>{commentCopies.set(key,{text,send,replyTo})},[key,text,send,replyTo])
  const canSend = Boolean(snapshot?.agent?.available && snapshot?.agent?.listening)
  const submit = async event => {
    event.preventDefault()
    if (!text.trim() || pending) return
    const saved = await onSubmit({ text: text.trim(), send: send && canSend, ...(replyTo ? { id: replyTo } : {}) })
    if (saved) { setText(''); setReplyTo(null); setSend(false) }
  }
  return <section className="wtt-baoyu-comments" aria-label="课件批注">
    <PanelHeader title={draft ? `批注 · ${draft.label || '当前内容'}` : '课件批注'} onClose={onClose} closeLabel="关闭课件批注"/>
    {error && <UserError error={error} />}
    {!draft && <div className="wtt-baoyu-comment-list">{(snapshot?.threads || []).map(thread => <article key={thread.id}>
      <strong>{thread.location?.where || thread.location?.label || thread.label || '页面批注'}</strong>
      {(thread.messages || []).map((message, index) => <p key={message.id || index}><small>{message.author?.kind === 'agent' || message.from === 'agent' ? 'AI' : '你'} · </small>{message.text}</p>)}
      <UiButton variant="quiet" type="button" disabled={pending} onClick={() => { setReplyTo(thread.id); setText('') }}>{replyTo === thread.id ? '正在回复' : '回复批注'}</UiButton>
    </article>)}{!snapshot?.threads?.length && <p>选中页面文字或元素，点击编辑工具栏的“批注”。</p>}</div>}
    {(draft || replyTo) && <form onSubmit={submit}>
      {draft?.detail && <details><summary>所选内容</summary><p>{typeof draft.detail === 'string' ? draft.detail : JSON.stringify(draft.detail)}</p></details>}
      <textarea aria-label="课件批注内容" value={text} onChange={event => setText(event.target.value)} maxLength={8000} rows={3} placeholder="写下修改要求或反馈…" disabled={pending} autoFocus />
      <div><label><input type="checkbox" checked={send} onChange={event => setSend(event.target.checked)} disabled={!canSend || pending} />发送给 AI</label>
        <UiButton variant="primary" type="submit" className="is-primary" disabled={!text.trim() || pending}>{pending ? '正在保存…' : send && canSend ? '保存并发送' : '保存批注'}</UiButton></div>
      {!canSend && <small>批注可先保存；恢复原任务连接后再发送给 AI。</small>}
    </form>}
  </section>
}
