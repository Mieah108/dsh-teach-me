import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { commitLesson, precheckCommit } from '../../lib/archive/commit.js'
import { describeError, IdempotencyConflictError, ValidationError } from '../../lib/archive/errors.js'
import { recordSubmission, registerQuestion } from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import { verdictViewOf } from '../../lib/archive/state.js'

/* C 组：一次 commit 完成 发布 + 登记 + 幂等记录（v0.6.3-C 规格 §4 九行矩阵）。 */

const HTML = '<!doctype html><html><body><div class="quiz" data-question-id="q1">题</div></body></html>'

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-commit-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML)
  return ws
}

function commitInput(extra = {}) {
  return {
    lessonId: 'l1',
    path: 'lessons/one.html',
    idempotencyKey: 'commit-k1',
    questions: [{ questionId: 'q1', lessonId: 'l1', type: 'short', prompt: '这道题问什么？', answer: '答案' }],
    ...extra
  }
}

function journalOf(ws) {
  const archive = openArchive(ws, { create: false })
  return { archive, revision: archive.state.revision, lastSeq: archive.state.lastSeq }
}

test('dryRun：只预检，不建档案、不写 journal、不推进 revision', () => {
  const ws = workspace()
  const result = commitLesson(ws, { ...commitInput(), dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.committed, false)
  assert.equal(result.lessonRevision, 0)
  assert.deepEqual(result.questionIds, ['q1'])
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false, '演练不能在磁盘上留下档案目录')

  // 已有档案后再演练：journal 与 revision 都不动。
  const committed = commitLesson(ws, commitInput())
  const before = journalOf(ws)
  const dry = commitLesson(ws, { ...commitInput(), dryRun: true })
  const after = journalOf(ws)
  assert.equal(dry.dryRun, true)
  assert.equal(dry.idempotent, true, '同 key 同内容演练要如实说「正式执行会命中」')
  assert.equal(after.lastSeq, before.lastSeq)
  assert.equal(after.revision, before.revision)
  assert.equal(committed.lessonRevision, 1)
})

test('正常提交：一次事务完成发布 + 登记 + 幂等记录', () => {
  const ws = workspace()
  const result = commitLesson(ws, commitInput())
  assert.equal(result.ok, true)
  assert.equal(result.step, 'commit')
  assert.equal(result.committed, true)
  assert.equal(result.idempotent, false)
  assert.equal(result.lessonRevision, 1)
  assert.deepEqual(result.questionIds, ['q1'])
  assert.deepEqual(result.open, { path: 'lessons/one.html', lessonId: 'l1' })

  const archive = openArchive(ws, { create: false })
  assert.equal(archive.state.lessons.l1.revision, 1)
  assert.equal(archive.state.questions.q1.revision, 1)
  assert.equal(archive.state.idempotency['commit-k1'].kind, 'commit')
  assert.equal(archive.state.idempotency['commit-k1'].result.lessonRevision, 1)
  // workspace.initialized + 一条 commit 行
  assert.equal(archive.state.lastSeq, 2)
})

test('矩阵 5/7：发布成功后崩溃 → 同 key 同内容重试幂等，不新增 journal 行', () => {
  const ws = workspace()
  commitLesson(ws, commitInput())
  const before = journalOf(ws)
  const retry = commitLesson(ws, commitInput())
  const after = journalOf(ws)
  assert.equal(retry.ok, true)
  assert.equal(retry.step, 'idempotent')
  assert.equal(retry.idempotent, true)
  assert.equal(retry.committed, false)
  assert.equal(retry.lessonRevision, 1)
  assert.equal(after.lastSeq, before.lastSeq, '幂等命中不能写 journal')
  assert.equal(after.revision, before.revision)
})

