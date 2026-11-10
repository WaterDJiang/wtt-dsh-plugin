import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationFileSelection, nativeConversationFilePath, reviewDraftFromQuestion } from '../src/conversation-file.mjs'

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
