export function nativeConversationFilePath(button) {
  if (!button) return ''
  const classes = [...button.classList]
  if (classes.some(name => /(?:^|_)fileMention(?:_|$)/.test(name))) return button.title
  // DSH's read/write/edit buttons display the full workspace-relative path.
  if (classes.some(name => /(?:^|_)fileLink(?:_|$)/.test(name))) return button.textContent
  return ''
}

export function conversationFileSelection(root, file) {
  const path = file.replaceAll('\\', '/')
  const prefix = root.replaceAll('\\', '/').replace(/\/+$/, '') + '/'
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path
  const segments = relative.split('/').filter(part => part && part !== '.')
  if (relative.startsWith('/') || relative.startsWith('~/') || /^[a-z][a-z0-9+.-]*:/i.test(relative) || /[\x00-\x1f\x7f]/.test(relative)
    || segments.length === 0 || segments.includes('..') || segments[0] === '.wtt-workbench') {
    throw new Error('请选择当前项目内的文件。')
  }
  return { path: segments.join('/'), name: segments.at(-1), fromConversation: true }
}

export function reviewDraftFromQuestion(root, question) {
  if (!root || !question) return null
  const spans = [...question.matchAll(/`([^`\r\n]+)`/gu)]
  const drafts = new Map()
  for (let index = 0; index + 1 < spans.length; index += 1) {
    const [file, checksum] = spans.slice(index, index + 2)
    if (!/[\\/]/.test(file[1]) || !/\.(md|markdown|txt|docx|pdf|pptx|csv|html?)$/i.test(file[1])) continue
    const label = question.slice(file.index + file[0].length, checksum.index)
    if (!/(?:sha[- ]?256|哈希|校验值)\s*[:：]?\s*$/i.test(label) || !/^[a-f\d]{64}$/i.test(checksum[1])) continue
    try {
      const selection = conversationFileSelection(root, file[1])
      const hash = checksum[1].toLowerCase()
      drafts.set(`${selection.path}:${hash}`, { ...selection, hash, reviewDraft: true })
    } catch {
      // Ignore references outside the current project.
    }
  }
  return drafts.size === 1 ? drafts.values().next().value : null
}

export function reviewImagesFromQuestion(root, question) {
  if (!root || !question) return []
  const text = String(question).slice(0, 65536), references = []
  const pattern = /!?\[[^\[\]\r\n]*\]\((?:<([^<>\r\n]+)>|([^()\r\n]+))\)|`([^`\r\n]+)`/gu
  for (const match of text.matchAll(pattern)) {
    let file = match[1] || match[2] || match[3]
    try { if (!match[3]) file = decodeURIComponent(file) } catch { continue }
    if (!/\.[a-z\d]{1,10}$/i.test(file)) continue
    references.push({ file, start: match.index, end: match.index + match[0].length })
    if (references.length >= 200) break
  }
  const images = new Map()
  for (let index = 0; index < references.length && images.size < 24; index++) {
    const reference = references[index]
    if (!/\.(png|jpe?g|webp|gif)$/i.test(reference.file)) continue
    const tail = text.slice(reference.end, references[index + 1]?.start ?? text.length)
    const checksum = tail.match(/^[\s—–:：;；,-]*(?:(?:草稿\s*)?(?:sha[- ]?256|哈希|校验值)\s*[:：=]?\s*)?(?:`([a-f\d]{64})`|([a-f\d]{64})(?![a-f\d]))/iu)
    if (!checksum) continue
    try {
      const selection = conversationFileSelection(root, reference.file)
      const hash = (checksum[1] || checksum[2]).toLowerCase()
      images.set(`${selection.path}:${hash}`, { ...selection, hash })
    } catch { /* Ignore files outside the selected project. */ }
  }
  return [...images.values()]
}

export function reviewImagesFromInteraction(root, interaction) {
  const images = new Map()
  for (const question of interaction?.questions || []) {
    const parts = [question.question, question.detail, ...(question.options || []).flatMap(option => [option.label, option.description])]
    for (const part of parts) for (const image of reviewImagesFromQuestion(root, part)) {
      if (images.size >= 24) return [...images.values()]
      images.set(`${image.path}:${image.hash}`, image)
    }
  }
  return [...images.values()]
}
