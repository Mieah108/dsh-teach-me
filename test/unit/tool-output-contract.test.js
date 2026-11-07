import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { registerArchiveTools } from '../../lib/archive/tools.js'

/* 工具输出契约：宿主会用 output.schema 严格校验每个工具的返回值
 * （additionalProperties:false、类型必须对、必填必须有），校验不过就把一次成功的写入
 * 报成 invalid output。2026-10 的真实测试会话里，publish / material_index /
 * question_register 一共 8 次这样"假失败"，模型因此重试并把写入误记成失败。
 *
 * 这份测试把契约钉在「返回值」这一层：成功、幂等重放、校验失败、工作区未知四条路径，
 * 返回体都必须通过它自己声明的 schema，且不允许出现 null（宿主的校验器不支持可空类型）。 */

/** 镜像宿主 dsh-tools 的 JSON Schema 语义：单值 type、properties/required/additionalProperties、items、enum、oneOf。 */
function violationsOf(schema, value, at = 'value', found = []) {
  if (schema === null || typeof schema !== 'object') return found
  if (value === null) {
    found.push(at + ' is null (schema 不支持可空类型，空值应当在出口被剪掉)')
    return found
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((branch) => violationsOf(branch, value, at, []).length === 0).length
    if (matches !== 1) found.push(at + ' must match exactly one oneOf branch (matched ' + matches + ')')
    return found
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      found.push(at + ' must be an object')
      return found
    }
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) found.push('missing required property "' + at + '.' + key + '"')
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) found.push('"' + at + '.' + key + '" is not a declared property')
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] !== undefined) violationsOf(child, value[key], at + '.' + key, found)
    }
    return found
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      found.push(at + ' must be an array')
      return found
    }
    if (schema.items !== undefined) value.forEach((item, index) => violationsOf(schema.items, item, at + '[' + index + ']', found))
    return found
  }
  if (schema.type === 'string' && typeof value !== 'string') found.push(at + ' must be a string')
  if (schema.type === 'integer' && !Number.isInteger(value)) found.push(at + ' must be an integer')
  if (schema.type === 'number' && typeof value !== 'number') found.push(at + ' must be a number')
  if (schema.type === 'boolean' && typeof value !== 'boolean') found.push(at + ' must be a boolean')
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) found.push(at + ' must be one of ' + schema.enum.join('|'))
  return found
}

function fakeCtx() {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (tool) => { registered.push(tool); return () => {} } }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    }
  }
  return { ctx, registered }
}

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-contract-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.writeFileSync(
    path.join(ws, 'lessons', 'one.html'),
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>1</title></head><body><div class="quiz" data-question-id="q-choice">题</div></body></html>'
  )
  fs.writeFileSync(path.join(ws, 'reference.md'), '# 参考\n')
  return ws
}

const AGENT = { session: { id: 'session-1' }, id: 'agent-1' }
const EXEC = { agent: AGENT }

function harness() {
  const ws = workspace()
  const { ctx, registered } = fakeCtx()
  registerArchiveTools(ctx, { tools: { archive: true } }, () => ws)
  const tools = new Map(registered.map((tool) => [tool.name, tool]))
  return { ws, tools }
}

/** 调一次工具并断言输出契约，返回结果供用例继续断言语义。 */
async function call(tools, name, args, { expectOk = true } = {}) {
  const tool = tools.get(name)
  assert.ok(tool !== undefined, '工具没注册：' + name)
  const value = await tool.execute(args, EXEC)
  const violations = violationsOf(tool.output.schema, value)
  assert.deepEqual(violations, [], name + ' 的返回体不合自己的 output.schema：' + violations.join('; '))
  assert.equal(typeof value.text, 'string')
  assert.equal(typeof value.ok, 'boolean')
  if (expectOk) assert.equal(value.ok, true, name + ' 期望成功：' + value.text)
  return value
}

