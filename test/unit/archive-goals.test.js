import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishLesson, readArchiveState, registerQuestion, recordSubmission } from '../../lib/archive/operations.js'
import { commitLesson, precheckCommit } from '../../lib/archive/commit.js'
import { readJournal } from '../../lib/archive/journal.js'
import { openArchive } from '../../lib/archive/store.js'
import { verdictViewOf } from '../../lib/archive/state.js'
import { hashJson } from '../../lib/archive/util.js'

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-goals-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lessons'))
  fs.writeFileSync(path.join(root, 'lessons/one.html'), '<html><body>course</body></html>')
  return root
}
const input = (extra = {}) => ({ path: 'lessons/one.html', lessonId: 'l1', ...extra })
const goals = { mission: '掌握证据推理', objectives: ['o1'], objectiveDefinitions: [{ id: 'o1', title: '能解释', description: '描述', acceptance: ['给出证据'] }] }
const entries = (root) => readJournal(openArchive(root, { repairIndex: false }).path).entries

test('F2 publish同事务写定义，重复幂等，无参不改使命/定义', (t) => {
  const root = workspace(t)
  publishLesson(root, input(goals))
  const journal = entries(root)
  assert.deepEqual(journal.at(-1).changes.map(c => c.type), ['mission.updated', 'objective.upsert', 'lesson.published'])
  publishLesson(root, input(goals))
  assert.equal(entries(root).length, journal.length)
  publishLesson(root, input({ objectives: ['o1'] }))
  assert.equal(entries(root).length, journal.length)
  assert.equal(readArchiveState(root).mission.text, goals.mission)
})

test('F2只改使命/定义保留课程关联和版本；部分更新保留描述/判据', (t) => {
  const root = workspace(t)
  publishLesson(root, input(goals))
  const result = publishLesson(root, input({ mission: '新的使命', objectiveDefinitions: [{ id: 'o1', title: '新标题' }] }))
  const state = readArchiveState(root)
  assert.equal(result.lessonRevision, 1)
  assert.equal(state.mission.revision, 2)
  assert.deepEqual(state.lessons.l1.objectives, ['o1'])
  assert.equal(state.objectives.o1.description, '描述')
  assert.deepEqual(state.objectives.o1.acceptance, ['给出证据'])
  assert.deepEqual(entries(root).at(-1).changes.map(c => c.type), ['mission.updated', 'objective.upsert'])
  const dry = publishLesson(root, input({ mission: '演练变更', dryRun: true }))
  assert.equal(dry.idempotent, false)
  assert.equal(dry.nextRevision, 1, '只改使命不提升课程revision')
})

test('F2 dryRun未建档案；缺索引演练不补写；坏定义原子拒绝', (t) => {
  const root = workspace(t)
  publishLesson(root, input({ ...goals, dryRun: true }))
  assert.equal(fs.existsSync(path.join(root, '.dsh-teach-me')), false)
  assert.throws(() => publishLesson(root, input({ mission: 'x', objectiveDefinitions: [{ id: 'bad', title: '坏' }] })), { code: 'validation' })
  assert.equal(fs.existsSync(path.join(root, '.dsh-teach-me')), false)
  publishLesson(root, input(goals))
  const index = path.join(openArchive(root).path, 'index.json')
  fs.unlinkSync(index)
  publishLesson(root, input({ ...goals, dryRun: true }))
  assert.equal(fs.existsSync(index), false)
})

test('F2非法使命/定义字段/重复ID/长度拒绝，档案不创建', (t) => {
  const root = workspace(t)
  for (const extra of [{ mission: '' }, { mission: 'x'.repeat(201) }, { objectiveDefinitions: [{}] }, { objectiveDefinitions: [{ id: 'o1', title: 'x', text: 'z' }] }, { objectiveDefinitions: [{ id: 'o1', title: 'x' }, { id: 'o1', title: 'y' }] }]) {
    assert.throws(() => publishLesson(root, input({ objectives: ['o1'], ...extra })), { code: 'validation' })
  }
  assert.equal(fs.existsSync(path.join(root, '.dsh-teach-me')), false)
})

test('F2 commit哈希覆盖定义，同key异定义冲突，重试不追加', (t) => {
  const root = workspace(t)
  const args = input({ ...goals, idempotencyKey: 'k' })
  commitLesson(root, args)
  const count = entries(root).length
  assert.equal(commitLesson(root, args).idempotent, true)
  assert.equal(entries(root).length, count)
  assert.throws(() => commitLesson(root, { ...args, mission: '另一个使命' }), { code: 'idempotency-conflict' })
  commitLesson(root, input({ mission: '另一个使命', idempotencyKey: 'k2' }))
  assert.equal(readArchiveState(root).lessons.l1.revision, 1)
})

test('F2旧commit请求hash逐字兼容，定义排序不影响hash', (t) => {
  const root = workspace(t)
  const args = input({ idempotencyKey: 'legacy' })
  const pre = precheckCommit(root, args)
  assert.equal(pre.requestHash, hashJson({ lessonId: 'l1', title: 'l1', path: 'lessons/one.html', fingerprint: pre.plan.fingerprint, objectives: [], questions: [] }))
  commitLesson(root, args)
  assert.equal(commitLesson(root, args).idempotent, true)
  const a = { objectives: ['o1','o2'], objectiveDefinitions: [{id:'o1',title:'a'}, {id:'o2',title:'b'}], idempotencyKey: 'sort' }
  const first = precheckCommit(root, input(a))
  const second = precheckCommit(root, input({ ...a, objectiveDefinitions: a.objectiveDefinitions.toReversed() }))
  assert.equal(first.requestHash, second.requestHash)
})

test('F2目标内容更新不让已通过的评估失效', (t) => {
  const root = workspace(t)
  publishLesson(root, input(goals))
  registerQuestion(root, { lessonId: 'l1', questionId: 'q1', type: 'short', prompt: '答', answer: '对' })
  const answer = recordSubmission(root, { questionId: 'q1', rawAnswer: '对', source: 'chat' })
  let state = readArchiveState(root)
  assert.equal(verdictViewOf(state, state.submissions[answer.submissionId]).effectiveVerdict, 'passed')
  publishLesson(root, input({ objectiveDefinitions: [{ id: 'o1', title: '另一个标题' }] }))
  state = readArchiveState(root)
  assert.equal(verdictViewOf(state, state.submissions[answer.submissionId]).effectiveVerdict, 'passed')
})

test('F2 commit预检后课程关联变化不会被旧计划覆盖', (t) => {
  const root = workspace(t)
  publishLesson(root, input(goals))
  const args = input({ mission: '待提交', idempotencyKey: 'race' })
  const precheck = precheckCommit(root, args)
  publishLesson(root, input({ objectives: ['o2'] }))
  assert.throws(() => commitLesson(root, args, { precheck }), { code: 'content-changed' })
  assert.deepEqual(readArchiveState(root).lessons.l1.objectives, ['o2'])
})
