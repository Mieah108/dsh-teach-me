import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readLearningContext, projectLearningContext, formatLearningContext } from '../../lib/archive/context.js'
import { publishLesson, readArchiveState, rebuildArchive, recordSubmission, registerQuestion, scheduleReview, voidAssessment } from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import { readJournal } from '../../lib/archive/journal.js'

const NOW = Date.parse('2026-10-29T00:00:00Z')
const opts = { now: NOW, runId: 'run-1' }
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-context-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lessons'))
  fs.writeFileSync(path.join(root, 'lessons/one.html'), '<html>one</html>')
  return root
}
const args = { lessonId: 'l1', path: 'lessons/one.html', mission: '学会核验', objectives: ['o1'], objectiveDefinitions: [{ id: 'o1', title: '判断证据' }] }
function pass(root, id) {
  registerQuestion(root, { lessonId: 'l1', questionId: id, type: 'short', prompt: '证据', answer: '正确' })
  return recordSubmission(root, { questionId: id, rawAnswer: '正确', source: 'chat' })
}

test('F4无档案不建档，旧课无定义正常降级，显式课程与工作区范围清楚', (t) => {
  const root = workspace(t)
  assert.equal(readLearningContext(root, opts), null)
  assert.equal(fs.existsSync(path.join(root, '.dsh-teach-me')), false)
  publishLesson(root, { lessonId: 'l1', path: 'lessons/one.html' })
  const old = readLearningContext(root, opts)
  assert.equal(old.scope, 'workspace')
  assert.deepEqual(old.objectives, [])
  assert.equal(old.mission, null)
  assert.equal(readLearningContext(root, { ...opts, lessonId: 'l1' }).scope, 'l1')
  assert.throws(() => readLearningContext(root, { lessonId: 'missing' }), { code: 'validation' })
})

test('F4来源来自同一重放快照，删index读不写，rebuild复现同投影', (t) => {
  const root = workspace(t)
  publishLesson(root, args)
  pass(root, 'q1')
  const before = readLearningContext(root, opts)
  assert.deepEqual(before.mission.source, { seq: 2, changeIndex: 0 })
  assert.deepEqual(before.objectives[0].source, { seq: 2, changeIndex: 1 })
  const archive = openArchive(root)
  const index = path.join(archive.path, 'index.json')
  const frozen = projectLearningContext(archive.state, archive.journalEntries, opts)
  publishLesson(root, { ...args, mission: '已变化' })
  assert.deepEqual(projectLearningContext(archive.state, archive.journalEntries, opts), frozen)
  // 用最新真值验证缺index与显式重建一致。
  const latest = readLearningContext(root, opts)
  fs.unlinkSync(index)
  assert.deepEqual(readLearningContext(root, opts), latest)
  assert.equal(fs.existsSync(index), false)
  rebuildArchive(root)
  assert.deepEqual(readLearningContext(root, opts), latest)
  const source = latest.conclusions[0].source
  const change = readJournal(archive.path).entries.find(e => e.seq === source.seq).changes[source.changeIndex]
  assert.equal(change.type, 'assessment.recorded')
  assert.equal(change.data.id, latest.conclusions[0].assessmentId)
})

test('F4只取最近5条有效结论，作废与课程改版会排除', (t) => {
  const root = workspace(t)
  publishLesson(root, args)
  for (let i=0;i<7;i++) pass(root, 'q'+i)
  const view = readLearningContext(root, opts)
  assert.equal(view.conclusions.length, 5)
  assert.equal(view.conclusions[0].questionId, 'q6')
  voidAssessment(root, { assessmentId: view.conclusions[0].assessmentId, reason: '纠正' })
  assert.equal(readLearningContext(root, opts).conclusions[0].questionId, 'q5')
  fs.appendFileSync(path.join(root, 'lessons/one.html'), '<!--new-->')
  publishLesson(root, args)
  assert.deepEqual(readLearningContext(root, opts).conclusions, [])
})

test('F4固定now可复现，到期变化遵循时间，不改磁盘', (t) => {
  const root = workspace(t)
  publishLesson(root, args)
  scheduleReview(root, { objectiveId: 'o1', dueAt: '2026-10-29T01:00:00Z' })
  const before = fs.readFileSync(path.join(openArchive(root).path, 'index.json'))
  assert.equal(readLearningContext(root, opts).dueCount, 0)
  assert.equal(readLearningContext(root, { ...opts, now: NOW + 3600000 }).dueCount, 1)
  assert.deepEqual(readLearningContext(root, opts), readLearningContext(root, opts))
  assert.deepEqual(fs.readFileSync(path.join(openArchive(root).path, 'index.json')), before)
})

test('F4两个工作区不串目标，文本带来源且不刷零待批改', (t) => {
  const a = workspace(t), b = workspace(t)
  publishLesson(a, args)
  publishLesson(b, { lessonId: 'l1', path: 'lessons/one.html', mission: '另一工作区' })
  assert.equal(readLearningContext(a, opts).mission.text, '学会核验')
  const text = formatLearningContext(readLearningContext(b, opts))
  assert.match(text, /另一工作区.*seq 2\/0/)
  assert.doesNotMatch(text, /待批改/)
})
