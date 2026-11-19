import React, { useEffect, useId, useRef, useState } from 'react'
import { PanelHeader, UiButton, UiIcon } from './ui/controls.jsx'
import { OutputPreview } from './output-preview.jsx'
import './review-image-gallery.css'

function CandidateImage({ image, number, href, onOpen }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0)
  return <figure>
    {failed ? <div className="wcc-review-image-error"><span role="status">图片暂时无法预览，请核对文件与校验值。</span>
      <UiButton size="compact" onClick={() => { setFailed(false); setAttempt(value => value + 1) }}>重新加载</UiButton></div>
      : <UiButton variant="custom" className="wcc-review-image-thumb" aria-label={`放大候选图片 ${number}：${image.name}`} onClick={onOpen}>
        <img key={attempt} src={href} alt={`候选图片 ${number}`} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </UiButton>}
    <figcaption title={image.name}>{number} · {image.name}</figcaption>
  </figure>
}

function CandidateDialog({ image, number, getHref, onClose }) {
  const dialog = useRef(null), titleId = useId(), [failed, setFailed] = useState(false)
  const video = image.kind === 'video'
  useEffect(() => {
    const trigger = document.activeElement, element = dialog.current
    element.showModal()
    return () => { element.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={dialog} className="wcc-review-image-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <PanelHeader title={`候选 ${number} · ${image.name}`} titleId={titleId} downloadHref={getHref(image, false)}
      onClose={onClose} closeLabel={video ? '关闭候选视频' : '关闭候选图片'} />
    <div className="wcc-review-image-full">{video
      ? <OutputPreview type="video" title={image.name} src={getHref(image, true)} deferDesktopSeek />
      : failed ? <p role="alert">图片暂时无法预览，请关闭后重新核对文件与校验值。</p>
      : <img src={getHref(image, true)} alt={`候选图片 ${number}：${image.name}`} onError={() => setFailed(true)} />}</div>
  </dialog>
}

export function ReviewMediaGallery({ items, getHref, onOpen }) {
  const [all, setAll] = useState(false), [opened, setOpened] = useState(null)
  const videos = items.filter(item => item.kind === 'video').length
  const label = !videos ? '候选图片' : videos === items.length ? '候选视频' : '待审媒体'
  const open = (item, index) => { if (onOpen(item)) setOpened(index) }
  return <details className="wcc-review-images" open>
    <summary>{label} · {items.length}</summary>
    <div className="wcc-review-image-grid">{(all ? items : items.slice(0, 3)).map((image, index) => image.kind === 'video'
      ? <UiButton key={`${image.path}:${image.hash}`} variant="ghost" className="wcc-review-video-trigger"
        aria-label={`播放候选视频 ${index + 1}：${image.name}`} title={image.name} onClick={() => open(image, index)}>
        <UiIcon name="video" /><span>{image.name}</span>
      </UiButton>
      : <CandidateImage key={`${image.path}:${image.hash}`} image={image} number={index + 1} href={getHref(image, true)}
        onOpen={() => open(image, index)} />)}</div>
    {items.length > 3 && <UiButton variant="ghost" size="compact" onClick={() => setAll(value => !value)}>{all ? '收起' : `展开其余 ${items.length - 3} ${videos ? '项' : '张'}`}</UiButton>}
    {opened !== null && <CandidateDialog image={items[opened]} number={opened + 1} getHref={getHref} onClose={() => setOpened(null)} />}
  </details>
}
