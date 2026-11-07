import { learningScope, withLearningScope } from './learning-scope.js'
/* 开放题（explanation / design）的模型批改。
 *
 * 这个模块只做三件事：从档案里取原始答案与标准、发一次盲评请求、把逐条结果
 * 交回 evaluateSubmission。结论永远由宿主按「每条满足 + 每条有独立证据」推导，
 * 模型自己写的 passed / verdict / score 一律忽略。
 *
 * 硬约束（实施计划 5.2，P4 门槛）：
 *   1. 只读档案里的原始提交与题目；不接受调用方自报的判定；
 *   2. 盲评：提示里没有历史评估结论、没有学习者身份、没有「用过提示/看过解答」；
 *   3. 温度 0，严格 JSON，只允许每条标准的 id / met / evidence 加一句 reason；
 *   4. 没有模型服务、题目没有标准、材料缺失或变化、模型报错、JSON 非法、
 *      证据为空、标准对不上号 —— 一律 needs_review，原始答案不动；
 *   5. 模型输出里的 passed / verdict / score 等字段被显式丢弃，并回执被忽略了什么。
 *
 * 不 import 任何 @deepseek-ai/* 包（本包的依赖只有 schemastery）：llm 与会话路由
 * 都从 ctx 取，chunk 形状按官方 StreamChunk 的 text-delta / finish 读。 */

import { ValidationError } from './errors.js'
import { evaluateSubmission, readArchiveState } from './operations.js'
import { normalizeRubric } from './rubric.js'
import { materialsFingerprintOf } from './state.js'

/* normalizeRubric 迁到 rubric.js（评估链也要用它，放在这里会与 operations.js 成环），
 * 这里继续 re-export：0.6.1 的调用方与测试从 grading.js 取这个函数。 */
export { normalizeRubric }

/** 温度固定 0：批改要可复现，不是创作。 */
export const GRADING_TEMPERATURE = 0
export const GRADING_MAX_TOKENS = 1200
export const GRADING_TIMEOUT_MS = 60000
export const GRADING_MAX_REPLY_CHARS = 20000
/** 需要模型批改的题型；确定性题型不许走这条路。 */
export const OPEN_QUESTION_TYPES = ['explanation', 'design']

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new ValidationError(label + ' 不是合法标识')
  return value
}

function invalid(reason) {
  return { ok: false, reason }
}

/** 盲评的系统提示：只说规则，不带任何本题的历史与身份。 */
export function gradingSystemPrompt() {
  return [
    '你是严格但公平的开放题批改者。你只判断给定的评分标准，不发明新标准，也不给总分。',
    '输入里有题面、前提/口径、评分标准、材料摘录和学习者的原始答案。',
    '规则：',
    '1. 只按给定的标准逐条判断 met；每条必须给 evidence，evidence 只能引用答案里真实出现的原话或步骤，不能写「整体不错」这类空话。',
    '2. 只输出一个 JSON 对象（可以用 ```json 代码块包住），不要写别的说明：',
    '   {"criteria":[{"id":"标准 id","met":true,"evidence":"引用答案里的原话"}],"reason":"给学习者的一句话"}',
    '3. criteria 必须覆盖每一个标准 id，不多不少；id 按原样抄回。',
    '4. 没有证据说明某条满足时，met 为 false。不确定就给 false，不要猜。',
    '5. 不要输出 passed、verdict、score、total 等结论字段——结论不由你决定。'
  ].join('\n')
}

/** 拼一次盲评请求：只含题面、标准、材料与原始答案。 */
export function buildGradingPrompt({ question, submission, materials = [], rubric = [] }) {
  const lines = ['# 批改请求']
  lines.push('## 题目')
  lines.push('类型：' + question.type)
  lines.push(String(question.prompt).trim())
  if (typeof question.prerequisite === 'string' && question.prerequisite.trim() !== '') {
    lines.push('前提/口径：' + question.prerequisite.trim())
  }
  lines.push('## 评分标准（逐条判断，id 原样抄回）')
  for (const item of rubric) lines.push('- [' + item.id + '] ' + item.text)
  if (materials.length > 0) {
    lines.push('## 材料摘录')
    for (const material of materials) {
      const tags = [material.kind === 'url' ? '链接' : '文件']
      if (material.location !== undefined && material.location !== null && material.location !== '') tags.push(String(material.location))
      tags.push(material.status === 'verified' ? '已核验' : '未核验')
      lines.push('- ' + material.id + '（' + tags.join('，') + '）：' + material.title)
      if (typeof material.excerpt === 'string' && material.excerpt.trim() !== '') {
        lines.push('  > ' + material.excerpt.trim().split('\n').join('\n  > '))
      }
    }
  }
  lines.push('## 学习者原始答案（未改写）')
  lines.push('```text')
  lines.push(String(submission.rawAnswer))
  lines.push('```')
  return lines.join('\n')
}