test('成功路径：十一个档案工具的返回体都通过自己声明的 output.schema', async () => {
  const { tools } = harness()

  const published = await call(tools, 'teach_lesson_publish', { path: 'lessons/one.html', lessonId: 'lesson-1', title: '第一课' })
  assert.equal(published.lessonId, 'lesson-1')
  assert.equal(published.lessonRevision, 1)
  assert.equal(published.title, '第一课')
  assert.equal(published.committed, true)
  assert.equal(typeof published.revision, 'number')
  // D2：内部事实（指纹 / 逐资源哈希与大小）不进模型回执。
  assert.equal(Object.hasOwn(published, 'assets'), false, 'assets 应从回执里删掉')
  assert.equal(Object.hasOwn(published, 'fingerprint'), false, 'fingerprint 应从回执里删掉')

  // v0.6.3-C：一次 commit 完成发布 + 登记；返回体必须过自己的 schema（含 open 计划）。
  const commitArgs = {
    lessonId: 'lesson-commit',
    path: 'lessons/one.html',
    idempotencyKey: 'contract-commit-1',
    questions: [{ questionId: 'q-commit', lessonId: 'lesson-commit', type: 'short', prompt: '这一项是什么？', answer: '答案' }]
  }
  const committed = await call(tools, 'teach_commit', commitArgs)
  assert.equal(committed.lessonId, 'lesson-commit')
  assert.equal(committed.lessonRevision, 1)
  assert.equal(committed.committed, true)
  assert.equal(committed.idempotent, false)
  assert.equal(committed.step, 'commit')
  assert.deepEqual(committed.questionIds, ['q-choice'])
  assert.deepEqual(committed.open, { path: 'lessons/one.html', lessonId: 'lesson-commit' })
  const commitReplay = await call(tools, 'teach_commit', commitArgs)
  assert.equal(commitReplay.idempotent, true)
  assert.equal(commitReplay.committed, false)
  assert.equal(commitReplay.lessonRevision, 1)
  const commitDry = await call(tools, 'teach_commit', { ...commitArgs, idempotencyKey: 'contract-commit-dry', dryRun: true })
  assert.equal(commitDry.dryRun, true)
  assert.equal(commitDry.committed, false)

  const registeredQuestion = await call(tools, 'teach_question_register', {
    questionId: 'q-choice',
    lessonId: 'lesson-1',
    type: 'choice',
    prompt: '默认配置下这两个地址会撞同一个 BHT 项吗？',
    answer: '会',
    options: [{ id: 'a', text: '会' }, { id: 'b', text: '不会' }]
  })
  assert.equal(registeredQuestion.questionRevision, 1)
  // D2：lessonId 是入参回显，不再占字段。
  assert.equal(Object.hasOwn(registeredQuestion, 'lessonId'), false)

  const graded = await call(tools, 'teach_submission_record', { questionId: 'q-choice', rawAnswer: '会' })
  assert.equal(graded.status, 'evaluated')
  assert.equal(graded.verdict, 'passed')
  assert.equal(typeof graded.reason, 'string')

  const evaluated = await call(tools, 'teach_evaluate', {
    submissionId: graded.submissionId,
    criteria: [{ id: 'c1', met: true, evidence: '答出索引位相同' }]
  })
  assert.equal(typeof evaluated.verdict, 'string')

  const voided = await call(tools, 'teach_assessment_void', { assessmentId: evaluated.assessmentId, reason: '改判' })
  assert.equal(voided.voided, true)

  const fileMaterial = await call(tools, 'teach_material_index', {
    kind: 'file',
    title: '参考',
    path: 'reference.md',
    materialId: 'mat-file'
  })
  assert.equal(fileMaterial.materialId, 'mat-file')
  assert.equal(fileMaterial.path, 'reference.md')

  const urlMaterial = await call(tools, 'teach_material_index', {
    kind: 'url',
    title: '上游仓库',
    url: 'https://example.com/a.sv',
    materialId: 'mat-url'
  })
  assert.equal(urlMaterial.url, 'https://example.com/a.sv')

  const selfReported = await call(tools, 'teach_self_report', { id: 'sr-1', claim: '离线自测过了' })
  assert.equal(selfReported.selfReportId, 'sr-1')

  const deferred = await call(tools, 'teach_defer', { id: 'df-1', questionId: 'q-choice', reason: '先跳过' })
  assert.equal(deferred.deferralId, 'df-1')

  const scheduled = await call(tools, 'teach_review', { action: 'schedule', questionId: 'q-choice', intervalDays: 3 })
  assert.equal(typeof scheduled.reviewId, 'string')

  const finished = await call(tools, 'teach_review', { action: 'finish', reviewId: scheduled.reviewId, result: 'completed' })
  assert.equal(finished.result, 'completed')

  const queue = await call(tools, 'teach_review', { action: 'due' })
  assert.equal(typeof queue.initialized, 'boolean')
  assert.equal(typeof queue.dueCount, 'number')
  // D2：同一个数组不再以 due / dueReviews 两个字段各返回一遍。
  assert.equal(Object.hasOwn(queue, 'due'), false)
  assert.equal(Array.isArray(queue.dueReviews), true)

  const open = await call(tools, 'teach_question_register', {
    questionId: 'q-open',
    lessonId: 'lesson-1',
    type: 'explanation',
    prompt: '说清 BHT 何时被读、何时被写',
    rubric: [{ id: 'c1', text: '取指读' }, { id: 'c2', text: 'EX 写' }]
  })
  assert.equal(open.questionRevision, 1)

  const pending = await call(tools, 'teach_submission_record', { questionId: 'q-open', rawAnswer: '取指阶段读，EX 阶段写' })
  assert.equal(pending.status, 'pending')

  // 没有 llm 服务时走 needs_review：ok 是 false，但返回体仍然是合法的一次"已记录"。
  const gradedOpen = await call(tools, 'teach_grade_open', { submissionId: pending.submissionId }, { expectOk: false })
  assert.equal(gradedOpen.graded, false)
  assert.equal(gradedOpen.verdict, 'needs_review')
  assert.equal(typeof gradedOpen.reason, 'string')
})

