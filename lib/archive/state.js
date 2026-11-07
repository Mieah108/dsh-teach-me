/* 学习档案的领域状态与事件归并。
 *
 * 事件只增不改；状态是事件重放出来的投影。所有写入先经过这里校验，
 * 非法事件在落盘前就被拒绝，避免「先写坏再靠迁移修」。 */

import { ValidationError } from './errors.js'

export const SCHEMA_VERSION = 1
export const EVENT_VERSION = 1

/**
 * 向前兼容事件类型：只有登记在这里的类型，允许在「重放别人的日志」时被跳过。
 *
 * 存在理由只有一个——回滚。新版本往档案里追加的事件（当前是 `run.state`、
 * `commit.recorded` 与 D4 的 `animation.job`），旧版本重放时不认识；若按默认语义当损坏，
 * 回滚代码就等于档案不可用。
 * 这里不改变默认：未知类型仍然 fail，只有登记在册的这一小撮在重放路径上
 * 跳过并显式降级（`Archive.toleratedChanges` + `teach_status` 可见）。
 *
 * 写路径（transact）不走这张表：producer 产出的事件必须当前代码能应用。
 */
export const FORWARD_COMPAT_EVENT_TYPES = new Set(['run.state', 'commit.recorded', 'animation.job'])

export const VERDICTS = ['passed', 'needs_practice', 'needs_review', 'void']
export const SUBMISSION_SOURCES = ['classroom', 'chat', 'offline', 'import', 'other']
export const QUESTION_TYPES = ['choice', 'numeric', 'short', 'explanation', 'design']
export const DETERMINISTIC_TYPES = ['choice', 'numeric', 'short']
/** 动画作业的合法状态：running 是未完成，其余三个是终态（终态不能再回到 running）。 */
export const ANIMATION_JOB_STATES = ['running', 'completed', 'failed', 'killed']
/** 动画作业的模式：与 render 工具的 mode 参数同一口径。 */
export const ANIMATION_JOB_MODES = ['still', 'render']

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceId: null,
    createdAt: null,
    revision: 0,
    lastSeq: 0,
    lastHash: 'genesis',
    mission: null,
    objectives: Object.create(null),
    lessons: Object.create(null),
    questions: Object.create(null),
    submissions: Object.create(null),
    assessments: Object.create(null),
    reviews: Object.create(null),
    materials: Object.create(null),
    selfReports: Object.create(null),
    deferrals: Object.create(null),
    corrections: Object.create(null),
    idempotency: Object.create(null)
    // 注意：不预建 runs 根键。老档案没有它，重放时按「没有 run 状态」处理；
    // 预建会让旧索引与新投影对不上，把一次升级变成一次全量索引重写
    // （与 artifacts 同一模式：投影只由事件决定，不因升级改形状）。
  }
}

/** run 投影的空形状：读取方拿不到 run.state 时用它兜底，避免各处重复写形状。 */
export function emptyRunProjection() {
  return {
    revision: 0,
    stage: null,
    pending: [],
    watermarks: { lastSeq: null, lastHash: null, lessonRevisions: Object.create(null) },
    updatedAt: null
  }
}

/** 读某个 run 的投影；老档案没有 runs 也不报错。 */
export function runStateOf(state, runId) {
  if (state === null || typeof state !== 'object') return null
  const runs = state.runs
  if (runs === null || typeof runs !== 'object') return null
  return runs[runId] ?? null
}

const fail = (message, detail) => {
  throw new ValidationError(message, detail)
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function assertId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(`${label} 不是合法标识：${String(value)}`, { value })
  }
  return value
}

export function assertString(value, label, { max = 20000, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(`${label} 必须是字符串`, { value })
  if (!allowEmpty && value.trim().length === 0) fail(`${label} 不能为空`, { value })
  if (value.length > max) fail(`${label} 太长（${value.length} > ${max}）`, { length: value.length })
  return value
}

export function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) fail(`${label} 必须是 sha256 十六进制`, { value })
  return value
}

export function assertIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`${label} 不是 ISO 时间`, { value })
  return value
}

const requireChange = (change) => {
  if (!isPlainObject(change) || typeof change.type !== 'string' || !isPlainObject(change.data)) {
    fail('事件格式不对：需要 {type, data}', { change })
  }
  return change
}

function copyExisting(target, id, nowIso) {
  return {
    ...target[id],
    ...{},
    createdAt: target[id]?.createdAt ?? nowIso,
    updatedAt: nowIso
  }
}

/**
 * 把一个事件应用到状态上。返回新的状态对象（调用方持有草稿）。
 * 所有字段在这里一次性校验，重放与实时写入走同一条路。
 */
