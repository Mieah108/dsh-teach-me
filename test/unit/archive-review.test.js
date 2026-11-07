import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { IdempotencyConflictError, ValidationError } from '../../lib/archive/errors.js'
import {
  archiveStatus,
  finishReview,
  listDueReviews,
  publishLesson,
  recordDeferral,
  recordSelfReport,
  recordSubmission,
  registerQuestion,
  scheduleReview
} from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import { archiveStatusFor, registerArchiveTools } from '../../lib/archive/tools.js'

const HTML = '<html><body>课程</body></html>'

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-review-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML)
  return ws
}

function publish(ws) {
  return publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
}

function choiceQuestion(ws, extra = {}) {
  publish(ws)
  return registerQuestion(ws, {
    questionId: 'q1',
    lessonId: 'l1',
    type: 'choice',
    prompt: '选一个',
    options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
    answer: 'b',
    ...extra
  })
}

function fakeCtx(workspaceDir, { llm, selection } = {}) {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (tool) => { registered.push(tool); return () => {} } }
      if (name === 'workingDirectory') return { get: () => workspaceDir }
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return { currentSelection: () => selection }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    }
  }
  return { ctx, registered }
}

const AGENT = { id: 'agent-1', session: { id: 'session-1' } }

test('到期队列只读：没建档时不创建目录，档案建好后不改日志', () => {
  const empty = workspace()
  const before = listDueReviews(empty)
  assert.equal(before.initialized, false)
  assert.deepEqual(before.due, [])
  assert.equal(before.nextDueAt, null)
  assert.ok(!fs.existsSync(path.join(empty, '.dsh-teach-me', 'archive')), '只读读取不能创建 .dsh-teach-me')

  const ws = workspace()
  choiceQuestion(ws)
  scheduleReview(ws, { questionId: 'q1', dueAt: '2020-01-01T00:00:00.000Z' })
  const archive = openArchive(ws)
  const journalFile = path.join(ws, '.dsh-teach-me', 'archive', 'journal', fs.readdirSync(path.join(ws, '.dsh-teach-me', 'archive', 'journal'))[0])
  const journalBefore = fs.readFileSync(journalFile, 'utf8')
  const revisionBefore = archive.state.revision

  const queue = listDueReviews(ws, { now: Date.parse('2020-01-10T00:00:00.000Z') })
  assert.equal(queue.initialized, true)
  assert.equal(queue.dueCount, 1)
  assert.equal(fs.readFileSync(journalFile, 'utf8'), journalBefore, '只读队列不能追加日志')
  assert.equal(openArchive(ws).state.revision, revisionBefore, '只读队列不能推进 revision')
})

test('索引缺失时到期队列只读日志，不补写索引（纯读不写盘）', () => {
  const ws = workspace()
  choiceQuestion(ws)
  const review = scheduleReview(ws, { questionId: 'q1', dueAt: '2020-01-01T00:00:00.000Z' })
  const indexFile = path.join(ws, '.dsh-teach-me', 'archive', 'index.json')
  fs.rmSync(indexFile, { force: true })

  const queue = listDueReviews(ws, { now: Date.parse('2020-01-02T00:00:00.000Z') })
  assert.equal(queue.dueCount, 1)
  assert.equal(queue.due[0].id, review.reviewId)
  assert.ok(!fs.existsSync(indexFile), '纯读队列不能顺手重建索引')

  // 诊断同样只读，显式维护或下一次写入再修复索引
  const status = archiveStatus(ws)
  assert.equal(status.summary.lessons, 1)
  assert.ok(!fs.existsSync(indexFile), '诊断不应产生文件写入')
})

