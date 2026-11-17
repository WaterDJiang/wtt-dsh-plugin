import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { UiButton, UiIcon } from './ui/controls.jsx'
import { conversationAttachmentsLocked, MAX_CONVERSATION_FILES, stageConversationReferenceFiles } from './conversation-references.mjs'

export const CanvasConversationReferenceContext = createContext(null)

export function CanvasConversationReferenceButton({ sessionId, useInput, inputActions, getAttachmentService }) {
  const picker = useContext(CanvasConversationReferenceContext)
  const input = useInput(value => value)
  const current = useRef({ sessionId, input })
  const live = useRef(false), cancel = useRef(null), button = useRef(null)
  const [error, setError] = useState('')
  current.current = { sessionId, input }
  useEffect(() => { live.current = true; return () => { live.current = false; cancel.current?.() } }, [sessionId])
  if (!picker) return null
  const supported = Boolean(getAttachmentService()?.createDrafts && getAttachmentService()?.releaseDraftAttachments && inputActions?.addAttachments)
  const remaining = Math.max(0, MAX_CONVERSATION_FILES - input.attachmentIds.length)
  const disabled = !remaining || picker.busy || conversationAttachmentsLocked(input) || !supported
  function select() {
    setError('')
    const isCurrent = () => live.current && current.current.sessionId === sessionId
    try {
      cancel.current = picker.start({ sessionId, isCurrent,
        maxReferences: remaining,
        restoreFocus: () => button.current?.focus({ preventScroll: true }),
        stage: files => stageConversationReferenceFiles({ service: getAttachmentService(), sessionId, inputActions, files,
          readInput: () => current.current.input, isCurrent }) })
    } catch (cause) { setError(cause.message) }
  }
  return <span className="wtt-conversation-canvas-reference">
    <UiButton ref={button} variant="quiet" size="compact" type="button" aria-label="从画布添加资产" disabled={disabled}
      title={!supported ? '当前DSH没有提供对话附件接口' : !remaining ? '一条消息最多添加24份附件' : error || '从画布添加资产'} onClick={select}><UiIcon name="folder" size={14}/>画布资产</UiButton>
    {error && <span role="alert">{error}</span>}
  </span>
}
