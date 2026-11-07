import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishLesson, recordSubmission, registerQuestion, evaluateSubmission } from '../../lib/archive/operations.js'
import { manageCollection } from '../../lib/archive/collections.js'
import { withLearningScope } from '../../lib/archive/learning-scope.js'
import { staleReason } from '../../lib/archive/state.js'
import { openArchive } from '../../lib/archive/store.js'
const setup = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-collections-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lessons'))
  fs.writeFileSync(path.join(root, 'lessons/one.html'), '<html><body><style>body{color:red}</style><main>第一版</main></body></html>')
  publishLesson(root, { lessonId: 'one', path: 'lessons/one.html' })
  registerQuestion(root, { questionId: 'q1', lessonId: 'one', type: 'short', prompt: '题目', answer: 'a' })
  return root
}
test('迁移备份、集合复制不复制证据；正文和题目版本在不同集合隔离', (t) => {
  const root = setup(t)
  recordSubmission(root, { questionId: 'q1', rawAnswer: 'a' })
  manageCollection(root, { action: 'copy', id: 'second', name: '第二次' })
  const old = withLearningScope({ collectionId: 'second' }, () => openArchive(root).state)
  assert.equal(Object.keys(old.submissions).length, 0)
  assert.ok(old.lessons.one.contentVersion)
  assert.ok(fs.readdirSync(path.join(root, '.dsh-teach-me/archive/backups')).some((p) => p.includes('before-learning')))
  fs.writeFileSync(path.join(root, 'lessons/one.html'), '<html><body><main>第二版</main></body></html>')
  publishLesson(root, { lessonId: 'one', path: 'lessons/one.html' })
  const current = openArchive(root).state.lessons.one
  assert.notEqual(current.contentVersion, old.lessons.one.contentVersion)
  withLearningScope({ collectionId: 'second' }, () => {
    const archive = openArchive(root)
    assert.equal(archive.state.lessons.one.contentVersion, old.lessons.one.contentVersion)
    const lesson = archive.state.lessons.one
    assert.match(fs.readFileSync(path.join(root, lesson.artifactRoot, lesson.path), 'utf8'), /第一版/)
    recordSubmission(root, { questionId: 'q1', rawAnswer: 'a' })
    assert.equal(Object.keys(openArchive(root).state.submissions).length, 1)
  })
  assert.equal(Object.keys(openArchive(root).state.submissions).length, 1)
  manageCollection(root, { action: 'adopt', id: 'second', lessonId: 'one' })
  withLearningScope({ collectionId: 'second' }, () => {
    const archive = openArchive(root)
    assert.equal(archive.state.lessons.one.contentVersion, current.contentVersion)
    assert.equal(Object.keys(archive.state.submissions).length, 1)
  })
})
test('只读不迁移，样式改动保持内容版本；归档/恢复与重放一致', (t) => {
  const root = setup(t)
  const before = fs.readFileSync(path.join(root, '.dsh-teach-me/archive/journal', fs.readdirSync(path.join(root, '.dsh-teach-me/archive/journal'))[0]))
  withLearningScope({ enabled: true }, () => openArchive(root, { repairIndex: false }))
  assert.deepEqual(fs.readFileSync(path.join(root, '.dsh-teach-me/archive/journal', fs.readdirSync(path.join(root, '.dsh-teach-me/archive/journal'))[0])), before)
  manageCollection(root, { action: 'create', id: 'empty', name: '新集合' })
  const version = openArchive(root).state.lessons.one.contentVersion
  fs.writeFileSync(path.join(root, 'lessons/one.html'), '<html><body><style>body{color:blue}</style><main>第一版</main></body></html>')
  publishLesson(root, { lessonId: 'one', path: 'lessons/one.html' })
  assert.equal(openArchive(root).state.lessons.one.contentVersion, version)
  manageCollection(root, { action: 'archive', id: 'empty' })
  assert.equal(openArchive(root).globalState.collectionInfo.empty.archived, true)
  manageCollection(root, { action: 'restore', id: 'empty' })
  assert.equal(openArchive(root).globalState.collectionInfo.empty.archived, false)
})

test('采用内容新版保留旧版证据；旧提交按其固定题面评估而不冒充新版通过', (t) => {
  const root = setup(t)
  manageCollection(root, { action: 'rename', id: 'default', name: '首轮' })
  const submitted = recordSubmission(root, { questionId: 'q1', rawAnswer: 'a' })
  const original = openArchive(root).state.submissions[submitted.submissionId]
  fs.writeFileSync(path.join(root, 'lessons/one.html'), '<html><body><main>改过的内容</main></body></html>')
  publishLesson(root, { lessonId: 'one', path: 'lessons/one.html' })
  const graded = evaluateSubmission(root, { submissionId: submitted.submissionId, criteria: [{ id: 'deterministic-answer', met: true, evidence: '原版本标准答案一致' }] })
  const state = openArchive(root).state
  assert.equal(graded.verdict, 'passed')
  assert.match(staleReason(state, state.assessments[graded.assessmentId]), /改版/)
  assert.equal(withLearningScope({ lessonId: 'one', contentVersion: original.contentVersion }, () => staleReason(openArchive(root).state, state.assessments[graded.assessmentId])), '')
})