test('到期队列带题目状态与逾期天数；未来项只出现在 nextDueAt', () => {
  const ws = workspace()
  choiceQuestion(ws)
  const overdue = scheduleReview(ws, { questionId: 'q1', dueAt: '2020-01-01T00:00:00.000Z' })
  const future = scheduleReview(ws, { objectiveId: 'obj-1', dueAt: '2030-05-01T00:00:00.000Z' })
  const now = Date.parse('2020-01-10T06:00:00.000Z')
  const queue = listDueReviews(ws, { now })

  assert.equal(queue.due.length, 1)
  const item = queue.due[0]
  assert.equal(item.id, overdue.reviewId)
  assert.equal(item.questionId, 'q1')
  assert.equal(item.objectiveId, null)
  assert.equal(item.dueAt, '2020-01-01T00:00:00.000Z')
  assert.equal(item.intervalDays, 1)
  assert.equal(item.overdueDays, 9)
  assert.equal(item.questionStatus, 'active')
  assert.equal(item.questionType, 'choice')
  assert.equal(item.questionRevision, 1)
  assert.equal(queue.nextDueAt, future.dueAt)
  assert.equal(queue.now, '2020-01-10T06:00:00.000Z')
})

test('跳过的复习不再出现在队列里；跳过不产生通过', () => {
  const ws = workspace()
  choiceQuestion(ws)
  const review = scheduleReview(ws, { questionId: 'q1', dueAt: '2020-01-01T00:00:00.000Z' })
  assert.equal(listDueReviews(ws).due.length, 1)
  finishReview(ws, { reviewId: review.reviewId, result: 'skipped' })
  assert.equal(listDueReviews(ws).due.length, 0)
  assert.equal(openArchive(ws).state.reviews[review.reviewId].state, 'skipped')
  assert.equal(archiveStatus(ws).summary.passed, 0)
  assert.throws(() => finishReview(ws, { reviewId: review.reviewId, result: 'passed' }), ValidationError)
})

test('自报与暂缓各自独立记录：都不产生 passed，也不改已有评估', () => {
  const ws = workspace()
  choiceQuestion(ws)
  const passed = recordSubmission(ws, { questionId: 'q1', rawAnswer: 'b', source: 'chat' })
  assert.equal(passed.verdict, 'passed')
  const assessmentCount = Object.keys(openArchive(ws).state.assessments).length

  const report = recordSelfReport(ws, { id: 'sr-1', claim: '这题我会了', questionId: 'q1' })
  assert.equal(report.idempotent, false)
  const again = recordSelfReport(ws, { id: 'sr-1', claim: '这题我会了', questionId: 'q1' })
  assert.equal(again.idempotent, true)
  assert.throws(() => recordSelfReport(ws, { id: 'sr-1', claim: '改口了' }), IdempotencyConflictError)

  const deferral = recordDeferral(ws, { questionId: 'q1', reason: '今天先不复习', until: '2026-11-01' })
  assert.equal(deferral.until, '2026-11-01T00:00:00.000Z')
  const deferAgain = recordDeferral(ws, { id: deferral.deferralId, questionId: 'q1', reason: '今天先不复习', until: '2026-11-01' })
  assert.equal(deferAgain.idempotent, true)
  assert.throws(() => recordDeferral(ws, { questionId: 'nope', reason: 'x' }), ValidationError)
  assert.throws(() => recordDeferral(ws, { reason: '没有关联对象' }), ValidationError)
  assert.throws(() => recordDeferral(ws, { questionId: 'q1', until: '不是时间' }), ValidationError)

  const state = openArchive(ws).state
  assert.equal(Object.keys(state.assessments).length, assessmentCount, '自报/暂缓不能新增评估')
  assert.equal(Object.keys(state.selfReports).length, 1)
  assert.equal(Object.keys(state.deferrals).length, 1)
  const status = archiveStatus(ws)
  assert.equal(status.summary.passed, 1)
  assert.equal(status.summary.selfReports, 1)
  assert.equal(status.summary.deferrals, 1)
})

test('档案段列出到期复习的 id 与 dueAt、下一次到期，并说清自报/暂缓不是通过', () => {
  const ws = workspace()
  choiceQuestion(ws)
  const due = scheduleReview(ws, { questionId: 'q1', dueAt: '2020-01-01T00:00:00.000Z' })
  const next = scheduleReview(ws, { objectiveId: 'obj-2', dueAt: '2030-05-01T00:00:00.000Z' })
  recordSelfReport(ws, { id: 'sr-2', claim: '自测全对', questionId: 'q1' })
  recordDeferral(ws, { questionId: 'q1', reason: '先放一放' })

  const status = archiveStatus(ws)
  assert.equal(status.dueReviews[0].id, due.reviewId)
  assert.equal(status.dueReviews[0].dueAt, '2020-01-01T00:00:00.000Z')
  assert.equal(status.nextDueAt, next.dueAt)

  const section = archiveStatusFor(ws)
  assert.match(section.text, /到期复习 1 条/)
  assert.ok(section.text.includes(due.reviewId), '要列出到期复习 id')
  assert.ok(section.text.includes('2020-01-01T00:00:00.000Z'), '要列出 dueAt')
  assert.match(section.text, /自报与暂缓都不是通过/)
  assert.ok(section.text.includes('下一次到期：' + next.dueAt))
})

