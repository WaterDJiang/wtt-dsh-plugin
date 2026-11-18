import React, { useEffect, useRef, useState } from 'react'

export function VideoPreview({ src, deferDesktopSeek = false, ...props }) {
  if (src?.startsWith('dsh-app://') && new URL(src).searchParams.get('preview') === '1') {
    return <DesktopVideo key={src} src={src} deferSeek={deferDesktopSeek} {...props} />
  }
  return <video src={src} controls preload="metadata" playsInline {...props} />
}

function DesktopVideo({ src, deferSeek, onPointerDown, onFocus, onPlay, onLoadedMetadata, ...props }) {
  const player = useRef(null)
  const preparation = useRef(null)
  const [objectUrl, setObjectUrl] = useState('')
  const [preparing, setPreparing] = useState(false)

  function prepare() {
    if (preparation.current) return
    const operation = { controller: new AbortController() }
    preparation.current = operation
    const { signal } = operation.controller
    setPreparing(true)

    // The desktop bridge drops Content-Length, which Chromium needs for media seeking.
    fetch(src, { credentials: 'same-origin', signal }).then(response => {
      if (!response.ok || !response.headers.get('Content-Type')?.startsWith('video/')) throw new Error('视频预览读取失败')
      return response.blob()
    }).then(blob => {
      if (signal.aborted || !player.current || !blob.size) return
      operation.url = URL.createObjectURL(blob)
      const { currentTime, paused, playbackRate } = player.current
      operation.restore = { currentTime, paused, playbackRate }
      setObjectUrl(operation.url)
    }).catch(() => {}).finally(() => {
      if (signal.aborted) return
      if (!operation.url) preparation.current = null
      setPreparing(false)
    })
  }

  useEffect(() => {
    if (!deferSeek) prepare()
    return () => {
      const operation = preparation.current
      preparation.current = null
      operation?.controller.abort()
      if (operation?.url) URL.revokeObjectURL(operation.url)
    }
  }, [])

  function restorePlayback(event) {
    const video = event.currentTarget
    const operation = preparation.current
    if (operation?.restore && operation.url === video.currentSrc) {
      const { currentTime, paused, playbackRate } = operation.restore
      operation.restore = null
      if (currentTime > 0) video.currentTime = Math.min(currentTime, video.duration)
      video.playbackRate = playbackRate
      if (!paused) void video.play().catch(() => {})
    }
    onLoadedMetadata?.(event)
  }

  return <video ref={player} src={objectUrl || src} controls preload="metadata" playsInline {...props}
    aria-busy={preparing || undefined} onLoadedMetadata={restorePlayback}
    onPointerDown={event => { prepare(); onPointerDown?.(event) }}
    onFocus={event => { prepare(); onFocus?.(event) }}
    onPlay={event => { prepare(); onPlay?.(event) }} />
}
