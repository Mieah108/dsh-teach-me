/* 一次 commit：发布课程 + 登记题目 + 幂等记录，落在同一个 journal 行。
 *
 * 目的（§4.3）：把「发布成功但登记失败」变成不存在——三者同一事务，要么全成要么全不成；
 * 重试靠幂等键 + 内容等价，不靠重放判断。收益是幂等、一致性、恢复，不是压缩往返。
 *
 * 三条硬规则：
 *   1. `idempotencyKey` 必填：同 key 同 hash 返回既有结果，异 hash 是冲突（绝不覆盖）；
 *   2. 锁内二次核对（TOCTOU）：不拿预检结果继续执行，页面/资源/题目任一变化都拒绝；
 *   3. 题目按内容等价去重：改都没改的题不写 event，旧 `passed` 不会因重试变 stale。
 */

import { CommitRejectedError, IdempotencyConflictError, ValidationError } from './errors.js'
import { publishChangeOf, questionDataOf, questionUnchanged, resolvePublish } from './operations.js'
import { openArchive } from './store.js'
import { canonicalJson, hashJson } from './util.js'
import { goalChangesOf } from './goals.js'

const MAX_QUESTIONS = 200

function assertKey(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('commit 需要显式 idempotencyKey（重试同一份提交必须复用同一个）')
  }
  if (value.length > 500) throw new ValidationError('idempotencyKey 太长（≤500）')
  return value
}

/** 题目参数校验 + 归一化；重复 id 直接拒绝（否则同一事务里两条 upsert 会互相覆盖）。 */
function questionsOf(input) {
  const raw = input.questions
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new ValidationError('questions 必须是数组')
  if (raw.length > MAX_QUESTIONS) throw new ValidationError(`一次 commit 最多 ${MAX_QUESTIONS} 道题（现在 ${raw.length}）`)
  const seen = new Set()
  return raw.map((item) => {
    const data = questionDataOf(item ?? {})
    if (seen.has(data.id)) throw new ValidationError('questions 里有重复的题目 id：' + data.id)
    seen.add(data.id)
    return data
  })
}

/**
 * 请求哈希：同一份 HTML + 同一批题目 = 同一 hash（可安全重试）；
 * 改 HTML / 改题目 = 新请求（同 key 即冲突，调用方必须换 key）。
 */
function requestHashOf(plan, questions) {
  const sorted = questions.slice().sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return hashJson({
    lessonId: plan.id,
    title: plan.title,
    path: plan.file.relative,
    fingerprint: plan.fingerprint,
    objectives: plan.objectives,
    ...(plan.goals === undefined ? {} : { goals: plan.goals }),
    questions: sorted
  })
}

/**
 * 预检（只读）：页面事实 + 题目合法性 + 幂等键现状 + 请求哈希。
 * dryRun 直接用它出结果；执行用它做「锁内二次核对」的比对基线。
 */
export function precheckCommit(root, input, { page } = {}) {
  const idempotencyKey = assertKey(input.idempotencyKey)
  const questions = questionsOf(input)
  const plan = resolvePublish(root, input, { create: false, repairIndex: false, page })
  const requestHash = requestHashOf(plan, questions)
  const state = plan.archive === null ? null : plan.archive.state
  const existing = state === null ? undefined : state.idempotency?.[idempotencyKey]
  const questionRevisions = Object.create(null)
  for (const question of questions) {
    questionRevisions[question.id] = state?.questions?.[question.id]?.revision ?? 0
  }
  return { idempotencyKey, questions, plan, requestHash, existing, questionRevisions }
}

function replayOf(entry, plan) {
  const stored = entry?.result ?? {}
  return {
    ok: true,
    step: 'idempotent',
    lessonId: stored.lessonId ?? plan.id,
    lessonRevision: stored.lessonRevision ?? 0,
    questionIds: Array.isArray(stored.questionIds) ? stored.questionIds : plan.questionIds,
    idempotent: true,
    committed: false,
    open: { path: plan.file.relative, lessonId: plan.id }
  }
}

/**
 * 执行（或 dryRun 预检）。返回工具可直接用的结果；失败抛 ArchiveError 子类，
 * 由工具层用 `describeError` 翻译成结构化信封。
 *
 * @param {string} root 教学根
 * @param {object} input 工具参数 {lessonId, path, title?, objectives?, questions?, idempotencyKey, dryRun?, }
 * @param {{expectedRevision?: number, precheck?: object}} [options] precheck 供两阶段调用方复用预检结果
 *   （工具层不传；传了也仍会在写锁内二次核对，不会拿预检结果直接写）
 */
