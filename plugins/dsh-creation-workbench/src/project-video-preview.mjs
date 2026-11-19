import { createHash } from 'node:crypto'
import { constants, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { GENERATED_MEDIA_MAX_BYTES } from './artifact-validation.mjs'
import { inspectVideoFile, isVideoContainer } from './material-import.mjs'
import { importedFileResponse, mediaChunkBytes, streamedMediaResponse } from './media-response.mjs'

const signatureOf = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':')

export async function projectVideoPreview(files, relative, { hash, response, signal } = {}) {
  const extension = path.extname(relative || '').toLowerCase()
  if (extension !== '.mp4' && extension !== '.webm') return null
  signal?.throwIfAborted()
  const absolute = files.resolve(relative)
  if (path.relative(files.root, absolute).split(path.sep)[0].toLowerCase() === '.wtt-workbench') throw new Error('请选择当前项目内的视频文件')
  const original = statSync(absolute), signature = signatureOf(original)
  const size = original.size
  if (size > GENERATED_MEDIA_MAX_BYTES) throw new Error('视频不能超过 200 MiB')
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  const name = path.basename(absolute), mime = 'video/' + extension.slice(1)
  const changed = () => new Error('视频文件已变化，请重新打开')
  const assertCurrent = async () => {
    signal?.throwIfAborted()
    if (signatureOf(await handle.stat()) !== signature || signatureOf(statSync(files.resolve(relative))) !== signature) throw changed()
  }
  let handedOff = false
  try {
    await assertCurrent()
    const key = 'video:' + relative
    let metadata = files.cache.get(key)
    if (metadata?.signature !== signature) {
      const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(size, mediaChunkBytes))
      let containerChecked = false, position = 0
      while (position < size) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, 0, Math.min(size - position, buffer.length), position)
        if (!bytesRead) throw changed()
        const chunk = buffer.subarray(0, bytesRead)
        if (!position) containerChecked = isVideoContainer(chunk, extension)
        digest.update(chunk)
        position += bytesRead
      }
      await assertCurrent()
      let media, videoError
      try {
        if (!size) throw new Error('视频文件为空')
        if (!containerChecked) throw new Error('视频容器与文件扩展名不符或文件损坏')
        const validated = await inspectVideoFile(absolute, { extension, mime }, { ffprobe: files.service.ffprobe, signal })
        media = validated.media
      } catch (cause) {
        signal?.throwIfAborted()
        videoError = cause.code === 'ENOENT' ? '本机 ffprobe 不可用，无法验证视频' : cause.message || '视频格式验证失败'
      }
      await assertCurrent()
      metadata = { signature, hash: digest.digest('hex'), media, videoError }
      if (files.cache.size >= 8) files.cache.delete(files.cache.keys().next().value)
      files.cache.set(key, metadata)
    }
    if (hash && metadata.hash !== hash) throw changed()
    if (response) {
      if (response.preview && !metadata.media) throw new Error(metadata.videoError || '无法预览此视频')
      await assertCurrent()
      const contentType = response.preview ? mime : 'application/octet-stream'
      if (!size) return importedFileResponse({ name, bytes: Buffer.alloc(0), mime: contentType }, response)
      handedOff = true
      return await streamedMediaResponse({ name, size, mime: contentType }, { ...response, handle, assertCurrent, changed, signal })
    }
    return { path: relative, originalPath: relative, name, title: name, format: extension.slice(1), mime,
      sourceRef: null, status: 'ready', hash: metadata.hash, videoError: metadata.videoError }
  } finally {
    if (!handedOff) await handle.close()
  }
}