test('矩阵 6：登记成功后崩溃 → 重试不推进 questionRevision，历史 passed 不变 stale', () => {
  const ws = workspace()
  commitLesson(ws, commitInput())
  const graded = recordSubmission(ws, { questionId: 'q1', rawAnswer: '答案' })
  assert.equal(graded.verdict, 'passed')
  const before = openArchive(ws, { create: false }).state
  assert.equal(verdictViewOf(before, before.submissions[graded.submissionId]).effectiveVerdict, 'passed')

  commitLesson(ws, commitInput())
  const after = openArchive(ws, { create: false }).state
  assert.equal(after.questions.q1.revision, 1, '重试不能推进题目 revision')
  const view = verdictViewOf(after, after.submissions[graded.submissionId])
  assert.equal(view.stale, false)
  assert.equal(view.effectiveVerdict, 'passed')
})

test('矩阵 8：同 key 异 hash → idempotency-conflict，可恢复性如实', () => {
  const ws = workspace()
  commitLesson(ws, commitInput())
  assert.throws(
    () => commitLesson(ws, commitInput({ questions: [{ questionId: 'q1', lessonId: 'l1', type: 'short', prompt: '换了个问法？', answer: '答案' }] })),
    (error) => {
      assert.ok(error instanceof IdempotencyConflictError)
      const plan = describeError(error)
      assert.equal(plan.code, 'idempotency-conflict')
      assert.equal(plan.recoverable, false)
      assert.equal(plan.nextAction, 'use-new-key')
      return true
    }
  )
})

test('矩阵 9：并发同课提交（陈旧预检）→ 幂等去重，不产生重复事件', () => {
  const ws = workspace()
  const stale = precheckCommit(ws, commitInput())
  const winner = commitLesson(ws, commitInput())
  assert.equal(winner.committed, true)
  const before = journalOf(ws)
  const second = commitLesson(ws, commitInput(), { precheck: stale })
  const after = journalOf(ws)
  assert.equal(second.idempotent, true)
  assert.equal(second.committed, false)
  assert.equal(after.lastSeq, before.lastSeq, '第二方不能追加事件')
  assert.equal(openArchive(ws, { create: false }).state.questions.q1.revision, 1)
})

test('矩阵 9b：并发同 key 不同内容 → 结构化冲突，不覆盖赢家', () => {
  const ws = workspace()
  const other = commitInput({ questions: [{ questionId: 'q1', lessonId: 'l1', type: 'short', prompt: '另一方改的？', answer: '答案' }] })
  // 双方都在档案里还没有这个 key 时预检；赢家先提交，另一方拿自己的陈旧预检执行。
  const staleB = precheckCommit(ws, other)
  commitLesson(ws, commitInput())
  assert.throws(
    () => commitLesson(ws, other, { precheck: staleB }),
    IdempotencyConflictError
  )
  assert.equal(openArchive(ws, { create: false }).state.questions.q1.prompt, '这道题问什么？')
})

test('矩阵 1：预检后改 HTML → content-changed（recoverable + rerun-precheck）', () => {
  const ws = workspace()
  const stale = precheckCommit(ws, commitInput())
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML + '<!-- changed -->')
  assert.throws(
    () => commitLesson(ws, commitInput(), { precheck: stale }),
    (error) => {
      const plan = describeError(error)
      assert.equal(plan.code, 'content-changed')
      assert.equal(plan.recoverable, true)
      assert.equal(plan.nextAction, 'rerun-precheck')
      assert.equal(plan.step, 'publish')
      return true
    }
  )
  // 写路径第一次打开会初始化档案身份（一条 workspace.initialized），但拒绝时不能有课程/幂等记录。
  const state = openArchive(ws, { create: false }).state
  assert.equal(state.lessons.l1, undefined, '拒绝时不能发布课程')
  assert.equal(state.idempotency['commit-k1'], undefined, '拒绝时不能记幂等键')
  assert.equal(state.lastSeq, 1, '拒绝时只有初始化那一行，没有半条提交')
})