test('teach_review 的 due 动作只读返回到期队列与下一次到期', async () => {
  const ws = workspace()
  choiceQuestion(ws)
  const due = scheduleReview(ws, { questionId: 'q1', dueAt: '2020-01-01T00:00:00.000Z' })
  const next = scheduleReview(ws, { objectiveId: 'obj-3', dueAt: '2030-05-01T00:00:00.000Z' })
  const { ctx, registered } = fakeCtx(ws)
  registerArchiveTools(ctx, {}, () => ws)
  const review = registered.find((tool) => tool.name === 'teach_review')
  assert.ok(review.parameters.properties.action.enum.includes('due'))

  const result = await review.execute({ action: 'due' }, { agent: AGENT })
  assert.equal(result.ok, true)
  assert.equal(result.dueCount, 1)
  assert.equal(result.dueReviews[0].id, due.reviewId)
  assert.equal(result.nextDueAt, next.dueAt)
  assert.ok(result.text.includes(due.reviewId))
  assert.match(result.text, /跳过不算掌握/)

  const bad = await review.execute({ action: 'bogus' }, { agent: AGENT })
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'bad-action')
})

test('没建档时 teach_review due 只读返回空队列，不创建 .dsh-teach-me', async () => {
  const ws = workspace()
  const { ctx, registered } = fakeCtx(ws)
  registerArchiveTools(ctx, {}, () => ws)
  const review = registered.find((tool) => tool.name === 'teach_review')
  const result = await review.execute({ action: 'due' }, { agent: AGENT })
  assert.equal(result.ok, true)
  assert.equal(result.initialized, false)
  assert.match(result.text, /档案还没建立/)
  assert.ok(!fs.existsSync(path.join(ws, '.dsh-teach-me', 'archive')))
})

test('teach_self_report / teach_defer 工具注册且文案说明不产生通过', async () => {
  const ws = workspace()
  choiceQuestion(ws)
  const { ctx, registered } = fakeCtx(ws)
  registerArchiveTools(ctx, {}, () => ws)
  const names = registered.map((tool) => tool.name).sort()
  assert.deepEqual(names, [
    'teach_assessment_void',
    'teach_commit',
    'teach_defer',
    'teach_evaluate',
    'teach_grade_open',
    'teach_lesson_publish',
    'teach_material_index',
    'teach_question_register',
    'teach_review',
    'teach_self_report',
    'teach_submission_record'
  ])

  const report = registered.find((tool) => tool.name === 'teach_self_report')
  const reported = await report.execute({ id: 'sr-3', claim: '我觉得我会了', questionId: 'q1' }, { agent: AGENT })
  assert.equal(reported.ok, true)
  assert.match(reported.text, /不是评估通过/)
  assert.equal(openArchive(ws).state.assessments && Object.keys(openArchive(ws).state.assessments).length, 0)

  const defer = registered.find((tool) => tool.name === 'teach_defer')
  const deferred = await defer.execute({ questionId: 'q1', reason: '下周再说', until: '2026-12-01' }, { agent: AGENT })
  assert.equal(deferred.ok, true)
  assert.equal(deferred.until, '2026-12-01T00:00:00.000Z')
  assert.match(deferred.text, /暂缓不是通过/)
  assert.equal(archiveStatus(ws).summary.passed, 0)

  const blind = fakeCtx(undefined)
  registerArchiveTools(blind.ctx, {}, () => {
    throw new Error('工作区未知')
  })
  const failed = await blind.registered.find((tool) => tool.name === 'teach_self_report').execute({ id: 'sr-4', claim: 'x' }, { agent: AGENT })
  assert.equal(failed.ok, false)
})
