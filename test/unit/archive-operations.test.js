import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  archiveStatus,
  evaluateSubmission,
  finishReview,
  indexMaterial,
  publishLesson,
  rebuildArchive,
  resolvePublish,
  recordSubmission,
  registerQuestion,
  scheduleReview,
  voidAssessment
} from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import { IdempotencyConflictError, ValidationError } from '../../lib/archive/errors.js'

const HTML = '<html><head><link rel="stylesheet" href="../assets/course.css"></head><body><script src="../assets/course.js"></script>课程</body></html>'

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-ops-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML)
  fs.writeFileSync(path.join(ws, 'assets', 'course.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(ws, 'assets', 'course.css'), 'body{}\n')
  return ws
}

function publish(ws, extra = {}) {
  return publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html', ...extra })
}

function question(ws, extra = {}) {
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

test('发布课程：真实资源清单、同内容幂等、改内容升 revision', () => {
  const ws = workspace()
  const first = publish(ws)
  assert.equal(first.idempotent, false)
  assert.equal(first.lessonRevision, 1)
  assert.equal(first.path, 'lessons/one.html')
  assert.deepEqual(first.assets.map((item) => item.path), ['assets/course.css', 'assets/course.js'])
  assert.equal(first.assets[1].size, 15)

  const again = publish(ws)
  assert.equal(again.idempotent, true)
  assert.equal(again.lessonRevision, 1)

  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML + '<!-- changed -->')
  const changed = publish(ws)
  assert.equal(changed.idempotent, false)
  assert.equal(changed.lessonRevision, 2)
  assert.notEqual(changed.fingerprint, first.fingerprint)
  assert.equal(openArchive(ws).state.lessons.l1.revision, 2)
})

test('发布课程拒绝工作区外文件和非 HTML', () => {
  const ws = workspace()
  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teach-out-')), 'x.html')
  fs.writeFileSync(outside, '<html></html>')
  assert.throws(() => publishLesson(ws, { lessonId: 'l1', path: outside }), ValidationError)
  fs.writeFileSync(path.join(ws, 'lessons', 'one.txt'), 'text')
  assert.throws(() => publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.txt' }), ValidationError)
})

test('题目必须属于已发布课程；确定性题型必须有标准答案；改题递增 revision', () => {
  const ws = workspace()
  publish(ws)
  assert.throws(
    () => registerQuestion(ws, { questionId: 'q0', lessonId: 'missing', type: 'choice', prompt: 'x', answer: 'a' }),
    ValidationError
  )
  assert.throws(
    () => registerQuestion(ws, { questionId: 'q0', lessonId: 'l1', type: 'numeric', prompt: '1+1' }),
    ValidationError
  )
  const first = registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'numeric', prompt: '1+1', answer: 2 })
  assert.equal(first.questionRevision, 1)
  const second = registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'numeric', prompt: '1+1 等于？', answer: 2 })
  assert.equal(second.questionRevision, 2)
})

test('choice 提交由 host 确定性判分：通过落评估，重复提交幂等', () => {
  const ws = workspace()
  question(ws)
  const first = recordSubmission(ws, { questionId: 'q1', rawAnswer: 'b', source: 'chat' })
  assert.equal(first.verdict, 'passed')
  assert.equal(first.status, 'evaluated')
  assert.match(first.assessmentId, /^as_/)
  const revision = openArchive(ws).state.revision

  const duplicate = recordSubmission(ws, { questionId: 'q1', rawAnswer: 'b', source: 'chat' })
  assert.equal(duplicate.idempotent, true)
  assert.equal(duplicate.submissionId, first.submissionId)
  assert.equal(duplicate.assessmentId, first.assessmentId)
  assert.equal(openArchive(ws).state.revision, revision)
  assert.equal(archiveStatus(ws).summary.submissions, 1)
})

