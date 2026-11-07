import React, { useEffect, useRef } from 'react'
import './embedded-conversation.css'

export const CANVAS_CONVERSATION_SLOT = 'wtt.course.conversation'
export const CANVAS_CONVERSATION_CHILDREN = {
  [CANVAS_CONVERSATION_SLOT]: { kind: 'single', scope: 'session' },
}

function FixedChatView({ renderSlot }) {
  return <div className="wtt-embedded-chat-view">{renderSlot('conversation.session', { view: 'chat' })}</div>
}

// The native embedded factory owns its composer, history, tools and Session sources.
export function EmbeddedConversation({ sessionId, useSession, useConversation, useSessions, renderFactorySlot, onSettled, editing = false }) {
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
  return renderFactorySlot('conversation.content', {
    variant: 'embedded',
    phase: settling ? 'settling' : hero && !editing ? 'hero' : 'active',
    hero: hero && !editing,
  }, {
    slots: { views: FixedChatView },
    fallback: <p role="status">DSH 会话组件尚未加载，请保留当前内容并重试。</p>,
  })
}

export function registerCanvasConversation(ctx) {
  return ctx.slots.inject(CANVAS_CONVERSATION_SLOT, () => ctx.slots.register({
    name: CANVAS_CONVERSATION_SLOT,
  }, EmbeddedConversation))
}
