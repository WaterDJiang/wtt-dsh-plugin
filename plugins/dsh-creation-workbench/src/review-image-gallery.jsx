import React, { useEffect, useId, useRef, useState } from 'react'
import { PanelHeader, UiButton } from './ui/controls.jsx'
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

function ImageDialog({ image, number, getHref, onClose }) {
  const dialog = useRef(null), titleId = useId(), [failed, setFailed] = useState(false)
  useEffect(() => {
    const trigger = document.activeElement, element = dialog.current
    element.showModal()
    return () => { element.close(); if (trigger?.isConnected) trigger.focus({ preventScroll: true }) }
  }, [])
  return <dialog ref={dialog} className="wcc-review-image-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }} onKeyDown={event => event.stopPropagation()}>
    <PanelHeader title={`候选 ${number} · ${image.name}`} titleId={titleId} downloadHref={getHref(image, false)}
      onClose={onClose} closeLabel="关闭候选图片" />
    <div className="wcc-review-image-full">{failed ? <p role="alert">图片暂时无法预览，请关闭后重新核对文件与校验值。</p>
      : <img src={getHref(image, true)} alt={`候选图片 ${number}：${image.name}`} onError={() => setFailed(true)} />}</div>
  </dialog>
}

export function ReviewImageGallery({ images, getHref, onOpen }) {
  const [all, setAll] = useState(false), [opened, setOpened] = useState(null)
  return <details className="wcc-review-images" open>
    <summary>候选图片 · {images.length}</summary>
    <div className="wcc-review-image-grid">{(all ? images : images.slice(0, 3)).map((image, index) =>
      <CandidateImage key={`${image.path}:${image.hash}`} image={image} number={index + 1} href={getHref(image, true)}
        onOpen={() => { if (onOpen(image)) setOpened(index) }} />)}</div>
    {images.length > 3 && <UiButton variant="ghost" size="compact" onClick={() => setAll(value => !value)}>{all ? '收起' : `展开其余 ${images.length - 3} 张`}</UiButton>}
    {opened !== null && <ImageDialog image={images[opened]} number={opened + 1} getHref={getHref} onClose={() => setOpened(null)} />}
  </details>
}