export function applyChange(state, change, meta) {
  const { type, data } = requireChange(change)
  const at = meta.at
  switch (type) {
    case 'fact-check.planned': {
      const id = assertId(data.runId, 'fact-check.runId')
      if (!['none', 'loose', 'moderate', 'strict'].includes(data.level) || !Number.isInteger(data.count) || data.count < 0 || data.count > 4) fail('核查计划不合法')
      state.factCheckRuns ??= Object.create(null)
      state.factCheckRuns[id] = { ...data, createdAt: at }
      return state
    }
    case 'fact-check.reserved': {
      const run = state.factCheckRuns?.[data.runId]
      if (!run || !Number.isInteger(data.slot) || data.slot < 0 || data.slot >= run.count) fail('核查槽位不合法')
      run.reserved ??= []
      if (run.reserved.includes(data.slot)) fail('核查槽位已使用')
      run.reserved.push(data.slot)
      return state
    }
    case 'fact-check.started': {
      const run = state.factCheckRuns?.[data.runId]
      if (!run) fail('核查任务不存在')
      const id = assertString(data.agentId, 'agentId', { max: 200 })
      if (!run.started.includes(id)) run.started.push(id)
      return state
    }
    case 'fact-check.recorded': {
      const run = state.factCheckRuns?.[data.runId]
      if (!run || run.report) fail('核查任务不存在或已完成记录')
      assertHash(data.contentVersion, 'contentVersion')
      state.factChecks ??= Object.create(null)
      state.factChecks[data.lessonId] ??= Object.create(null)
      const report = { ...data, recordedAt: at }
      state.factChecks[data.lessonId][data.contentVersion] = report
      run.report = report
      return state
    }
    case 'learning.initialized': {
      if (state.collectionFormat === 1) return state
      state.collectionFormat = 1
      state.collectionInfo = Object.create(null)
      state.collectionStates = Object.create(null)
      state.collectionInfo.default = { id: 'default', name: '默认集合', archived: false, createdAt: at }
      return state
    }
    case 'lesson.versioned': {
      const id = assertId(data.lessonId, 'lessonId')
      const version = data.version
      const key = assertHash(version?.contentVersion, 'contentVersion')
      if (!state.lessons[id] || version.lesson?.id !== id || !Array.isArray(version.questions) || !Array.isArray(version.materials)) fail('课程版本不合法')
      state.lessonVersions ??= Object.create(null)
      state.lessonVersions[id] ??= Object.create(null)
      state.lessonVersions[id][key] = structuredClone(version)
      if (!state.lessons[id].contentVersion) {
        for (const submission of Object.values(state.submissions)) {
          if (submission.lessonId === id && submission.lessonRevision === version.lesson.revision) submission.contentVersion = key
        }
      }
      state.lessons[id].revision = version.lesson.revision
      state.lessons[id].contentVersion = key
      state.lessons[id].artifactRoot = version.artifactRoot
      return state
    }
    case 'collection.created': {
      const id = assertId(data.id, 'collection.id')
      if (id === 'default' || state.collectionInfo?.[id]) fail('集合已存在')
      const child = emptyState()
      if (data.sourceId !== null) {
        const source = data.sourceId === 'default' ? state : state.collectionStates?.[data.sourceId]
        if (!source) fail('源集合不存在')
        for (const key of ['lessons', 'questions', 'materials', 'objectives', 'lessonVersions', 'factChecks']) child[key] = Object.assign(Object.create(null), structuredClone(source[key] ?? {}))
        child.mission = structuredClone(source.mission)
      }
      state.collectionInfo[id] = { id, name: assertString(data.name, 'collection.name', { max: 100 }), archived: false, createdAt: at }
      state.collectionStates[id] = child
      return state
    }
    case 'collection.updated': {
      const id = assertId(data.id, 'collection.id')
      if (!state.collectionInfo?.[id]) fail('集合不存在')
      state.collectionInfo[id] = { ...state.collectionInfo[id], name: assertString(data.name, 'collection.name', { max: 100 }), archived: data.archived === true, updatedAt: at }
      return state
    }
    case 'collection.lesson': {
      const target = data.id === 'default' ? state : state.collectionStates?.[data.id]
      if (!target || state.collectionInfo?.[data.id]?.archived) fail('集合不存在或已归档')
      const version = data.version
      const id = assertId(data.lessonId, 'lessonId')
      assertHash(version?.contentVersion, 'contentVersion')
      if (version.lesson?.id !== id) fail('课程版本不匹配')
      target.lessons[id] = { ...structuredClone(version.lesson), artifactRoot: version.artifactRoot }
      for (const [key, question] of Object.entries(target.questions)) if (question.lessonId === id) delete target.questions[key]
      for (const question of version.questions) target.questions[question.id] = structuredClone(question)
      for (const material of version.materials) target.materials[material.id] = structuredClone(material)
      target.lessonVersions ??= Object.create(null)
      target.lessonVersions[id] ??= Object.create(null)
      target.lessonVersions[id][version.contentVersion] = structuredClone(version)
      if (data.factCheck) {
        target.factChecks ??= Object.create(null)
        target.factChecks[id] ??= Object.create(null)
        target.factChecks[id][version.contentVersion] = structuredClone(data.factCheck)
      }
      return state
    }
    case 'collection.transaction': {
      const id = assertId(data.id, 'collection.id')
      const target = state.collectionStates?.[id]
      if (!target || !Array.isArray(data.changes)) fail('集合事务不合法')
      for (const nested of data.changes) {
        if (/^(collection\.|learning\.)/.test(nested.type)) fail('不允许嵌套集合管理事件')
        applyChange(target, nested, meta)
      }
      return state
    }
    case 'workspace.initialized': {
      const workspaceId = assertString(data.workspaceId, 'workspaceId', { max: 128 })
      const createdAt = assertIso(data.createdAt, 'createdAt')
      if (state.workspaceId !== null && state.workspaceId !== workspaceId) {
        fail('工作区身份不一致：不能把另一个工作区的事件并进来', { current: state.workspaceId, incoming: workspaceId })
      }
      state.workspaceId = workspaceId
      state.createdAt = createdAt
      return state
    }
    case 'mission.updated': {
      const text = assertString(data.text, 'mission.text', { max: 100000 })
      const previous = state.mission?.revision ?? 0
      state.mission = {
        text,
        revision: previous + 1,
        sha256: assertHash(data.sha256, 'mission.sha256'),
        confirmedAt: data.confirmedAt === undefined ? null : assertIso(data.confirmedAt, 'mission.confirmedAt'),
        updatedAt: at
      }
      return state
    }
    case 'objective.upsert': {
      const id = assertId(data.id, 'objective.id')
      const base = copyExisting(state.objectives, id, at)
      state.objectives[id] = {
        ...base,
        id,
        title: assertString(data.title, 'objective.title', { max: 500 }),
        description: data.description === undefined ? '' : assertString(data.description, 'objective.description', { max: 5000, allowEmpty: true }),
        acceptance: Array.isArray(data.acceptance) ? data.acceptance.map((item) => assertString(item, 'objective.acceptance[]', { max: 1000 })) : [],
        prerequisites: Array.isArray(data.prerequisites) ? data.prerequisites.map((item) => assertId(item, 'objective.prerequisites[]')) : [],
        tags: Array.isArray(data.tags) ? data.tags.map((item) => assertString(item, 'objective.tags[]', { max: 100 })) : [],
        status: data.status === 'retired' ? 'retired' : 'active'
      }
      return state
    }
    case 'lesson.published': {
      const id = assertId(data.id, 'lesson.id')
      const revision = Number(data.revision)
      if (!Number.isInteger(revision) || revision < 1) fail('lesson.revision 必须是正整数', { revision })
      const base = copyExisting(state.lessons, id, at)
      state.lessons[id] = {
        ...base,
        id,
        title: assertString(data.title, 'lesson.title', { max: 500 }),
        path: assertString(data.path, 'lesson.path', { max: 2000 }),
        revision,
        fingerprint: assertHash(data.fingerprint, 'lesson.fingerprint'),
        assets: Array.isArray(data.assets) ? data.assets : [],
        // 课堂挂点：页面里 quiz 的 data-question-id（去重、排序）。
        // 0.3.1 之前的 journal 没有这个字段，重放时按空数组处理，不能因此判日志损坏。
        questionIds: Array.isArray(data.questionIds)
          ? [...new Set(data.questionIds.map((item) => assertId(item, 'lesson.questionIds[]')))].sort()
          : [],
        objectives: Array.isArray(data.objectives) ? data.objectives.map((item) => assertId(item, 'lesson.objectives[]')) : [],
        publishedAt: assertIso(data.publishedAt, 'lesson.publishedAt')
      }
      return state
    }
    case 'question.upsert': {
      const id = assertId(data.id, 'question.id')
      const lessonId = assertId(data.lessonId, 'question.lessonId')
      if (state.lessons[lessonId] === undefined) fail(`题目所属课程不存在：${lessonId}`, { lessonId })
      const type = data.type
      if (!QUESTION_TYPES.includes(type)) fail(`题目类型不支持：${String(type)}`, { type })
      if (DETERMINISTIC_TYPES.includes(type) && data.answer === undefined) {
        fail(`${type} 题必须带标准答案，否则只能记为待复核`, { id })
      }
      const previous = state.questions[id]
      const base = copyExisting(state.questions, id, at)
      state.questions[id] = {
        ...base,
        id,
        lessonId,
        revision: (previous?.revision ?? 0) + 1,
        objectiveId: data.objectiveId === undefined || data.objectiveId === null ? null : assertId(data.objectiveId, 'question.objectiveId'),
        type,
        prompt: assertString(data.prompt, 'question.prompt', { max: 20000 }),
        prerequisite: data.prerequisite === undefined ? '' : assertString(data.prerequisite, 'question.prerequisite', { max: 5000, allowEmpty: true }),
        options: Array.isArray(data.options) ? data.options : [],
        answer: data.answer === undefined ? null : data.answer,
        rubric: Array.isArray(data.rubric) ? data.rubric : [],
        materials: Array.isArray(data.materials) ? data.materials.map((item) => assertId(item, 'question.materials[]')) : [],
        status: data.status === 'retired' ? 'retired' : 'active'
      }
      return state
    }
    case 'submission.recorded': {
      const id = assertId(data.id, 'submission.id')
      if (state.submissions[id] !== undefined) fail(`提交 id 已存在：${id}`, { id })
      const questionId = assertId(data.questionId, 'submission.questionId')
      const source = SUBMISSION_SOURCES.includes(data.source) ? data.source : 'other'
      const idempotencyKey = assertString(data.idempotencyKey, 'submission.idempotencyKey', { max: 500 })
      const requestHash = assertHash(data.requestHash, 'submission.requestHash')
      const existing = state.idempotency[idempotencyKey]
      if (existing !== undefined && existing.requestHash !== requestHash) {
        fail(`幂等键 ${idempotencyKey} 已经用于另一份内容`, { idempotencyKey })
      }
      state.submissions[id] = {
        id,
        questionId,
        questionRevision: Number.isInteger(data.questionRevision) ? data.questionRevision : 0,
        lessonId: data.lessonId === undefined || data.lessonId === null ? null : assertId(data.lessonId, 'submission.lessonId'),
        lessonRevision: Number.isInteger(data.lessonRevision) ? data.lessonRevision : 0,
        ...(data.contentVersion ? { contentVersion: assertHash(data.contentVersion, 'submission.contentVersion') } : {}),
        rawAnswer: assertString(data.rawAnswer, 'submission.rawAnswer', { max: 100000 }),
        source,
        hintsUsed: data.hintsUsed === true,
        showedSolution: data.showedSolution === true,
        idempotencyKey,
        requestHash,
        submittedAt: assertIso(data.submittedAt, 'submission.submittedAt'),
        status: 'pending',
        latestAssessmentId: null
      }
      state.idempotency[idempotencyKey] = {
        kind: 'submission',
        targetId: id,
        requestHash,
        at
      }
      return state
    }
    case 'assessment.recorded': {
      const id = assertId(data.id, 'assessment.id')
      const submissionId = assertId(data.submissionId, 'assessment.submissionId')
      const submission = state.submissions[submissionId]
      if (submission === undefined) fail(`没有这次提交，不能记录评估：${submissionId}`, { submissionId })
      if (!VERDICTS.includes(data.verdict)) fail(`评估结论不支持：${String(data.verdict)}`, { verdict: data.verdict })
      const criteria = Array.isArray(data.criteria)
        ? data.criteria.map((item) => ({
            id: assertString(item?.id, 'assessment.criteria[].id', { max: 200 }),
            met: item?.met === true,
            evidence: item?.evidence === undefined ? '' : assertString(item.evidence, 'assessment.criteria[].evidence', { max: 10000, allowEmpty: true })
          }))
        : []
      if (data.verdict === 'passed') {
        if (criteria.length === 0) fail('没有评分标准的「通过」不算通过', { submissionId })
        if (criteria.some((item) => !item.met || item.evidence.trim().length === 0)) {
          fail('有关键标准没满足或没有独立证据，不能记通过', { submissionId })
        }
      }
      state.assessments[id] = {
        id,
        submissionId,
        questionId: submission.questionId,
        questionRevision: Number.isInteger(data.questionRevision) ? data.questionRevision : submission.questionRevision,
        verdict: data.verdict,
        criteria,
        method: isPlainObject(data.method) ? data.method : { kind: 'unknown' },
        materialsFingerprint: data.materialsFingerprint === undefined || data.materialsFingerprint === null || data.materialsFingerprint === '' ? null : assertString(data.materialsFingerprint, 'assessment.materialsFingerprint', { max: 200 }),
        reason: data.reason === undefined ? '' : assertString(data.reason, 'assessment.reason', { max: 10000, allowEmpty: true }),
        createdAt: at,
        voidedAt: null
      }
      submission.status = data.verdict === 'needs_review' ? 'needs_review' : 'evaluated'
      submission.latestAssessmentId = id
      return state
    }
    case 'assessment.voided': {
      const id = assertId(data.id, 'assessment.id')
      const assessment = state.assessments[id]
      if (assessment === undefined) fail(`没有这条评估：${id}`, { id })
      assessment.voidedAt = at
      assessment.voidReason = assertString(data.reason, 'assessment.voidReason', { max: 5000 })
      const submission = state.submissions[assessment.submissionId]
      if (submission !== undefined && submission.latestAssessmentId === id) submission.latestAssessmentId = null
      return state
    }
    case 'question.corrected': {
      const id = assertId(data.id, 'question.id')
      const question = state.questions[id]
      if (question === undefined) fail(`没有这道题：${id}`, { id })
      question.correctionNote = assertString(data.note, 'question.correctionNote', { max: 5000 })
      state.corrections[assertId(data.correctionId, 'correction.id')] = {
        id: data.correctionId,
        targetType: 'question',
        targetId: id,
        action: 'correct',
        reason: question.correctionNote,
        at
      }
      return state
    }
    case 'review.scheduled': {
      const id = assertId(data.id, 'review.id')
      const intervalDays = Number(data.intervalDays)
      if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 3650) {
        fail('复习间隔必须是 1–3650 天', { intervalDays })
      }
      const base = copyExisting(state.reviews, id, at)
      state.reviews[id] = {
        ...base,
        id,
        questionId: data.questionId === undefined || data.questionId === null ? null : assertId(data.questionId, 'review.questionId'),
        objectiveId: data.objectiveId === undefined || data.objectiveId === null ? null : assertId(data.objectiveId, 'review.objectiveId'),
        dueAt: assertIso(data.dueAt, 'review.dueAt'),
        intervalDays,
        state: 'scheduled',
        history: Array.isArray(base.history) ? base.history : []
      }
      return state
    }
    case 'review.finished': {
      const id = assertId(data.id, 'review.id')
      const review = state.reviews[id]
      if (review === undefined) fail(`没有这条复习：${id}`, { id })
      const result = data.result
      if (result !== 'completed' && result !== 'skipped') fail('复习结果只能是 completed 或 skipped', { result })
      review.state = result
      review.finishedAt = at
      review.history = Array.isArray(review.history) ? review.history : []
      review.history.push({ at, result })
      return state
    }
    case 'material.indexed': {
      const id = assertId(data.id, 'material.id')
      const base = copyExisting(state.materials, id, at)
      state.materials[id] = {
        ...base,
        id,
        kind: data.kind === 'url' ? 'url' : 'file',
        path: data.path === undefined || data.path === null ? null : assertString(data.path, 'material.path', { max: 2000 }),
        url: data.url === undefined || data.url === null ? null : assertString(data.url, 'material.url', { max: 2000 }),
        title: assertString(data.title, 'material.title', { max: 500 }),
        location: data.location === undefined ? '' : assertString(data.location, 'material.location', { max: 500, allowEmpty: true }),
        excerpt: data.excerpt === undefined ? '' : assertString(data.excerpt, 'material.excerpt', { max: 20000, allowEmpty: true }),
        version: data.version === undefined ? '' : assertString(data.version, 'material.version', { max: 200, allowEmpty: true }),
        retrievedAt: data.retrievedAt === undefined ? at : assertIso(data.retrievedAt, 'material.retrievedAt'),
        sha256: data.sha256 === undefined || data.sha256 === null ? null : assertHash(data.sha256, 'material.sha256'),
        status: data.status === 'verified' ? 'verified' : 'unverified',
        verifiedAt: data.verifiedAt === undefined || data.verifiedAt === null ? null : assertIso(data.verifiedAt, 'material.verifiedAt')
      }
      return state
    }
    case 'self_report.recorded': {
      const id = assertId(data.id, 'selfReport.id')
      state.selfReports[id] = {
        id,
        questionId: data.questionId === undefined || data.questionId === null ? null : assertId(data.questionId, 'selfReport.questionId'),
        objectiveId: data.objectiveId === undefined || data.objectiveId === null ? null : assertId(data.objectiveId, 'selfReport.objectiveId'),
        claim: assertString(data.claim, 'selfReport.claim', { max: 2000 }),
        at
      }
      return state
    }
    case 'deferral.recorded': {
      const id = assertId(data.id, 'deferral.id')
      state.deferrals[id] = {
        id,
        questionId: data.questionId === undefined || data.questionId === null ? null : assertId(data.questionId, 'deferral.questionId'),
        objectiveId: data.objectiveId === undefined || data.objectiveId === null ? null : assertId(data.objectiveId, 'deferral.objectiveId'),
        reason: data.reason === undefined ? '' : assertString(data.reason, 'deferral.reason', { max: 5000, allowEmpty: true }),
        // 暂停到什么时候是可选的（P4 新增）；旧日志没有这个字段时按 null 处理。
        until: data.until === undefined || data.until === null ? null : assertIso(data.until, 'deferral.until'),
        at
      }
      return state
    }
    case 'lesson.artifact': {
      // 产物事件是后加的：老日志没有它，投影里就没有 artifacts 字段（不预建、不强制迁移）。
      const lessonId = data.lessonId === undefined || data.lessonId === null ? null : assertId(data.lessonId, 'artifact.lessonId')
      // 产物绑课程版本（0.6.4-D4 补的字段）："这件产物是对哪一版课程渲染的"。
      // 老日志没有它，重放时按 null 处理，不因此判日志损坏，也不给旧事件补写。
      const lessonRevision = assertOptionalLessonRevision(data.lessonRevision, 'artifact.lessonRevision')
      const artifactPath = assertString(data.path, 'artifact.path', { max: 2000 })
      const digest = data.sha256 === undefined || data.sha256 === null || data.sha256 === '' ? null : assertHash(data.sha256, 'artifact.sha256')
      const frames = assertOptionalCount(data.frames, 'artifact.frames')
      const durationMs = assertOptionalCount(data.durationMs, 'artifact.durationMs')
      // 静帧产物按帧号区分（成片为 null）；旧 journal 没有这一位，重放时按 null 处理，
      // 不因此判日志损坏，也不给旧事件补写。
      const frame = assertOptionalCount(data.frame, 'artifact.frame')
      let fps = null
      if (data.fps !== undefined && data.fps !== null) {
        fps = Number(data.fps)
        if (!Number.isFinite(fps) || fps <= 0) fail('artifact.fps 必须是正数', { value: data.fps })
      }
      if (isPlainObject(state.artifacts) !== true) state.artifacts = {}
      state.artifacts[artifactKeyOf(lessonId, artifactPath)] = {
        lessonId,
        lessonRevision,
        path: artifactPath,
        sha256: digest,
        frames,
        durationMs,
        fps,
        frame,
        at: data.at === undefined || data.at === null ? at : assertIso(data.at, 'artifact.at'),
        updatedAt: at
      }
      return state
    }
    case 'run.state': {
      // run 级教学状态：阶段、待确认项、数据水位。只放恢复必需的东西，
      // 不放提示词、对话或工具输出（那些不进档案）。
      const runId = assertId(data.runId, 'run.runId')
      const previous = runStateOf(state, runId)
      const expected = (previous?.revision ?? 0) + 1
      // 不做类型强转：journal 里 runRevision 必须是 JSON 正整数，字符串 "1" 也算写坏。
      const runRevision = data.runRevision
      if (!Number.isInteger(runRevision) || runRevision !== expected) {
        // 倒退/跳号都必须 fail：run 级 CAS 靠这条数，放过去等于让两个会话互相覆盖。
        fail(`run.runRevision 必须等于上一次 +1（期望 ${expected}，实际 ${String(data.runRevision)}）`, {
          runId,
          expected,
          runRevision: data.runRevision
        })
      }
      const stage = assertString(data.stage, 'run.stage', { max: 64 })
      const pending = assertRunPending(data.pending)
      const watermarks = assertRunWatermarks(data.watermarks)
      const atIso = data.at === undefined || data.at === null ? at : assertIso(data.at, 'run.at')
      if (isPlainObject(state.runs) !== true) state.runs = Object.create(null)
      state.runs[runId] = { revision: runRevision, stage, pending, watermarks, updatedAt: atIso }
      return state
    }
    case 'animation.job': {
      // 动画渲染作业的持久化（0.6.4-D4）：起手写一条 running，结算时同 jobId 再写终态。
      // 进程内互斥表重启即清空，档案里这两条让重启后还能回答「上次到哪一步」。
      // 只记作业身份、工程根、产物路径与状态：不放渲染输出正文（那不是档案该存的东西）。
      const jobId = assertId(data.jobId, 'animation.jobId')
      const root = assertString(data.root, 'animation.root', { max: 2000 })
      const composition = assertString(data.composition, 'animation.composition', { max: 128 })
      const mode = ANIMATION_JOB_MODES.includes(data.mode) ? data.mode : null
      if (mode === null) fail(`animation.mode 只能是 still 或 render：${String(data.mode)}`, { mode: data.mode })
      const output = assertString(data.output, 'animation.output', { max: 2000 })
      const lessonRevision = assertOptionalLessonRevision(data.lessonRevision, 'animation.lessonRevision')
      if (!ANIMATION_JOB_STATES.includes(data.state)) {
        fail(`animation.state 不支持：${String(data.state)}`, { state: data.state })
      }
      if (isPlainObject(state.animationJobs) !== true) state.animationJobs = Object.create(null)
      const previous = state.animationJobs[jobId]
      if (previous !== undefined && previous.root !== root) {
        // 一个 job id 只能属于一个工程：认错工程会让 inspect 报出别人的未完成作业。
        fail(`animation.jobId ${jobId} 已经记在另一个工程上（${previous.root}）`, { jobId, root, previousRoot: previous.root })
      }
      if (previous !== undefined && previous.state !== 'running' && data.state === 'running') {
        // 终态写下去就是历史：事件只追加，不能靠后来的一条把它改回 running。
        fail(`animation.jobId ${jobId} 已经是终态（${previous.state}），不能再回到 running`, { jobId, previous: previous.state, state: data.state })
      }
      const atIso = data.at === undefined || data.at === null ? at : assertIso(data.at, 'animation.at')
      state.animationJobs[jobId] = {
        jobId,
        root,
        composition,
        mode,
        output,
        // 课程版本在起手时定格：终态事件没带就沿用起手时那一版；老日志没有这个字段按 null 兼容。
        lessonRevision: lessonRevision ?? previous?.lessonRevision ?? null,
        state: data.state,
        startedAt: previous?.startedAt ?? atIso,
        updatedAt: atIso
      }
      return state
    }
    case 'commit.recorded': {
      // 一次 commit 的幂等记录：同 key 同 hash 返回既有结果，异 hash 是冲突（绝不静默覆盖）。
      const key = assertString(data.idempotencyKey, 'commit.idempotencyKey', { max: 500 })
      const requestHash = assertHash(data.requestHash, 'commit.requestHash')
      const lessonId = assertId(data.lessonId, 'commit.lessonId')
      const lessonRevision = data.lessonRevision
      if (!Number.isInteger(lessonRevision) || lessonRevision < 1) {
        fail('commit.lessonRevision 必须是正整数', { lessonRevision: data.lessonRevision })
      }
      const questionIds = Array.isArray(data.questionIds) ? data.questionIds.map((item) => assertId(item, 'commit.questionIds[]')) : []
      if (questionIds.length > 200) fail(`commit.questionIds 最多 200 项（现在 ${questionIds.length}）`, { length: questionIds.length })
      const existing = state.idempotency[key]
      if (existing !== undefined && existing.requestHash !== requestHash) {
        fail(`幂等键 ${key} 已经用于另一份内容`, { idempotencyKey: key })
      }
      state.idempotency[key] = {
        kind: 'commit',
        targetId: lessonId,
        requestHash,
        result: { lessonId, lessonRevision, questionIds },
        at
      }
      return state
    }

    default: {
      // 打上明确标记：只有「本版本不认识这个类型」才允许重放时跳过。
      // 已知类型但载荷坏掉是日志损坏，必须 fail —— 不能被兼容层顺手吞掉。
      fail(`未知事件类型：${type}`, { type, kind: 'unknown-event-type' })
    }
  }
}