test('幂等重放：同内容重复调用不炸 schema，且 committed 如实为 false', async () => {
  const { tools } = harness()
  await call(tools, 'teach_lesson_publish', { path: 'lessons/one.html', lessonId: 'lesson-1', title: '第一课' })
  const again = await call(tools, 'teach_lesson_publish', { path: 'lessons/one.html', lessonId: 'lesson-1', title: '第一课' })
  assert.equal(again.idempotent, true)
  assert.equal(again.lessonRevision, 1)
  assert.equal(again.committed, false)

  await call(tools, 'teach_self_report', { id: 'sr-1', claim: '离线自测过了' })
  const replay = await call(tools, 'teach_self_report', { id: 'sr-1', claim: '离线自测过了' })
  assert.equal(replay.idempotent, true)
  assert.equal(replay.committed, false)
})

test('失败路径：参数不合法时仍返回合法信封，且真实错误不被 schema 吃掉', async () => {
  const { tools } = harness()
  for (const [name, args] of [
    ['teach_lesson_publish', {}],
    ['teach_question_register', {}],
    ['teach_submission_record', {}],
    ['teach_evaluate', {}],
    ['teach_material_index', {}],
    ['teach_self_report', {}],
    ['teach_defer', {}],
    ['teach_grade_open', {}],
    ['teach_assessment_void', {}],
    ['teach_review', { action: 'schedule' }],
    ['teach_commit', { lessonId: 'x', path: 'lessons/one.html' }]
  ]) {
    const value = await call(tools, name, args, { expectOk: false })
    assert.equal(value.ok, false, name + ' 空参数应当失败')
    assert.equal(typeof value.error, 'string', name + ' 失败要带错误代码：' + value.text)
    // 失败信封不该假装成功：领域字段一律不出现。
    for (const key of ['lessonId', 'materialId', 'questionId', 'verdict']) {
      assert.equal(value[key], undefined, name + ' 失败时不该带 ' + key)
    }
  }
})

test('工作区未知：tools 仍然注册，调用失败但返回合法信封', async () => {
  const registered = []
  registerArchiveTools(
    {
      get: (name) => (name === 'tools' ? { register: (tool) => { registered.push(tool); return () => {} } } : undefined),
      effect: (factory) => factory()
    },
    { tools: { archive: true } },
    () => {
      throw new Error('还不知道工作区')
    }
  )
  assert.equal(registered.length, 11)
  const publish = registered.find((tool) => tool.name === 'teach_lesson_publish')
  const value = await publish.execute({ path: 'lessons/one.html', lessonId: 'lesson-1' }, EXEC)
  assert.deepEqual(violationsOf(publish.output.schema, value), [])
  assert.equal(value.ok, false)
  assert.match(value.text, /没有写入/)
})

test('每个工具都声明了 revision / committed（transact 回执），否则成功路径必炸', async () => {
  const { tools } = harness()
  for (const [name, tool] of tools) {
    const properties = tool.output.schema.properties
    assert.ok(Object.hasOwn(properties, 'revision'), name + ' 少声明 revision')
    assert.ok(Object.hasOwn(properties, 'committed'), name + ' 少声明 committed')
    assert.deepEqual(tool.output.schema.required, ['text', 'ok'], name + ' 的 required 只该是 text + ok')
  }
})
