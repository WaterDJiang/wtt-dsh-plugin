import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { conversationPreviewSlot, registerConversationPreviewScope } from './conversation-preview-scope.mjs'
import './embedded-conversation.css'

export const CANVAS_CONVERSATION_SLOT = 'wtt.course.conversation'
const FILE_SESSION_SLOT = conversationPreviewSlot('conversation.session')
const FilePreviewContext = createContext(null)
export const CANVAS_CONVERSATION_CHILDREN = {
  [CANVAS_CONVERSATION_SLOT]: { kind: 'single', scope: 'session' },
}

function FixedChatView() {
  const { renderSession } = useContext(FilePreviewContext)
  return <div className="wtt-embedded-chat-view">{renderSession()}</div>
}

// The native embedded factory owns its composer, history, tools and Session sources.
export function EmbeddedConversation({ sessionId, useSession, useConversation, useSessions, renderSlot, renderFactorySlot, onOpenFile, onSettled, editing = false }) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const previousRunning = useRef(session.running)
  useEffect(() => {
    const wasRunning = previousRunning.current
    previousRunning.current = session.running
    if (wasRunning === true && session.running === false) onSettled?.()
  }, [session.running, onSettled])
  const shellPhase = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
    ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const parentPending = session.subagent?.address.mode === 'continuable' && session.subagent.parentAvailable === undefined
  const settling = (shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true) || parentPending
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const filePreview = useMemo(() => ({ openFile: onOpenFile,
    renderSession: () => renderSlot(FILE_SESSION_SLOT, { view: 'chat' }, { fallback: <p role="alert">DSH 对话文件预览尚未加载。</p> }),
  }), [onOpenFile, renderSlot])
  return <FilePreviewContext.Provider value={filePreview}>{renderFactorySlot('conversation.content', {
    variant: 'embedded',
    phase: settling ? 'settling' : hero && !editing ? 'hero' : 'active',
    hero: hero && !editing,
  }, {
    slots: { views: FixedChatView },
    fallback: <p role="status">DSH 会话组件尚未加载，请保留当前内容并重试。</p>,
  })}</FilePreviewContext.Provider>
}

export function registerCanvasConversation(ctx) {
  return ctx.slots.inject(CANVAS_CONVERSATION_SLOT, () => ctx.slots.register({
    name: CANVAS_CONVERSATION_SLOT,
    children: { [FILE_SESSION_SLOT]: { kind: 'single', scope: 'session' } },
  }, EmbeddedConversation))
}

// Native callbacks carry exact file paths; CSS classes and tooltips are optional.
export function registerConversationFilePreview(ctx) {
  ctx.effect(() => registerConversationPreviewScope(ctx, (Component, slot) => function FileConversation(props) {
    const { openFile } = useContext(FilePreviewContext)
    const { renderSlot, renderSlotChain } = props
    const renderLocal = useMemo(() => ({
      ...(renderSlot && { renderSlot: (name, ...args) => renderSlot(conversationPreviewSlot(name), ...args) }),
      ...(renderSlotChain && { renderSlotChain: (name, ...args) => renderSlotChain(conversationPreviewSlot(name), ...args) }),
    }), [renderSlot, renderSlotChain])
    return <Component {...props} {...renderLocal}
      {...(slot === 'conversation.view' && openFile ? { openFile } : {})}/>
  }))
}