test('同一幂等键配不同答案要报冲突，不能静默覆盖', () => {
  const ws = workspace()
  question(ws)
  recordSubmission(ws, { questionId: 'q1', rawAnswer: 'b', idempotencyKey: 'fixed-key', source: 'chat' })
  assert.throws(
    () => recordSubmission(ws, { questionId: 'q1', rawAnswer: 'a', idempotencyKey: 'fixed-key', source: 'chat' }),
    IdempotencyConflictError
  )
  assert.equal(archiveStatus(ws).summary.submissions, 1)
})

test('错误答案记 needs_practice，不算通过', () => {
  const ws = workspace()
  question(ws)
  const result = recordSubmission(ws, { questionId: 'q1', rawAnswer: 'a', source: 'chat' })
  assert.equal(result.verdict, 'needs_practice')
  assert.equal(result.status, 'evaluated')
  assert.equal(archiveStatus(ws).summary.passed, 0)
})

test('解释题先存原始答案，评估只按逐条标准与证据推导结论', () => {
  const ws = workspace()
  question(ws, { type: 'explanation', prompt: '解释一下', answer: undefined })
  const record = recordSubmission(ws, { questionId: 'q1', rawAnswer: '我的解释', source: 'chat' })
  assert.equal(record.status, 'pending')
  assert.equal(record.assessmentId, null)

  const missing = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'reason', met: true, evidence: '   ' }]
  })
  assert.equal(missing.verdict, 'needs_review')

  const passed = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'reason', met: true, evidence: '说明了因果链' }],
    method: { kind: 'model', model: 'test-model' }
  })
  assert.equal(passed.verdict, 'passed')
  assert.equal(archiveStatus(ws).summary.passed, 1)

  const revised = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'reason', met: false, evidence: '漏了关键步骤' }]
  })
  assert.equal(revised.verdict, 'needs_practice')
  assert.equal(archiveStatus(ws).summary.passed, 0)
})

test('评估不能形成通过的情形：旧题版本、题目作废、材料指纹不一致、没有标准', () => {
  const ws = workspace()
  question(ws, { type: 'explanation', answer: undefined })
  const record = recordSubmission(ws, { questionId: 'q1', rawAnswer: '答案', source: 'chat' })

  assert.equal(evaluateSubmission(ws, { submissionId: record.submissionId }).verdict, 'needs_review')

  assert.equal(
    evaluateSubmission(ws, {
      submissionId: record.submissionId,
      criteria: [{ id: 'c', met: true, evidence: 'e' }],
      materialsFingerprint: 'sha256:something-else'
    }).verdict,
    'needs_review'
  )

  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'explanation', prompt: '改过的题面' })
  assert.equal(
    evaluateSubmission(ws, {
      submissionId: record.submissionId,
      criteria: [{ id: 'c', met: true, evidence: 'e' }]
    }).verdict,
    'needs_review'
  )

  const fresh = recordSubmission(ws, { questionId: 'q1', rawAnswer: '新答案', source: 'chat' })
  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'explanation', prompt: '再改一次', status: 'retired' })
  assert.equal(
    evaluateSubmission(ws, {
      submissionId: fresh.submissionId,
      criteria: [{ id: 'c', met: true, evidence: 'e' }]
    }).verdict,
    'needs_review'
  )
})

test('作废评估保留历史，报告不再把这条算通过', () => {
  const ws = workspace()
  question(ws)
  const record = recordSubmission(ws, { questionId: 'q1', rawAnswer: 'b', source: 'chat' })
  assert.equal(archiveStatus(ws).summary.passed, 1)
  voidAssessment(ws, { assessmentId: record.assessmentId, reason: '题目答案有误，重新评' })
  assert.equal(archiveStatus(ws).summary.passed, 0)
  const state = openArchive(ws).state
  assert.ok(state.assessments[record.assessmentId].voidedAt)
  assert.equal(state.assessments[record.assessmentId].voidReason, '题目答案有误，重新评')
})

