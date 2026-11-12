import { PanelHeader, UiButton } from './ui/controls.jsx'
import React, { useEffect, useRef, useState } from 'react'
import './output-preview.css'

const fileBlocked = status => ['missing', 'changed', 'modified', 'unavailable'].includes(status)
const messageOf = value => value?.message || value?.error?.message || value?.error || String(value)

function useDeckManifest({ artifactId, hash, loadPreview, enabled = true }) {
  const identity = `${artifactId || ''}:${hash || ''}`
  const loader = useRef(loadPreview)
  loader.current = loadPreview
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState(null)
  const canLoad = Boolean(enabled && artifactId && hash && loadPreview)
  useEffect(() => {
    if (!canLoad) return
    let disposed = false
    const controller = new AbortController()
    Promise.resolve().then(() => loader.current({ artifactId, hash, signal: controller.signal })).then(manifest => {
      if (disposed) return
      if (manifest?.artifactId !== artifactId || manifest?.hash !== hash) throw new Error('课件预览与当前文件版本不一致，请重新读取。')
      if (manifest.status !== 'ready') throw new Error(messageOf(manifest.error || '此版本的课件预览未能生成。'))
      const pages = manifest.pages
      if (!Array.isArray(pages) || !pages.length || manifest.pageCount !== pages.length
        || pages.some(page => !Number.isInteger(page.number) || page.number < 1)
        || new Set(pages.map(page => page.number)).size !== pages.length) throw new Error('课件预览页信息不完整，请重新读取。')
      setResult({ identity, attempt, manifest: { ...manifest, pages: [...pages].sort((a, b) => a.number - b.number) } })
    }).catch(cause => {
      if (!disposed) setResult({ identity, attempt, error: messageOf(cause) })
    })
    return () => { disposed = true; controller.abort() }
  }, [artifactId, hash, canLoad, attempt])
  const current = result?.identity === identity && result.attempt === attempt ? result : null
  return { identity, attempt, manifest: current?.manifest, error: current?.error,
    loading: canLoad && !current, unavailable: !canLoad,
    retry: () => setAttempt(value => value + 1) }
}

function PptCover({ artifactId, hash, loadPreview, getPageHref, src, title, onOpen, disabled, compact }) {
  const preview = useDeckManifest({ artifactId, hash, loadPreview, enabled: !src && !disabled })
  const [imageError, setImageError] = useState('')
  const page = preview.manifest?.pages.find(item => item.number === preview.manifest.coverPage) || preview.manifest?.pages[0]
  // The page route is bound to the original PPTX hash, never the PNG's page.hash.
  const image = src || (page && getPageHref?.({ artifactId, hash, page: page.number }))
  const imageKey = `${image || ''}:${preview.attempt}`
  const failed = imageError === imageKey
  return <UiButton variant="custom" type="button" className="wtt-output-ppt-cover" disabled={disabled || !onOpen} onClick={event => { if (!compact || event.detail === 0) { event.stopPropagation(); onOpen?.() } }} onDoubleClick={compact ? event => { event.stopPropagation(); onOpen?.() } : undefined} aria-label={`${compact ? '双击逐页预览' : '逐页预览'}：${title || 'PPT'}`}>
    {image && !failed ? <img key={imageKey} src={image} alt={`${title || 'PPT'}封面`} loading="lazy" draggable={false} onError={() => setImageError(imageKey)} />
      : <span className="wtt-output-ppt-placeholder">{preview.loading ? '正在生成封面…' : preview.error ? '封面暂不可用，请打开课件查看' : (failed ? '封面暂不可用' : 'PPT 课件')}</span>}
    <span className="wtt-output-ppt-caption">{preview.manifest ? `${preview.manifest.pageCount} 页 · ` : ''}{compact ? '双击逐页查看' : '逐页查看'}</span>
  </UiButton>
}

export function OutputPreview({ type = 'text', title, content, extracted = true, mime, src, downloadHref, status = 'ready', onOpenDeck,
  artifactId, hash, loadPreview, getPageHref, compact = false, emptyMessage }) {
  const [mediaError, setMediaError] = useState('')
  const identity = `${type}:${src || ''}`
  const unavailable = fileBlocked(status)
  const failed = mediaError === identity
  const hasText = extracted !== false && typeof content === 'string' && content.trim()
  const previewText = compact && hasText && content.length > 600
    ? content.slice(0, 600).replace(/[\uD800-\uDBFF]$/, '') + '…' : content
  return <section className={`wtt-output-preview is-${type}${compact ? ' is-compact' : ''}`} aria-label={`${title || '成果文件'}预览`}>
    {unavailable ? <p className="wtt-output-preview-note" role="status">此版本文件已缺失或变化，无法沿用旧预览，请核对原文件。</p>
      : type === 'pptx' ? <PptCover artifactId={artifactId} hash={hash} loadPreview={loadPreview} getPageHref={getPageHref} src={src} title={title} onOpen={onOpenDeck} compact={compact} />
        : type === 'image' && src && !failed ? <img key={identity} className="wtt-output-image" src={src} alt={title || '生成图片'} loading="lazy" decoding="async" draggable={false} onError={() => setMediaError(identity)} />
          : type === 'video' && src && !failed ? <video key={identity} className="wtt-output-video nodrag nopan nowheel" src={src} controls preload="metadata" playsInline aria-label={title || '生成视频'}
            onError={() => setMediaError(identity)} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} />
            : ['image', 'video'].includes(type) ? <p className="wtt-output-preview-note" role="status">{failed ? type === 'video' ? '浏览器无法播放此版本，可下载原视频查看。' : '此版本图片未能加载，可下载原图查看。' : emptyMessage || '尚未取得可预览的文件。'}</p>
              : hasText ? <pre className={`wtt-output-text${compact ? '' : ' nodrag nowheel'}`}>{previewText}</pre>
                : <p className="wtt-output-preview-note">{emptyMessage || (extracted === false ? '此格式尚未提取可读正文，可下载原文件查看。' : '尚无已保存的文本成果。')}</p>}
    {!compact && downloadHref && <a className="wtt-output-download" href={downloadHref} download onClick={event => event.stopPropagation()}>下载当前版本</a>}
  </section>
}