test('矩阵 2：预检后改资产 → assets-changed', () => {
  const ws = workspace()
  fs.writeFileSync(path.join(ws, 'lessons', 'app.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML.replace('</body>', '<script src="app.js"></script></body>'))
  const stale = precheckCommit(ws, commitInput())
  fs.writeFileSync(path.join(ws, 'lessons', 'app.js'), 'console.log(2)\n')
  assert.throws(
    () => commitLesson(ws, commitInput(), { precheck: stale }),
    (error) => describeError(error).code === 'assets-changed'
  )
})

test('矩阵 3：预检后改题目 → question-revision-changed', () => {
  const ws = workspace()
  commitLesson(ws, commitInput())
  const next = commitInput({ idempotencyKey: 'commit-k2', questions: [{ questionId: 'q1', lessonId: 'l1', type: 'short', prompt: '新问法？', answer: '答案' }] })
  const stale = precheckCommit(ws, next)
  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'short', prompt: '旁人改的？', answer: '答案' })
  assert.throws(
    () => commitLesson(ws, next, { precheck: stale }),
    (error) => {
      const plan = describeError(error)
      assert.equal(plan.code, 'question-revision-changed')
      assert.equal(plan.step, 'register')
      assert.equal(plan.recoverable, true)
      return true
    }
  )
  assert.equal(openArchive(ws, { create: false }).state.questions.q1.revision, 2, '拒绝时不能再推进 revision')
})

test('矩阵 4：无关会话写入 archive 后提交，不报冲突', () => {
  const ws = workspace()
  commitLesson(ws, commitInput())
  const archive = openArchive(ws, { create: false })
  archive.transact('other-session', undefined, () => ({
    changes: [{ type: 'self_report.recorded', data: { id: 'sr-1', claim: '离线自测过了' } }],
    result: {}
  }))
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML + '<!-- 改一版 -->')
  const result = commitLesson(ws, commitInput({ idempotencyKey: 'commit-k2' }))
  assert.equal(result.ok, true)
  assert.equal(result.committed, true)
  assert.equal(result.lessonRevision, 2, '内容变了才升课程 revision')
})

test('附：换 key 但题目内容相同 → 不重写题目、revision 不变（A4 根因回归）', () => {
  const ws = workspace()
  commitLesson(ws, commitInput())
  const before = journalOf(ws)
  const second = commitLesson(ws, commitInput({ idempotencyKey: 'another-key' }))
  const after = journalOf(ws)
  assert.equal(second.step, 'commit')
  assert.equal(second.committed, true)
  assert.equal(after.revision, before.revision + 1, '新 key 只追加一条 commit.recorded')
  const archive = after.archive
  assert.equal(archive.state.questions.q1.revision, 1, '内容没变的题不升 revision')
  assert.equal(archive.state.lessons.l1.revision, 1)
  assert.deepEqual(Object.keys(archive.state.idempotency).sort(), ['another-key', 'commit-k1'])
})

test('参数与校验：idempotencyKey 必填、重复题目 id 拒绝、题目参数复用 register 规则', () => {
  const ws = workspace()
  assert.throws(() => commitLesson(ws, commitInput({ idempotencyKey: '' })), ValidationError)
  assert.throws(() => commitLesson(ws, commitInput({ idempotencyKey: 'x'.repeat(501) })), ValidationError)
  assert.throws(
    () =>
      commitLesson(
        ws,
        commitInput({
          questions: [
            { questionId: 'q1', lessonId: 'l1', type: 'short', prompt: '问？', answer: '答' },
            { questionId: 'q1', lessonId: 'l1', type: 'short', prompt: '又问？', answer: '答' }
          ]
        })
      ),
    (error) => error instanceof ValidationError && /重复的题目 id/.test(error.message)
  )
  assert.throws(
    () => commitLesson(ws, commitInput({ questions: [{ questionId: 'q2', lessonId: 'l1', type: 'choice', prompt: '选？' }] })),
    (error) => error instanceof ValidationError && /标准答案/.test(error.message)
  )
})
