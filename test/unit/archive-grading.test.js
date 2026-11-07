import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ValidationError } from '../../lib/archive/errors.js'
import {
  GRADING_TEMPERATURE,
  gradeOpenSubmission,
  normalizeRubric,
  parseGradingReply
} from '../../lib/archive/grading.js'
import {
  archiveStatus,
  indexMaterial,
  publishLesson,
  recordSubmission,
  registerQuestion
} from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import { registerArchiveTools, resolveModelRoute } from '../../lib/archive/tools.js'

const ROUTE = { provider: 'fake-provider', model: 'fake-model' }
const RAW = '因为反向传播要把每层的雅可比连乘，谱范数普遍小于 1，深度一大就指数衰减。'
const RUBRIC = [
  { id: 'mechanism', text: '讲清连乘机制' },
  { id: 'boundary', text: '说出一个边界或反例' }
]

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-grading-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), '<html><body>课</body></html>')
  fs.writeFileSync(path.join(ws, 'assets', 'notes.md'), '第一版讲义\n')
  publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  return ws
}

function openQuestion(ws, { rubric = RUBRIC, materials = [] } = {}) {
  registerQuestion(ws, {
    questionId: 'q-open',
    lessonId: 'l1',
    type: 'explanation',
    prompt: '为什么深网络的梯度会消失？',
    prerequisite: '口径：只看反向传播的连乘',
    rubric,
    materials
  })
  return recordSubmission(ws, { questionId: 'q-open', rawAnswer: RAW, source: 'chat' })
}

/** 假 llm：只实现 stream()，按用例产出 text-delta / finish。 */
function fakeLlm(respond) {
  const calls = []
  const llm = {
    stream(options) {
      calls.push(options)
      return (async function* () {
        const chunks = await respond(options, calls)
        if (chunks instanceof Error) throw chunks
        for (const chunk of chunks) yield chunk
      })()
    }
  }
  return { llm, calls }
}

function textChunks(text, finish = { kind: 'stop' }) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: finish }
  ]
}

const replyOf = (criteria, extra = {}) => JSON.stringify({ criteria, reason: '按标准判断', ...extra })

function allMet() {
  return [
    { id: 'mechanism', met: true, evidence: '答案说「雅可比连乘」' },
    { id: 'boundary', met: true, evidence: '答案说「谱范数普遍小于 1」' }
  ]
}

function fakeCtx(workspaceDir, { llm, selection } = {}) {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (tool) => { registered.push(tool); return () => {} } }
      if (name === 'workingDirectory') return { get: () => workspaceDir }
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return selection === undefined ? undefined : { currentSelection: () => selection }
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

test('开放题盲评：标准全满足且证据非空才 passed；结论由宿主推导', async () => {
  const ws = workspace()
  const submission = openQuestion(ws)
  const { llm, calls } = fakeLlm(() => textChunks(replyOf(allMet())))
  const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })

  assert.equal(result.graded, true)
  assert.equal(result.verdict, 'passed')
  assert.equal(result.ok, true)
  assert.equal(result.method.kind, 'model')
  assert.equal(result.method.model, 'fake-model')
  assert.equal(result.method.temperature, GRADING_TEMPERATURE)

  // 温度 0、只发一次、只有一条 user 消息（没有历史对话）
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'fake-provider')
  assert.equal(calls[0].model, 'fake-model')
  assert.equal(calls[0].temperature, 0)
  assert.equal(calls[0].maxTokens, 1200)
  assert.equal(calls[0].messages.length, 1)
  assert.equal(calls[0].messages[0].role, 'user')

  const prompt = calls[0].messages[0].content[0].text
  assert.ok(prompt.includes(RAW), '提示里要有原始答案')
  assert.ok(prompt.includes('[mechanism]') && prompt.includes('[boundary]'), '提示里要有逐条标准 id')
  assert.ok(prompt.includes('为什么深网络的梯度会消失？'))
  assert.ok(!prompt.includes(submission.submissionId), '盲评不带提交身份')
  assert.ok(!/passed|verdict|needs_review|needs_practice/.test(prompt), '提示里不出现历史/结论词')

  const state = openArchive(ws).state
  const assessment = state.assessments[result.assessmentId]
  assert.equal(assessment.verdict, 'passed')
  assert.equal(assessment.criteria.length, 2)
  assert.equal(assessment.method.kind, 'model')
  assert.equal(state.submissions[submission.submissionId].rawAnswer, RAW)
  assert.equal(archiveStatus(ws).summary.passed, 1)
})