export function DeckPreview({ artifactId, hash, title = '课件预览', loadPreview, getPageHref, downloadHref, onClose }) {
  const preview = useDeckManifest({ artifactId, hash, loadPreview })
  const [selection, setSelection] = useState(null)
  const [pageErrors, setPageErrors] = useState(() => new Set())
  const identity = `${preview.identity}:${preview.attempt}`
  const pages = preview.manifest?.pages || []
  const selectedNumber = selection?.identity === identity ? selection.number : preview.manifest?.coverPage || pages[0]?.number
  const currentIndex = Math.max(0, pages.findIndex(page => page.number === selectedNumber))
  const current = pages[currentIndex]
  const pageHref = page => getPageHref?.({ artifactId, hash, page: page.number })
  const choose = index => { if (pages[index]) setSelection({ identity, number: pages[index].number }) }
  const failPage = number => setPageErrors(previous => new Set(previous).add(`${identity}:${number}`))
  function onKeyDown(event) {
    event.stopPropagation()
    if (event.key === 'Escape' && onClose) { event.preventDefault(); onClose(); return }
    if (event.target?.closest('input,textarea,select,video') || !pages.length) return
    const target = { ArrowLeft: currentIndex - 1, ArrowRight: currentIndex + 1, Home: 0, End: pages.length - 1 }[event.key]
    if (target === undefined) return
    event.preventDefault()
    choose(Math.max(0, Math.min(pages.length - 1, target)))
  }
  return <aside className="wtt-deck-preview nodrag nopan nowheel" aria-label="PPT 逐页预览" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={onKeyDown}>
    <PanelHeader title={title} subtitle="PPT · 实际课件预览" downloadHref={downloadHref} onClose={onClose} closeLabel="关闭课件预览" />
    {preview.loading ? <div className="wtt-deck-feedback" role="status"><span className="wtt-deck-loading" aria-hidden="true" /><p>正在读取此版本的实际幻灯片…</p><small>首次预览会在本机转换，不调用模型。</small></div>
      : preview.error || preview.unavailable ? <div className="wtt-deck-feedback" role="alert"><strong>课件预览暂不可用</strong><p>{preview.error || '当前文件缺少预览信息。'}</p><UiButton variant="quiet" type="button" onClick={preview.retry} disabled={preview.unavailable}>重新读取预览</UiButton><small>正式 PPTX 保留，可下载原文件查看。</small></div>
        : <div className="wtt-deck-body"><nav className="wtt-deck-thumbnails" aria-label="幻灯片缩略图">
          {pages.map((page, index) => <UiButton variant="custom" type="button" key={`${identity}:${page.number}`} aria-label={`第 ${page.number} 页`} aria-current={index === currentIndex ? 'page' : undefined} onClick={() => choose(index)}>
            <span>{page.number}</span><img src={pageHref(page)} alt={`第 ${page.number} 页缩略图`} loading="lazy" decoding="async" draggable={false} />
          </UiButton>)}
        </nav><div className="wtt-deck-stage"><div className="wtt-deck-page" tabIndex={0} aria-label={`第 ${current?.number || 1} 页，左右键翻页`}>
          {current && !pageErrors.has(`${identity}:${current.number}`) ? <img key={`${identity}:${current.number}`} src={pageHref(current)} alt={`${title} · 第 ${current.number} 页`} draggable={false} onError={() => failPage(current.number)} />
            : <div className="wtt-deck-feedback" role="alert"><p>此页预览加载失败。</p><UiButton variant="quiet" type="button" onClick={preview.retry}>重新读取预览</UiButton></div>}
        </div><footer className="wtt-deck-navigation"><UiButton variant="quiet" type="button" onClick={() => choose(currentIndex - 1)} disabled={currentIndex === 0}>上一页</UiButton><span aria-live="polite">第 {current?.number || 1} 页 / 共 {pages.length} 页</span><UiButton variant="quiet" type="button" onClick={() => choose(currentIndex + 1)} disabled={currentIndex >= pages.length - 1}>下一页</UiButton></footer><p className="wtt-deck-derived-note">按此版本 PPTX 渲染；预览图不替代可编辑课件。</p>
          {!!preview.manifest?.warnings?.length && <details className="wtt-deck-render-notes"><summary>渲染提示 · {preview.manifest.warnings.length}</summary>{preview.manifest.warnings.map((warning, index) => <p key={index}>{typeof warning === 'string' ? warning : [warning.source, warning.message].filter(Boolean).join('：')}</p>)}</details>}
        </div></div>}
  </aside>
}