/** 从模型输出里取出一个 JSON 对象（容忍代码块和前后废话）。 */
function extractJsonText(raw) {
  const text = String(raw).trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced === null ? text : fenced[1].trim()
  const start = candidate.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return candidate.slice(start, index + 1)
    }
  }
  return null
}

/**
 * 解析并严格校验模型输出。可接受的只有 {criteria:[{id,met,evidence}], reason}；
 * 缺字段、非布尔 met、证据为空、覆盖不上标准 id，全部按「无效」处理。
 * 顶层其它字段（passed / verdict / score 之类）不采信，只记进 ignored 回执。
 */
export function parseGradingReply(raw, { rubricIds = [] } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') return invalid('模型没有返回内容')
  const body = extractJsonText(raw)
  if (body === null) return invalid('模型输出里找不到 JSON 对象')
  let value
  try {
    value = JSON.parse(body)
  } catch (error) {
    return invalid('模型输出的 JSON 解析失败：' + messageOf(error))
  }
  if (!isPlainObject(value)) return invalid('模型输出必须是 JSON 对象')
  if (!Array.isArray(value.criteria)) return invalid('模型输出缺少 criteria 数组')
  if (value.criteria.length === 0) return invalid('模型没有给出任何一条标准的判断')
  const criteria = []
  const seen = new Set()
  for (const [index, item] of value.criteria.entries()) {
    if (!isPlainObject(item)) return invalid('criteria[' + index + '] 不是对象')
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '') return invalid('criteria[' + index + '] 缺少 id')
    if (!ID_PATTERN.test(id)) return invalid('criteria[' + index + '] 的 id 不合法：' + id)
    if (seen.has(id)) return invalid('标准 ' + id + ' 出现了两次')
    seen.add(id)
    if (typeof item.met !== 'boolean') return invalid('标准 ' + id + ' 的 met 不是布尔值')
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : ''
    if (evidence === '') return invalid('标准 ' + id + ' 没有独立证据')
    criteria.push({ id, met: item.met, evidence })
  }
  if (rubricIds.length > 0) {
    const expected = new Set(rubricIds)
    const missing = rubricIds.filter((id) => !seen.has(id))
    const extra = [...seen].filter((id) => !expected.has(id))
    if (missing.length > 0 || extra.length > 0) {
      return invalid(
        '模型给的标准和题目对不上号' +
          (missing.length > 0 ? '；缺：' + missing.join('、') : '') +
          (extra.length > 0 ? '；多出：' + extra.join('、') : '')
      )
    }
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
  const ignored = Object.keys(value)
    .filter((key) => key !== 'criteria' && key !== 'reason')
    .sort()
  return { ok: true, criteria, reason, ignored }
}

/** 组合调用方信号与超时；返回信号本身和「是不是超时」。 */
function callSignal(signal, timeoutMs) {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : GRADING_TIMEOUT_MS
  const timeout = new AbortController()
  const combined = new AbortController()
  const relay = () => combined.abort(signal?.reason)
  const timer = setTimeout(() => { timeout.abort(); combined.abort() }, ms)
  if (signal?.aborted) relay()
  else signal?.addEventListener('abort', relay, { once: true })
  return {
    signal: combined.signal,
    timeout: timeout.signal,
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', relay); combined.abort() }
  }
}

/**
 * 发一次盲评请求并拼出文本。失败返回 {ok:false, code, message}，不抛错：
 * 「模型没跑成」本身就是要记进档案的结论之一。
 */
