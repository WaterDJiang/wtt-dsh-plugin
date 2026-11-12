import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationFileSelection, nativeConversationFilePath, reviewDraftFromQuestion, reviewImagesFromQuestion, reviewImagesFromInteraction } from '../src/conversation-file.mjs'

test('card chat opens project-relative and same-project absolute file links', () => {
  const root = '/tmp/项目'
  const path = 'courses/tasks/working/审阅稿 r2.md'
  const selection = { path, name: '审阅稿 r2.md', fromConversation: true }
  assert.deepEqual(conversationFileSelection(root, './' + path), selection)
  assert.deepEqual(conversationFileSelection(root, root + '/' + path), selection)
})

test('card chat rejects paths outside the project and private workbench data', () => {
  const root = '/tmp/项目'
  for (const path of ['../other.md', '/tmp/项目副本/other.md', './.wtt-workbench/cache.md',
    '/tmp/项目/../other.md', '/tmp/项目', '~/other.md', 'https://example.com/doc.md']) {
    assert.throws(() => conversationFileSelection(root, path), /当前项目/)
  }
})

test('DSH tool rows use the full path as button text while Markdown uses title', () => {
  const path = 'courses/tasks/working/审阅稿 r2.md'
  assert.equal(nativeConversationFilePath({ classList: ['o3BgMG_fileLink'], title: '', textContent: path }), path)
  assert.equal(nativeConversationFilePath({ classList: ['_fileMention_1ypvv_85', '_fileLink_1ypvv_59'],
    title: path, textContent: '审阅稿 r2.md' }), path)
  assert.equal(nativeConversationFilePath({ classList: ['other'], title: path, textContent: path }), '')
})

test('the review opens only the explicit draft and pins it to the checksum in the current question', () => {
  const root = '/tmp/项目', hash = 'ab'.repeat(32)
  const path = 'courses/任务/working/分镜 待确认.md'
  const reference = `文件：\`${path}\`；草稿 SHA-256：\`${hash.toUpperCase()}\`。`
  assert.deepEqual(reviewDraftFromQuestion(root, `请审阅。${reference}`), {
    path, name: '分镜 待确认.md', fromConversation: true, hash, reviewDraft: true,
  })
  assert.equal(reviewDraftFromQuestion(root, reference + reference)?.hash, hash)
  for (const question of [
    reference.replace(path, '../其他项目/待确认.md'),
    reference.replace(path, '/tmp/项目副本/待确认.md'),
    reference.replace(path, '.wtt-workbench/内部.md'),
    `文件：\`${path}\`。`,
    reference + reference.replace(path, 'courses/任务/working/另一稿.md'),
  ]) assert.equal(reviewDraftFromQuestion(root, question), null)
})

test('image choices in native plain-text questions retain paths, order and exact SHA-256', () => {
  const root = '/tmp/项目', hash = 'AB'.repeat(32)
  const question = `候选及 SHA-256：\n1. [首张](courses/task/working/a.png) —\n${hash}\n2. ![第二张](<courses/task/working/有 空格.jpg>) SHA-256：\`${hash}\`\n3. \`courses/task/working/第三.webp\`；校验值：${hash}`
  const images = reviewImagesFromQuestion(root, question + '\n' + question)
  assert.deepEqual(images.map(image => image.path), ['courses/task/working/a.png', 'courses/task/working/有 空格.jpg', 'courses/task/working/第三.webp'])
  assert(images.every(image => image.hash === hash.toLowerCase() && image.fromConversation))
  assert.equal(images[1].name, '有 空格.jpg')
  assert.equal(reviewImagesFromQuestion(root, `[a](courses/%E5%9B%BE.png) — ${hash}`)[0].name, '图.png')
})

test('image preview never guesses a hash from a different file, remote link, internal path or prose', () => {
  const root = '/tmp/项目', hash = 'ab'.repeat(32)
  for (const question of [
    `[a](../a.png) — ${hash}`, `[a](/tmp/别的项目/a.png) — ${hash}`,
    `[a](https://example.test/a.png) — ${hash}`, `[a](.wtt-workbench/a.png) — ${hash}`,
    `[a](%2e%2e/a.png) — ${hash}`, `[a](courses/a.svg) — ${hash}`, '[a](courses/a.png)',
    `[a](courses/a.png)\n[b](courses/b.md) — ${hash}`, `[a](courses/a.png) 请对比后使用 ${hash}`,
    `[a](courses/a.png) — ${hash}0`, `[a](courses/a.png) — \`${hash}0\``,
  ]) assert.deepEqual(reviewImagesFromQuestion(root, question), [], question)
  assert.deepEqual(reviewImagesFromQuestion(root, null), [])
  const many = Array.from({ length: 30 }, (_, index) => `[${index}](courses/${index}.gif) — ${hash}`).join('\n')
  assert.equal(reviewImagesFromQuestion(root, many).length, 24)
})

test('task reviews include candidates in detail and option descriptions without pairing hashes across fields or questions', () => {
  const root = '/tmp/项目', hash = 'ab'.repeat(32)
  const images = reviewImagesFromInteraction(root, { questions: [
    { question: `对比 [原始](courses/base.png) — ${hash}`, detail: `[候选](courses/candidate.png) SHA256=${hash}`,
      options: [{ label: '第二张', description: `[对照](courses/option.jpg) — ${hash}` }, { label: '保留', description: `[重复](courses/base.png) — ${hash}` }] },
    { question: '[不能猜](courses/no-hash.png)', detail: hash },
    { question: hash },
  ] })
  assert.deepEqual(images.map(image => image.path), ['courses/base.png', 'courses/candidate.png', 'courses/option.jpg'])
  assert.deepEqual(reviewImagesFromInteraction(root, null), [])
})