/** 当前评估是否仍适用于这道题/这课/这批材料。返回原因，空表示有效。 */
export function staleReason(state, assessment) {
  if (assessment === undefined || assessment === null) return '还没有评估'
  if (assessment.voidedAt !== null && assessment.voidedAt !== undefined) return '评估已作废'
  const question = state.questions[assessment.questionId]
  if (question === undefined) return '题目已不在档案里'
  if (question.revision !== assessment.questionRevision) return `题目已改版（评估 v${assessment.questionRevision}，现在 v${question.revision}）`
  const submission = state.submissions[assessment.submissionId]
  const lesson = submission?.lessonId === null || submission?.lessonId === undefined ? undefined : state.lessons[submission.lessonId]
  if (lesson !== undefined && submission.contentVersion && lesson.contentVersion !== submission.contentVersion) return '课程内容已改版'
  if (lesson !== undefined && lesson.revision !== submission.lessonRevision) return '课程已改版'
  if (assessment.materialsFingerprint !== null) {
    const current = materialsFingerprintOf(state, question.materials ?? [])
    if (current !== assessment.materialsFingerprint) return '材料指纹变了'
  }
  return ''
}

/**
 * 一条提交的「结论视图」：历史结论 + 当前是否仍有效 + 失效原因。
 * 所有对外出口（课堂状态、侧栏列表、离线进度、汇总统计）都走这一个口径，
 * 避免同一条评估在不同界面上一处判失效、一处照旧报 passed。
 */