export async function callGradingModel(options = {}) {
  const llm = options.llm
  if (llm === undefined || llm === null) {
    return { ok: false, code: 'llm-unavailable', message: '宿主没有提供 llm 服务，这台机器上不能做模型批改' }
  }
  const provider = typeof options.route?.provider === 'string' ? options.route.provider : ''
  const model = typeof options.route?.model === 'string' ? options.route.model : ''
  if (provider === '' || model === '') {
    return { ok: false, code: 'llm-route-missing', message: '拿不到这条会话的模型路由（provider/model），不能做模型批改' }
  }
  if (typeof llm.stream !== 'function') {
    return { ok: false, code: 'llm-unavailable', message: '宿主的 llm 服务没有 stream 接口，不能做模型批改' }
  }
  const temperature = options.temperature ?? GRADING_TEMPERATURE
  const maxTokens = options.maxTokens ?? GRADING_MAX_TOKENS
  const deadline = callSignal(options.signal, options.timeoutMs)
  const request = {
    provider,
    model,
    system: options.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: String(options.prompt ?? '') }] }],
    temperature,
    maxTokens,
    ...(deadline.signal === undefined ? {} : { signal: deadline.signal })
  }

  let text = ''
  let finish = null
  let iterator
  let abortListener
  let completed = false
  try {
    if (deadline.signal.aborted) throw new Error('aborted')
    const stream = llm.stream(request)
    iterator = stream[Symbol.asyncIterator]?.() ?? stream[Symbol.iterator]?.()
    if (iterator === undefined) throw new Error('模型没有返回可迭代流')
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(new Error('aborted'))
      deadline.signal.addEventListener('abort', abortListener, { once: true })
    })
    for (;;) {
      const item = await Promise.race([iterator.next(), aborted])
      if (item.done) { completed = true; break }
      const chunk = item.value
      if (chunk === null || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        if (text.length > GRADING_MAX_REPLY_CHARS) return { ok: false, code: 'llm-too-long', message: '模型输出过长' }
      }
      else if (chunk.type === 'finish') finish = chunk.reason ?? null
    }
  } catch (error) {
    const timedOut = deadline.timeout !== undefined && deadline.timeout.aborted === true
    return {
      ok: false,
      code: timedOut ? 'llm-timeout' : deadline.signal.aborted ? 'llm-aborted' : 'llm-failed',
      message: timedOut ? '模型批改超时（' + (Number.isFinite(options.timeoutMs) ? options.timeoutMs : GRADING_TIMEOUT_MS) + 'ms）' : '模型调用失败：' + messageOf(error)
    }
  } finally {
    deadline.signal.removeEventListener('abort', abortListener)
    deadline.dispose()
    if (!completed) {
      // 不等待一个可能挂起的 return；provider 仍收到取消信号。
      try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* 已关闭 */ }
    }
  }
  if (finish !== null && finish.kind === 'error') {
    return { ok: false, code: 'llm-failed', message: '模型返回失败：' + (finish.failure?.message ?? finish.failure?.code ?? '未知原因') }
  }
  if (finish !== null && finish.kind === 'aborted') {
    return { ok: false, code: 'llm-aborted', message: '模型调用被中止' }
  }
  if (finish !== null && finish.kind === 'max-tokens') {
    return { ok: false, code: 'llm-truncated', message: '模型输出被截断（超出 maxTokens）' }
  }
  if (text.trim() === '') return { ok: false, code: 'llm-empty', message: '模型没有返回文本' }
  if (text.length > GRADING_MAX_REPLY_CHARS) return { ok: false, code: 'llm-too-long', message: '模型输出过长（' + text.length + ' 字符）' }
  return { ok: true, text, model, provider, temperature }
}

/** 写一条 needs_review 评估（原始答案不动），并把结论回给工具面。 */
function recordNeedsReview(root, { submissionId, reason, failure, route, materialsFingerprint, expectedRevision, modelCalled }) {
  const method = modelCalled
    ? { kind: 'model', model: route?.model ?? 'unknown', provider: route?.provider ?? 'unknown', temperature: GRADING_TEMPERATURE, failure }
    : { kind: 'unavailable', requested: 'model', failure }
  const input = { submissionId, criteria: [], reason, method }
  if (typeof materialsFingerprint === 'string') input.materialsFingerprint = materialsFingerprint
  const result = evaluateSubmission(root, input, { expectedRevision })
  const capabilityMissing = failure === 'llm-unavailable' || failure === 'llm-route-missing'
  return {
    ok: capabilityMissing !== true,
    graded: false,
    submissionId,
    assessmentId: result.assessmentId,
    verdict: result.verdict,
    reason: result.reason,
    criteria: [],
    method,
    model: method.model ?? null,
    provider: method.provider ?? null,
    failure,
    ignored: [],
    materialsFingerprint: typeof materialsFingerprint === 'string' ? materialsFingerprint : null,
    committed: result.committed !== false
  }
}

/**
 * 批改一次开放题提交。
 *
 * @param {string} root 学习工作区
 * @param {{submissionId: string}} input 只接受提交 id；没有、也不接受「判定」参数
 * @param {{llm?: object, route?: {provider: string, model: string}, expectedRevision?: number, now?: number, timeoutMs?: number, maxTokens?: number, signal?: AbortSignal}} options
 * @returns {Promise<object>} graded / verdict / assessmentId / failure 等；结论由宿主推导
 */
