import React, { useEffect, useMemo, useState } from 'react'
import { apply as documentPreviewPlugin } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
import { previewPluginScope, nativePreviewSlot } from './native-preview-scope.mjs'
import { UserError } from './user-feedback.jsx'
import './native-preview.css'

export const NATIVE_PREVIEW_SLOT = 'wtt.course.documentPreview'
export const NATIVE_PREVIEW_CHILDREN = { [NATIVE_PREVIEW_SLOT]: { kind: 'single', scope: 'session' } }
const DOCUMENT_BODY = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
export const nativeFileAddress = (sessionId, file) => `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${file.split('/').map(encodeURIComponent).join('/')}`

function NativeDocumentSeat({ source, active, renderSlot }) {
  const lifetime = useMemo(() => new AbortController(), [source.sessionId, source.path, source.hash])
  useEffect(() => () => lifetime.abort(), [lifetime])
  const info = useMemo(() => {
    const address = nativeFileAddress(source.sessionId, source.path)
    return { sidebar: { expanded: true, fullscreen: false }, panel: { id: 'wtt-preview' }, tab: {
      id: `wtt-document-${crypto.randomUUID()}`, kind: 'text', title: source.name, contentId: address,
      visible: active, signal: lifetime.signal, navigation: { address, params: undefined, revision: 1 },
      actions: { bindCommands: () => () => {},
        openResource: () => { throw new Error('请从文件栏选择要打开的文件。') },
        openTab: () => { throw new Error('请从课件卡选择网页工程。') }, close: () => {} },
    } }
  }, [source.sessionId, source.path, source.hash, lifetime])
  const useTabInfo = useMemo(() => () => ({ ...info, tab: { ...info.tab, visible: active } }), [info, active])
  return <div className="wtt-native-preview" data-native-document-preview={source.format}>
    {renderSlot(nativePreviewSlot('sidebar.right.pane.tab'), {}, { entryKey: DOCUMENT_BODY, hookContext: useTabInfo,
      fallback: <p role="alert">DSH 文件预览尚未加载，请检查宿主的文档预览插件。</p> })}
  </div>
}

export function registerNativePreview(ctx) {
  const dispose = ctx.slots.inject(NATIVE_PREVIEW_SLOT, () => ctx.slots.register({ name: NATIVE_PREVIEW_SLOT,
    children: Object.fromEntries(['sidebar.right.pane.tab','sidebar.right.pane.tab.title'].map(name => [nativePreviewSlot(name), {
      kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: (_standard, useTabInfo) => useTabInfo } },
    }])),
  }, NativeDocumentSeat))
  const scope = previewPluginScope(ctx, (Component, rename) => function WorkbenchNativeDocument(props) {
    const renderSlot = useMemo(() => (name, ...args) => props.renderSlot(rename(name), ...args), [props.renderSlot])
    // Workbench file previews use the native static HTML mode. Interactive
    // slide projects retain their dedicated Baoyu editor and source lifecycle.
    return <Component {...props} {...(props.useInteractivePreview ? { useInteractivePreview: () => false } : {})} renderSlot={renderSlot} />
  })
  documentPreviewPlugin(scope)
  return dispose
}

export function HostFilePreview({ source, project, active = true, acquire, SessionProvider, renderSlot }) {
  const [binding, setBinding] = useState(null), [error, setError] = useState('')
  const identity = `${project.id}:${source.path}:${source.hash}`
  useEffect(() => {
    let disposed = false, retained
    setError(''); setBinding(null)
    acquire(project, source.sessionId).then(reference => {
      if (disposed) { reference.release(); return }
      retained = reference; setBinding({ identity, reference })
    }).catch(cause => { if (!disposed) setError(cause.message) })
    return () => { disposed = true; queueMicrotask(() => retained?.release()) }
  }, [identity, source.sessionId, acquire])
  if (error) return <UserError error={`文件预览未能打开：${error}`} />
  if (binding?.identity !== identity) return <p role="status">正在打开文件预览…</p>
  return <SessionProvider session={binding.reference}>{renderSlot(NATIVE_PREVIEW_SLOT, {
    source: { ...source, sessionId: binding.reference.sessionId }, active,
  })}</SessionProvider>
}