test('复习按 1/3/7/14 天阶梯安排；跳过不记掌握；到期可查', () => {
  const ws = workspace()
  question(ws)
  const first = scheduleReview(ws, { questionId: 'q1' })
  assert.equal(first.intervalDays, 1)
  const second = scheduleReview(ws, { questionId: 'q1' })
  assert.equal(second.intervalDays, 3)
  const third = scheduleReview(ws, { questionId: 'q1' })
  assert.equal(third.intervalDays, 7)
  const fourth = scheduleReview(ws, { questionId: 'q1' })
  assert.equal(fourth.intervalDays, 14)

  const skipped = finishReview(ws, { reviewId: first.reviewId, result: 'skipped' })
  assert.equal(skipped.idempotent, false)
  const again = finishReview(ws, { reviewId: first.reviewId, result: 'skipped' })
  assert.equal(again.idempotent, true)
  assert.throws(() => finishReview(ws, { reviewId: first.reviewId, result: 'passed' }), ValidationError)

  const due = scheduleReview(ws, { questionId: 'q1', dueAt: '2020-01-01T00:00:00.000Z' })
  assert.equal(due.dueAt, '2020-01-01T00:00:00.000Z')
  const status = archiveStatus(ws)
  assert.equal(status.dueReviews.length, 1)
  assert.equal(status.dueReviews[0].id, due.reviewId)
})

test('材料索引：文件算指纹，URL 默认未核验，同 id 可更新', () => {
  const ws = workspace()
  const file = indexMaterial(ws, { materialId: 'm1', kind: 'file', title: '讲义', path: 'assets/course.js' })
  assert.equal(file.status, 'unverified')
  assert.match(file.sha256, /^[a-f0-9]{64}$/)
  assert.equal(file.path, 'assets/course.js')

  const url = indexMaterial(ws, { materialId: 'm2', kind: 'url', title: '公开课', url: 'https://example.com/lesson' })
  assert.equal(url.sha256, null)
  assert.equal(url.status, 'unverified')

  const verified = indexMaterial(ws, { materialId: 'm2', kind: 'url', title: '公开课', url: 'https://example.com/lesson', status: 'verified' })
  assert.equal(verified.status, 'verified')
  assert.equal(archiveStatus(ws).summary.materials, 2)

  const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'teach-mat-')), 'a.txt')
  fs.writeFileSync(outside, 'x')
  assert.throws(() => indexMaterial(ws, { kind: 'file', title: '外部', path: outside }), ValidationError)
})

test('档案状态只读：未初始化返回提示，不改磁盘；重建索引保留状态', () => {
  const empty = workspace()
  const before = archiveStatus(empty)
  assert.equal(before.initialized, false)
  assert.ok(!fs.existsSync(path.join(empty, '.dsh-teach-me', 'archive')))

  const ws = workspace()
  question(ws)
  const status = archiveStatus(ws)
  assert.equal(status.initialized, true)
  assert.equal(status.summary.lessons, 1)
  assert.equal(status.summary.questions, 1)
  const rebuilt = rebuildArchive(ws)
  assert.equal(rebuilt.rebuilt, true)
  assert.equal(rebuilt.revision, status.summary.revision)
  assert.equal(archiveStatus(ws).summary.questions, 1)
})

test('题目改版后相同答案是新提交，不能命中旧版本自动幂等键', () => {
  const ws = workspace()
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  const question = { questionId: 'q-repeat', lessonId: 'l1', type: 'choice', prompt: '第一版', options: [{ id: 'a' }, { id: 'b' }], answer: 'a' }
  registerQuestion(ws, question)
  const first = recordSubmission(ws, { questionId: 'q-repeat', rawAnswer: 'a' })
  registerQuestion(ws, { ...question, prompt: '第二版', answer: 'b' })
  const second = recordSubmission(ws, { questionId: 'q-repeat', rawAnswer: 'a' })
  assert.notEqual(first.submissionId, second.submissionId)
  assert.equal(second.verdict, 'needs_practice')
})