export async function gradeOpenSubmission(root, input, options = {}) {
  const submissionId = optionalId(input?.submissionId, 'grade.submissionId')
  if (submissionId === null) throw new ValidationError('模型批改必须指明 submissionId')
  const state = readArchiveState(root)
  if (state === null) throw new ValidationError('这个工作区还没有学习档案；先登记题目与提交，再做模型批改。')
  const submission = state.submissions[submissionId]
  if (submission === undefined) throw new ValidationError('没有这次提交：' + submissionId)
  if (submission.contentVersion && state.lessons[submission.lessonId]?.contentVersion !== submission.contentVersion && state.lessonVersions?.[submission.lessonId]?.[submission.contentVersion]) {
    return withLearningScope({ ...learningScope(), lessonId: submission.lessonId, contentVersion: submission.contentVersion }, () => gradeOpenSubmission(root, input, options))
  }
  const question = state.questions[submission.questionId]
  const rubric = question === undefined ? [] : normalizeRubric(question.rubric)
  const materials = question === undefined || !Array.isArray(question.materials)
    ? []
    : question.materials.map((id) => state.materials[id]).filter((item) => item !== undefined)
  const missingMaterial = question === undefined || !Array.isArray(question.materials)
    ? []
    : question.materials.filter((id) => state.materials[id] === undefined)
  const fingerprint = question === undefined ? null : materialsFingerprintOf(state, question.materials ?? [])
  const expectedRevision = Number.isInteger(options.expectedRevision) ? options.expectedRevision : undefined
  const needsReview = (failure, reason, { modelCalled = false } = {}) =>
    recordNeedsReview(root, { submissionId, reason, failure, route: options.route, materialsFingerprint: fingerprint, expectedRevision, modelCalled })

  // —— 不发模型请求就能确定的失败路径 ——
  if (question === undefined) {
    return needsReview('question-missing', '题目不在档案里，模型没有可依据的标准；原始答案保留，等补录题目再评。')
  }
  if (!OPEN_QUESTION_TYPES.includes(question.type)) {
    throw new ValidationError(question.type + ' 题由宿主按标准答案确定性判分，不需要模型批改；用 teach_submission_record 记录提交即可。')
  }
  if (question.status === 'retired') {
    return needsReview('question-retired', '题目已作废，不能形成通过；原始答案保留。')
  }
  if (submission.questionRevision !== question.revision) {
    return needsReview(
      'question-changed',
      '提交针对旧版题目（v' + submission.questionRevision + '，现在 v' + question.revision + '），不能算通过；需要按新题面重新提交或作废旧评估。'
    )
  }
  if (rubric.length === 0) {
    return needsReview('no-rubric', '题目没有登记评分标准（rubric），模型批改没有依据；先补标准再评。')
  }
  if (missingMaterial.length > 0) {
    return needsReview('material-missing', '题目引用的材料不在档案里：' + missingMaterial.join('、') + '；先索引材料再评。')
  }

  // —— 盲评：提示里只有题干、标准、材料与原始答案 ——
  const system = gradingSystemPrompt()
  const prompt = buildGradingPrompt({ question, submission, materials, rubric })
  const reply = await callGradingModel({
    llm: options.llm,
    route: options.route,
    system,
    prompt,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    signal: options.signal
  })
  if (reply.ok !== true) {
    return needsReview(reply.code, reply.message + '；原始答案保留，结论记为待复核。', { modelCalled: reply.code !== 'llm-unavailable' && reply.code !== 'llm-route-missing' })
  }

  const parsed = parseGradingReply(reply.text, { rubricIds: rubric.map((item) => item.id) })
  if (parsed.ok !== true) {
    return needsReview('invalid-reply', '模型输出不能用（' + parsed.reason + '），结论记为待复核；原始答案保留。', { modelCalled: true })
  }

  const method = {
    kind: 'model',
    model: reply.model,
    provider: reply.provider,
    temperature: reply.temperature,
    prompt: 'open-question-blind-v1'
  }
  // 结论一律交给 evaluateSubmission：模型不能自己写 passed；材料/题目在批改期间
  // 变了的话，evaluate 会按材料指纹/题目版本把它压回 needs_review。
  const evaluation = evaluateSubmission(
    root,
    {
      submissionId,
      criteria: parsed.criteria,
      reason: parsed.reason === '' ? '模型按逐条标准盲评；结论由宿主推导。' : parsed.reason,
      method,
      ...(typeof fingerprint === 'string' ? { materialsFingerprint: fingerprint } : {})
    },
    { expectedRevision }
  )
  const allMet = parsed.criteria.every((item) => item.met === true && item.evidence.trim() !== '')
  const degraded = evaluation.verdict === 'needs_review' && allMet
  return {
    ok: true,
    graded: true,
    submissionId,
    assessmentId: evaluation.assessmentId,
    verdict: evaluation.verdict,
    reason: evaluation.reason,
    criteria: parsed.criteria,
    method,
    model: method.model,
    provider: method.provider,
    failure: degraded ? 'stale-during-grading' : null,
    ignored: parsed.ignored,
    materialsFingerprint: typeof fingerprint === 'string' ? fingerprint : null,
    committed: evaluation.committed !== false
  }
}