test('模型自报 passed/verdict/score 一律忽略：结论只由逐条标准推导', async () => {
  const ws = workspace()
  const submission = openQuestion(ws)
  const reply = replyOf(
    [
      { id: 'mechanism', met: true, evidence: '答案讲了连乘' },
      { id: 'boundary', met: false, evidence: '答案没说出边界' }
    ],
    { passed: true, verdict: 'passed', score: 100, correct: true }
  )
  const { llm } = fakeLlm(() => textChunks(reply))
  const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })

  assert.equal(result.verdict, 'needs_practice', '模型说 passed 也不能覆盖 met:false')
  assert.deepEqual(result.ignored, ['correct', 'passed', 'score', 'verdict'])
  assert.equal(archiveStatus(ws).summary.passed, 0)
  assert.match(result.method.failure ?? '', /^$/, '这是正常评估，不是失败')
})

test('自报 passed 也救不了空证据：证据为空按无效输出处理', async () => {
  const ws = workspace()
  const submission = openQuestion(ws)
  const reply = replyOf(
    [
      { id: 'mechanism', met: true, evidence: '   ' },
      { id: 'boundary', met: true, evidence: '答案说了边界' }
    ],
    { passed: true }
  )
  const { llm } = fakeLlm(() => textChunks(reply))
  const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })

  assert.equal(result.graded, false)
  assert.equal(result.verdict, 'needs_review')
  assert.equal(result.failure, 'invalid-reply')
  assert.ok(result.ignored.length === 0, '无效输出不采信任何字段')
  assert.equal(archiveStatus(ws).summary.passed, 0)
})

test('没有 llm 服务：明确失败，记 needs_review，原始答案不丢，绝不伪造通过', async () => {
  const ws = workspace()
  const submission = openQuestion(ws)
  const before = openArchive(ws).state.revision
  const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm: undefined, route: ROUTE })

  assert.equal(result.ok, false)
  assert.equal(result.graded, false)
  assert.equal(result.failure, 'llm-unavailable')
  assert.equal(result.verdict, 'needs_review')
  assert.match(result.method.kind, /unavailable/)

  const state = openArchive(ws).state
  assert.ok(state.revision > before, '仍然要留下一条 needs_review 记录')
  assert.equal(state.submissions[submission.submissionId].rawAnswer, RAW)
  assert.equal(state.submissions[submission.submissionId].status, 'needs_review')
  assert.equal(archiveStatus(ws).summary.passed, 0)
})

test('拿不到模型路由：明确失败，不调用任何模型', async () => {
  const ws = workspace()
  const submission = openQuestion(ws)
  const { llm, calls } = fakeLlm(() => textChunks(replyOf(allMet())))
  const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: null })

  assert.equal(result.ok, false)
  assert.equal(result.failure, 'llm-route-missing')
  assert.equal(result.verdict, 'needs_review')
  assert.equal(calls.length, 0)
  assert.equal(archiveStatus(ws).summary.passed, 0)
})

test('题目没有标准：不调模型，直接 needs_review', async () => {
  const ws = workspace()
  const submission = openQuestion(ws, { rubric: [] })
  const { llm, calls } = fakeLlm(() => textChunks(replyOf(allMet())))
  const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })

  assert.equal(result.failure, 'no-rubric')
  assert.equal(result.verdict, 'needs_review')
  assert.equal(calls.length, 0)
  assert.equal(openArchive(ws).state.submissions[submission.submissionId].rawAnswer, RAW)
})

test('题目引用的材料不在档案里：不调模型，needs_review', async () => {
  const ws = workspace()
  const submission = openQuestion(ws, { materials: ['m-missing'] })
  const { llm, calls } = fakeLlm(() => textChunks(replyOf(allMet())))
  const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })
  assert.equal(result.failure, 'material-missing')
  assert.equal(result.verdict, 'needs_review')
  assert.equal(calls.length, 0)
})

test('模型报错 / 中止 / 截断 / 空输出：needs_review 且原答案保留', async () => {
  const cases = [
    ['抛错', () => new Error('network down'), 'llm-failed'],
    ['finish error', () => textChunks('', { kind: 'error', failure: { message: 'boom', code: 'X' } }), 'llm-failed'],
    ['finish aborted', () => textChunks('', { kind: 'aborted', failure: { message: 'cancelled', code: 'Y' } }), 'llm-aborted'],
    ['max-tokens', () => textChunks('半截', { kind: 'max-tokens' }), 'llm-truncated'],
    ['空输出', () => textChunks(''), 'llm-empty']
  ]
  for (const [label, respond, code] of cases) {
    const ws = workspace()
    const submission = openQuestion(ws)
    const { llm } = fakeLlm(respond)
    const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })
    assert.equal(result.failure, code, label)
    assert.equal(result.verdict, 'needs_review', label)
    assert.equal(result.ok, true, label + '：模型失败不是写盘失败')
    assert.equal(openArchive(ws).state.submissions[submission.submissionId].rawAnswer, RAW, label)
    assert.equal(archiveStatus(ws).summary.passed, 0, label)
  }
})

