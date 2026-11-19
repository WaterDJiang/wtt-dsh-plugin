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

export function reviewMediaFromQuestion(root, question) {
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
  const media = new Map()
  for (let index = 0; index < references.length && media.size < 24; index++) {
    const reference = references[index]
    const kind = /\.(mp4|webm)$/i.test(reference.file) ? 'video'
      : /\.(png|jpe?g|webp|gif)$/i.test(reference.file) ? 'image' : null
    if (!kind) continue
    const tail = text.slice(reference.end, references[index + 1]?.start ?? text.length)
    const checksum = tail.match(/^[\s—–:：;；,-]*(?:(?:草稿\s*)?(?:sha[- ]?256|哈希|校验值)\s*[:：=]?\s*)?(?:`([a-f\d]{64})`|([a-f\d]{64})(?![a-f\d]))/iu)
    if (!checksum) continue
    try {
      const selection = conversationFileSelection(root, reference.file)
      const hash = (checksum[1] || checksum[2]).toLowerCase()
      media.set(`${selection.path}:${hash}`, { ...selection, hash, kind })
    } catch { /* Ignore files outside the selected project. */ }
  }
  return [...media.values()]
}

export function reviewMediaFromInteraction(root, interaction) {
  const media = new Map()
  for (const question of interaction?.questions || []) {
    const parts = [question.question, question.detail, ...(question.options || []).flatMap(option => [option.label, option.description])]
    for (const part of parts) for (const candidate of reviewMediaFromQuestion(root, part)) {
      if (media.size >= 24) return [...media.values()]
      media.set(`${candidate.path}:${candidate.hash}`, candidate)
    }
  }
  return [...media.values()]
}

export function reviewMediaForActiveQuestion(root, active, interaction) {
  if (!active?.questionId) return []
  // Use the live request only when it matches the native question currently shown.
  if (active.callKey && active.callKey === interaction?.key) {
    const prefix = `question-${active.callKey}-`
    if (active.questionId.startsWith(prefix)) {
      const index = active.questionId.slice(prefix.length)
      const question = /^\d+$/.test(index) && interaction.questions?.[Number(index)]
      if (question?.question === active.text) return reviewMediaFromInteraction(root, { questions: [question] })
    }
  }
  return reviewMediaFromQuestion(root, active.text)
}