export function verdictViewOf(state, submission) {
  const latestId = submission === undefined || submission === null ? null : submission.latestAssessmentId ?? null
  const assessment = latestId === null ? null : state.assessments[latestId] ?? null
  const verdict = assessment === null ? null : assessment.verdict
  const reason = staleReason(state, assessment)
  const stale = reason !== '' && reason !== '还没有评估'
  return {
    verdict,
    verdictAt: assessment === null ? null : assessment.createdAt ?? null,
    stale,
    staleReason: stale ? reason : '',
    // 只有「仍有效」的结论才算数；历史结论保留在 verdict 里，供界面标「已失效」。
    effectiveVerdict: verdict === null || stale ? null : verdict
  }
}

export function materialsFingerprintOf(state, materialIds) {
  const parts = []
  for (const id of materialIds ?? []) {
    const material = state.materials[id]
    parts.push(material === undefined ? `${id}:missing` : `${id}:${material.sha256 ?? 'unverified'}`)
  }
  return parts.join('|')
}

/** 给报告/诊断用的计数；不参与判定。 */
export function summarize(state) {
  const submissions = Object.values(state.submissions)
  return {
    workspaceId: state.workspaceId,
    revision: state.revision,
    lessons: Object.keys(state.lessons).length,
    questions: Object.keys(state.questions).length,
    submissions: submissions.length,
    assessed: submissions.filter((item) => item.latestAssessmentId !== null).length,
    // 通过只数「仍有效」的结论：题目改版、课程改版、材料变化或已作废的旧评估不再算通过。
    passed: submissions.filter((item) => verdictViewOf(state, item).effectiveVerdict === 'passed').length,
    stalePassed: submissions.filter((item) => {
      const view = verdictViewOf(state, item)
      return view.verdict === 'passed' && view.effectiveVerdict !== 'passed'
    }).length,
    // 待批改：开放题提交后还没有任何评估。
    pendingGrading: submissions.filter((item) => item.status === 'pending').length,
    needsReview: submissions.filter((item) => item.status === 'needs_review').length,
    reviews: Object.keys(state.reviews).length,
    materials: Object.keys(state.materials).length,
    // 自报与暂缓单独计数：它们是学习者的动作，不是评估通过（P4）。
    selfReports: Object.keys(state.selfReports).length,
    deferrals: Object.keys(state.deferrals).length
  }
}