test('JSON 非法 / 标准对不上号 / 不是 JSON 对象：都算无效输出', async () => {
  const cases = [
    ['纯文本', '我觉得他答对了，但说不太清。'],
    ['缺 criteria', JSON.stringify({ reason: '不错', passed: true })],
    ['criteria 为空', JSON.stringify({ criteria: [] })],
    ['不是对象', '[1,2,3]'],
    ['标准对不上号', JSON.stringify({ criteria: [{ id: 'invented', met: true, evidence: 'x' }] })],
    ['met 不是布尔', JSON.stringify({ criteria: [{ id: 'mechanism', met: 'yes', evidence: 'x' }] })]
  ]
  for (const [label, reply] of cases) {
    const ws = workspace()
    const submission = openQuestion(ws)
    const { llm } = fakeLlm(() => textChunks(reply))
    const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })
    assert.equal(result.failure, 'invalid-reply', label)
    assert.equal(result.verdict, 'needs_review', label)
    assert.equal(archiveStatus(ws).summary.passed, 0, label)
  }
})

test('解析器自己也拦得住：缺字段/空证据/对不上号都给原因', () => {
  assert.equal(parseGradingReply('', {}).ok, false)
  assert.equal(parseGradingReply('no json here', {}).ok, false)
  assert.equal(parseGradingReply(JSON.stringify({ criteria: [{ id: 'a', met: true }] }), {}).ok, false)
  const ok = parseGradingReply(JSON.stringify({ criteria: [{ id: 'a', met: true, evidence: '原话' }] }), { rubricIds: ['a'] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.criteria, [{ id: 'a', met: true, evidence: '原话' }])
  // 代码块包裹也能读
  const fenced = parseGradingReply('```json\n{"criteria":[{"id":"a","met":false,"evidence":"没做到"}]}\n```', { rubricIds: ['a'] })
  assert.equal(fenced.ok, true)
  assert.equal(fenced.criteria[0].met, false)
  // 标准格式放宽：字符串与 {id,criterion}
  assert.deepEqual(normalizeRubric(['讲清机制', { id: 'b', criterion: '说边界' }]), [
    { id: 'criterion-1', text: '讲清机制' },
    { id: 'b', text: '说边界' }
  ])
})

test('批改期间材料指纹变了：压回 needs_review，不算通过', async () => {
  const ws = workspace()
  indexMaterial(ws, { materialId: 'm1', kind: 'file', title: '讲义', path: 'assets/notes.md' })
  const submission = openQuestion(ws, { materials: ['m1'] })
  const { llm } = fakeLlm(() => {
    // 模型还没返回，材料被换了
    fs.writeFileSync(path.join(ws, 'assets', 'notes.md'), '第二版讲义，结论改了\n')
    indexMaterial(ws, { materialId: 'm1', kind: 'file', title: '讲义', path: 'assets/notes.md' })
    return textChunks(replyOf(allMet()))
  })
  const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })

  assert.equal(result.verdict, 'needs_review')
  assert.equal(result.failure, 'stale-during-grading')
  assert.equal(archiveStatus(ws).summary.passed, 0)
  assert.equal(openArchive(ws).state.submissions[submission.submissionId].rawAnswer, RAW)
})

test('批改期间题目改版：压回 needs_review', async () => {
  const ws = workspace()
  const submission = openQuestion(ws)
  const { llm } = fakeLlm(() => {
    registerQuestion(ws, {
      questionId: 'q-open',
      lessonId: 'l1',
      type: 'explanation',
      prompt: '改过的题面',
      rubric: RUBRIC
    })
    return textChunks(replyOf(allMet()))
  })
  const result = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })
  assert.equal(result.verdict, 'needs_review')
  assert.equal(result.failure, 'stale-during-grading')
  assert.equal(archiveStatus(ws).summary.passed, 0)
})

test('确定性题不许走模型批改：明确报错且不写新评估', async () => {
  const ws = workspace()
  openQuestion(ws)
  registerQuestion(ws, {
    questionId: 'q-choice',
    lessonId: 'l1',
    type: 'choice',
    prompt: '选一个',
    options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
    answer: 'b'
  })
  const submission = recordSubmission(ws, { questionId: 'q-choice', rawAnswer: 'b', source: 'chat' })
  const assessmentsBefore = Object.keys(openArchive(ws).state.assessments).length
  const { llm, calls } = fakeLlm(() => textChunks(replyOf(allMet())))

  await assert.rejects(
    () => gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE }),
    ValidationError
  )
  assert.equal(calls.length, 0)
  assert.equal(Object.keys(openArchive(ws).state.assessments).length, assessmentsBefore)
  assert.equal(archiveStatus(ws).summary.passed, 1, '确定性判分的结果不受影响')
})