test('publish dryRun：只核对不写档案，正式发布才升 revision', () => {
  const ws = workspace()
  const page = path.join(ws, 'lessons', 'one.html')
  fs.writeFileSync(page, '<html><body><div class="quiz" data-question-id="q-2"></div><div class="quiz" data-question-id="q-1"></div></body></html>')

  const preview = publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html', dryRun: true })
  assert.equal(preview.dryRun, true)
  assert.equal(preview.committed, false)
  assert.equal(preview.idempotent, false)
  assert.equal(preview.lessonRevision, 0)
  assert.equal(preview.title, '第一课')
  assert.deepEqual(preview.assets, [])
  // 课堂挂点是现算的：演练就能看见「这几道题还没登记」
  assert.deepEqual(preview.classroomHooks.pageQuestionIds, ['q-1', 'q-2'])
  assert.deepEqual(preview.classroomHooks.danglingIds, ['q-1', 'q-2'])
  // 正式发布会写成 revision 1 —— 只给回执文案读，不进工具返回值
  assert.equal(preview.nextRevision, 1)
  assert.equal(Object.keys(preview).includes('classroomHooks'), false)
  // 演练对磁盘零副作用：连档案目录都不该出现
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false)

  const published = publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  assert.equal(published.committed, true)
  assert.equal(published.lessonRevision, 1)
  const revision = openArchive(ws).state.revision

  const same = publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html', dryRun: true })
  assert.equal(same.idempotent, true)
  assert.equal(same.lessonRevision, 1)
  assert.equal(same.nextRevision, 1)
  assert.equal(openArchive(ws).state.revision, revision, '演练不能写日志')

  fs.writeFileSync(page, '<html><body>改过的页面</body></html>')
  const changed = publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html', dryRun: true })
  assert.equal(changed.idempotent, false)
  assert.equal(changed.lessonRevision, 1)
  assert.equal(changed.nextRevision, 2)
  assert.equal(openArchive(ws).state.revision, revision, '演练不能写日志')

  // 演练没有事务，expectedRevision 不参与校验，也不该抛
  const ignored = publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', dryRun: true }, { expectedRevision: 999 })
  assert.equal(ignored.dryRun, true)
  assert.equal(openArchive(ws).state.revision, revision)
})

test('resolvePublish 只读：返回发布所需事实，不创建档案', () => {
  const ws = workspace()
  const plan = resolvePublish(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' }, { create: false })
  assert.equal(plan.archive, null)
  assert.equal(plan.id, 'l1')
  assert.equal(plan.title, '第一课')
  assert.equal(plan.file.relative, 'lessons/one.html')
  assert.match(plan.fingerprint, /^[0-9a-f]{64}$/)
  assert.deepEqual(plan.questionIds, [])
  assert.equal(plan.existing, undefined)
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false)
  // 演练也做完整校验：页面不存在/不是 HTML 照旧拒绝
  assert.throws(() => publishLesson(ws, { lessonId: 'l1', path: 'lessons/missing.html', dryRun: true }), ValidationError)
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false)
})

test('正式发布允许悬空 id；登记后挂点立即对上，不需要重新发布', () => {
  const ws = workspace()
  fs.writeFileSync(
    path.join(ws, 'lessons', 'one.html'),
    '<html><body><div class="quiz" data-question-id="q-1"></div></body></html>'
  )
  const published = publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  assert.equal(published.idempotent, false)
  assert.deepEqual(published.classroomHooks.pageQuestionIds, ['q-1'])
  assert.deepEqual(published.classroomHooks.danglingIds, ['q-1'])
  const lessonRevision = openArchive(ws).state.lessons.l1.revision

  registerQuestion(ws, { questionId: 'q-1', lessonId: 'l1', type: 'choice', prompt: '选一个', options: [{ id: 'a' }], answer: 'a' })

  const hooks = archiveStatus(ws).classroomHooks
  assert.deepEqual(hooks.lessons[0].registeredPageIds, ['q-1'])
  assert.deepEqual(hooks.danglingIds, [])
  // 课堂与侧栏读的是登记后的档案：课不用重发，lesson revision 也没有动
  assert.equal(openArchive(ws).state.lessons.l1.revision, lessonRevision)
  assert.equal(archiveStatus(ws).summary.questions, 1)
})