/* —————————————————————————— run 状态（run.state）—————————————————————————— */

/** 待确认项：≤5 条，每条 {id, kind, label?}；label 是给人看的一句话。 */
function assertRunPending(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) fail('run.pending 必须是数组', { value })
  if (value.length > 5) fail(`run.pending 最多 5 条（现在 ${value.length}）`, { length: value.length })
  return value.map((item, index) => {
    if (!isPlainObject(item)) fail(`run.pending[${index}] 必须是对象`, { item })
    const normalized = {
      id: assertId(item.id, `run.pending[${index}].id`),
      kind: assertString(item.kind, `run.pending[${index}].kind`, { max: 64 })
    }
    if (item.label !== undefined && item.label !== null) {
      normalized.label = assertString(item.label, `run.pending[${index}].label`, { max: 120, allowEmpty: true })
    }
    return normalized
  })
}

/** 数据水位：只记录，不参与并发判定；课程版本最多 8 项。 */
function assertRunWatermarks(value) {
  if (!isPlainObject(value)) fail('run.watermarks 必须是对象', { value })
  const lastSeq = value.lastSeq === undefined || value.lastSeq === null ? null : Number(value.lastSeq)
  if (lastSeq !== null && (!Number.isInteger(lastSeq) || lastSeq < 0)) {
    fail('run.watermarks.lastSeq 必须是非负整数或空', { value: value.lastSeq })
  }
  const lastHash = value.lastHash === undefined || value.lastHash === null ? null : value.lastHash
  if (lastHash !== null && lastHash !== 'genesis' && !HASH_PATTERN.test(lastHash)) {
    fail('run.watermarks.lastHash 必须是 sha256 十六进制（或 genesis / 空）', { value: value.lastHash })
  }
  const revisions = value.lessonRevisions === undefined || value.lessonRevisions === null ? {} : value.lessonRevisions
  if (!isPlainObject(revisions)) fail('run.watermarks.lessonRevisions 必须是对象', { value: revisions })
  const ids = Object.keys(revisions)
  if (ids.length > 8) fail(`run.watermarks.lessonRevisions 最多 8 项（现在 ${ids.length}）`, { length: ids.length })
  const normalized = Object.create(null)
  for (const id of ids) {
    assertId(id, 'run.watermarks.lessonRevisions 的键')
    const revision = Number(revisions[id])
    if (!Number.isInteger(revision) || revision < 1) {
      fail('run.watermarks.lessonRevisions 的值必须是正整数', { id, revision: revisions[id] })
    }
    normalized[id] = revision
  }
  return { lastSeq, lastHash, lessonRevisions: normalized }
}