export function commitLesson(root, input, { expectedRevision, precheck, page } = {}) {
  const pre = precheck ?? precheckCommit(root, input, { page })
  const open = { path: pre.plan.file.relative, lessonId: pre.plan.id }

  if (input.dryRun === true) {
    return {
      ok: true,
      step: 'precheck',
      lessonId: pre.plan.id,
      lessonRevision: pre.plan.existing?.revision ?? 0,
      questionIds: pre.plan.questionIds,
      // 同一 key 同一份内容已经提交过：正式执行会直接返回既有结果。
      idempotent: pre.existing !== undefined && pre.existing.requestHash === pre.requestHash,
      committed: false,
      dryRun: true,
      open
    }
  }

  // 预检阶段就能判定幂等：同 key 同 hash 不写盘直接回既有结果；异 hash 是冲突。
  if (pre.existing !== undefined) {
    if (pre.existing.requestHash !== pre.requestHash) throw new IdempotencyConflictError(pre.idempotencyKey)
    return replayOf(pre.existing, pre.plan)
  }

  const archive = openArchive(root, { create: true })
  const result = archive.transact('teach_commit', expectedRevision, (draft) => {
    // 锁内再查一次：另一个进程可能在我们预检之后提交了同一个 key。
    const current = draft.idempotency?.[pre.idempotencyKey]
    if (current !== undefined) {
      if (current.requestHash !== pre.requestHash) throw new IdempotencyConflictError(pre.idempotencyKey)
      const stored = current.result ?? {}
      return {
        changes: [],
        result: {
          step: 'idempotent',
          idempotent: true,
          lessonId: stored.lessonId ?? pre.plan.id,
          lessonRevision: stored.lessonRevision ?? 0,
          questionIds: Array.isArray(stored.questionIds) ? stored.questionIds : pre.plan.questionIds
        }
      }
    }

    // Q-C3：锁内二次核对（页面 / 资源 / 页面挂点 / 每道题的当前 revision）。
    const fresh = resolvePublish(root, input, { create: false, repairIndex: false })
    if (fresh.fingerprint !== pre.plan.fingerprint) {
      throw new CommitRejectedError('content-changed', '预检之后课程 HTML 变了；重新预检再提交')
    }
    if (canonicalJson(fresh.objectives) !== canonicalJson(pre.plan.objectives)) {
      throw new CommitRejectedError('content-changed', '预检之后课程目标关联变了；重新预检再提交')
    }
    if (canonicalJson(fresh.assets) !== canonicalJson(pre.plan.assets)) {
      throw new CommitRejectedError('assets-changed', '预检之后课程引用的资源变了；重新预检再提交')
    }
    if (canonicalJson(fresh.questionIds) !== canonicalJson(pre.plan.questionIds)) {
      throw new CommitRejectedError('question-revision-changed', '预检之后页面挂点变了；重新预检再提交')
    }
    for (const question of pre.questions) {
      const currentRevision = draft.questions[question.id]?.revision ?? 0
      if (currentRevision !== pre.questionRevisions[question.id]) {
        throw new CommitRejectedError(
          'question-revision-changed',
          '预检之后题目 ' + question.id + ' 被改过（v' + pre.questionRevisions[question.id] + ' → v' + currentRevision + '）；重新预检再提交'
        )
      }
    }

    const changes = goalChangesOf(draft, pre.plan.goals)
    const published = publishChangeOf(draft, pre.plan)
    if (published.change !== null) changes.push(published.change)
    for (const question of pre.questions) {
      // 内容没变就不写 event：这是修复「重试把 passed 推成 stale」的根，比幂等键更硬。
      if (questionUnchanged(draft.questions[question.id], question)) continue
      changes.push({ type: 'question.upsert', data: question })
    }
    const lessonRevision = published.change === null ? published.existing.revision : published.lessonRevision
    changes.push({
      type: 'commit.recorded',
      data: {
        idempotencyKey: pre.idempotencyKey,
        requestHash: pre.requestHash,
        lessonId: pre.plan.id,
        lessonRevision,
        questionIds: pre.plan.questionIds
      }
    })
    return {
      changes,
      result: {
        step: 'commit',
        idempotent: false,
        lessonId: pre.plan.id,
        lessonRevision,
        questionIds: pre.plan.questionIds
      }
    }
  })

  return {
    ok: true,
    step: result.step,
    lessonId: result.lessonId,
    lessonRevision: result.lessonRevision,
    questionIds: result.questionIds,
    idempotent: result.idempotent === true,
    committed: result.committed === true,
    open
  }
}