test('重复/并发的模型批改不重复记分：同一次提交只算一次通过，旧结论进历史', async () => {
  const ws = workspace()
  const submission = openQuestion(ws)
  const { llm } = fakeLlm(() => textChunks(replyOf(allMet())))

  const first = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })
  const second = await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })
  assert.notEqual(first.assessmentId, second.assessmentId)
  assert.equal(archiveStatus(ws).summary.passed, 1)
  assert.equal(archiveStatus(ws).summary.submissions, 1)

  const [third, fourth] = await Promise.all([
    gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE }),
    gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })
  ])
  assert.equal(third.graded, true)
  assert.equal(fourth.graded, true)
  const state = openArchive(ws).state
  assert.equal(state.submissions[submission.submissionId].status, 'evaluated')
  assert.equal(archiveStatus(ws).summary.passed, 1, '并发批改不能把同一次提交算成两次通过')
  assert.equal(Object.keys(state.assessments).length, 4, '每次批改各自留一条历史')
})

test('二次批改是盲评：提示里不带上一轮的评估结论', async () => {
  const ws = workspace()
  const submission = openQuestion(ws)
  const { llm, calls } = fakeLlm(() => textChunks(replyOf(allMet(), { reason: '第一轮的结论' })))
  await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm, route: ROUTE })
  const firstPrompt = calls[0].messages[0].content[0].text

  const second = fakeLlm(() => textChunks(replyOf(allMet())))
  await gradeOpenSubmission(ws, { submissionId: submission.submissionId }, { llm: second.llm, route: ROUTE })
  const secondPrompt = second.calls[0].messages[0].content[0].text
  assert.equal(secondPrompt, firstPrompt, '同一份提交的盲评提示每一轮都一样，不夹带历史')
  assert.ok(!secondPrompt.includes('第一轮的结论'))
})

test('teach_grade_open 工具：参数里没有判定字段，结论仍由宿主推导', async () => {
  const ws = workspace()
  const submission = openQuestion(ws)
  const { llm } = fakeLlm(() => textChunks(replyOf(allMet())))
  const { ctx, registered } = fakeCtx(ws, { llm, selection: ROUTE })
  registerArchiveTools(ctx, {}, () => ws)

  const grade = registered.find((tool) => tool.name === 'teach_grade_open')
  assert.ok(grade !== undefined)
  const parameterText = JSON.stringify(grade.parameters)
  for (const forbidden of ['verdict', 'passed', 'correct', 'criteria', 'score']) {
    assert.ok(!parameterText.includes(forbidden), '工具参数里不能有 ' + forbidden)
  }
  assert.deepEqual(grade.parameters.required, ['submissionId'])

  const result = await grade.execute({ submissionId: submission.submissionId }, { agent: AGENT })
  assert.equal(result.ok, true)
  assert.equal(result.verdict, 'passed')
  assert.equal(result.graded, true)
  assert.match(result.text, /模型盲评已入库/)
  assert.match(result.text, /结论：passed/)

  const unknown = await grade.execute({ submissionId: 'sub_missing' }, { agent: AGENT })
  assert.equal(unknown.ok, false)
  assert.match(unknown.text, /没有写入/)
})

test('teach_grade_open 工具没有 llm 时明确失败，不写成通过', async () => {
  const ws = workspace()
  const submission = openQuestion(ws)
  const { ctx, registered } = fakeCtx(ws, { llm: undefined, selection: ROUTE })
  registerArchiveTools(ctx, {}, () => ws)
  const grade = registered.find((tool) => tool.name === 'teach_grade_open')
  const result = await grade.execute({ submissionId: submission.submissionId }, { agent: AGENT })

  assert.equal(result.ok, false)
  assert.equal(result.verdict, 'needs_review')
  assert.equal(result.failure, 'llm-unavailable')
  assert.match(result.text, /不是通过/)
  assert.equal(archiveStatus(ws).summary.passed, 0)
})

test('模型路由：优先会话请求头，其次宿主默认模型，都没有返回 null', () => {
  const { ctx } = fakeCtx('/tmp', { selection: { provider: 'default-p', model: 'default-m' } })
  const withHeader = { agent: { id: 'a', session: { requestHeader: () => ({ config: { provider: 'session-p', model: 'session-m' } }) } } }
  assert.deepEqual(resolveModelRoute(ctx, withHeader), { provider: 'session-p', model: 'session-m' })
  assert.deepEqual(resolveModelRoute(ctx, { agent: { id: 'a', session: {} } }), { provider: 'default-p', model: 'default-m' })
  assert.deepEqual(resolveModelRoute(ctx, { agent: { id: 'a', session: { requestHeader: () => undefined } } }), { provider: 'default-p', model: 'default-m' })
  const blank = fakeCtx('/tmp', { selection: undefined })
  assert.equal(resolveModelRoute(blank.ctx, {}), null)
})