/* —————————————————————————— 动画产物（lesson.artifact）—————————————————————————— */

/** 产物投影的键：同一课（或未关联课程）的同一路径只保留最新一条。 */
export function artifactKeyOf(lessonId, artifactPath) {
  return (lessonId === null || lessonId === undefined ? '' : lessonId) + '\n' + String(artifactPath)
}

/** 可选的课程版本：必须是正整数；空值给 null（老日志没有这个字段）。 */
function assertOptionalLessonRevision(value, label) {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 1) fail(`${label} 必须是正整数`, { value })
  return value
}

/** 可选的非负整数；空值给 null（帧数、毫秒这类字段）。 */
function assertOptionalCount(value, label) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) fail(`${label} 必须是非负整数`, { value })
  return number
}

/**
 * 产物投影的读取入口（派生数据，不参与判定）。
 * 老档案没有 artifacts 字段时返回空数组，不在这里补写状态 —— 投影只由事件决定。
 */
export function artifactsOf(state, { lessonId } = {}) {
  const all = Object.values(state?.artifacts ?? {})
  const picked = lessonId === undefined ? all : all.filter((item) => item.lessonId === lessonId)
  return picked.sort(
    (a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')) || String(a.path ?? '').localeCompare(String(b.path ?? ''))
  )
}

/* —————————————————————————— 动画渲染作业（animation.job）—————————————————————————— */

/**
 * 动画作业投影的读取入口（派生数据，不参与判定）。
 * 老档案没有 animationJobs 字段时返回空数组，不在这里补写状态 —— 投影只由事件决定。
 * 排序按 updatedAt：最后一项就是「上次到哪一步」。
 * @param {object} state 档案状态
 * @param {{root?: string, unfinished?: boolean}} [options] 按工程根筛；unfinished=true 只要 running
 */
export function animationJobsOf(state, { root, unfinished = false } = {}) {
  const all = Object.values(state?.animationJobs ?? {})
  const picked = all.filter((job) => {
    if (job === null || typeof job !== 'object') return false
    if (root !== undefined && job.root !== root) return false
    if (unfinished === true && job.state !== 'running') return false
    return true
  })
  return picked.sort(
    (a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')) || String(a.jobId ?? '').localeCompare(String(b.jobId ?? ''))
  )
}
