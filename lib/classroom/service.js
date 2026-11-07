import { withLearningScope, learningScope } from '../archive/learning-scope.js'
import { manageCollection, collectionList, collectionState } from '../archive/collections.js'
import { readReading, saveReading, readingSummary } from '../archive/reading.js'
/* 课堂后端：受认证的资源路由 + RPC。
 *
 * 路由挂在宿主已有 WebServer 的 /teach-classroom 前缀下，不另开端口；
 * 一个 URL 同时承载「能力票 + 工作区相对路径」。RPC 只接受 owner Peer，
 * 业务层再校验会话、工作区、课程 revision 与题目归属。 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { openArchive, tryOpenArchive } from '../archive/store.js'
import { recordSubmission } from '../archive/operations.js'
import { staleReason, verdictViewOf } from '../archive/state.js'
import { classroomHeaders, createAssetCache, injectBaseHref, injectClassroomHtml, lessonOf, mimeFor, parseRange } from './assets.js'
import { buildOffline, importSelfReports, lessonQuestionsOf, questionView } from './offline.js'
import { createSecret, decodeRelative, encodeRelative, issueToken, verifyToken } from './token.js'
import { resolveTeachingRoot } from '../workspace.js'

export const ROUTE_PREFIX = '/teach-classroom'

/** 课堂回传的票据头：票只从请求头取，不接受 body 里的 sessionId 当身份依据。 */
export const TICKET_HEADER = 'x-teach-classroom'
/** 每 endpoint + 每 session 的进程内令牌桶：默认 60 次/分钟。 */
const DEFAULT_RPC_LIMIT = 60
const DEFAULT_RPC_WINDOW_MS = 60 * 1000
/** 一次离线进度导入最多接受的条数：超出即拒，且一条都不写。 */
const IMPORT_MAX_ITEMS = 500
/** 导入条目的 id 规则必须与档案层一致，否则批量事务会在写入阶段抛错。 */
const IMPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
/** 需要能力票的端点：都在「已经打开某节课」之后发生，票能给它们绑定会话/课程/版本。 */
// classroom/pending 目前没有真实客户端直调（侧栏用不到、页面 bridge 只发 submit/status），
// 收紧时不给它加票要求，避免它变成「只能由测试调用」的死代码；仍走宿主围栏 + 会话存在性 + 限频。
const TICKET_ENDPOINTS = new Set(['classroom/submit', 'classroom/status', 'classroom/export', 'classroom/import', 'classroom/reading'])
/** 失败码 → HTTP 状态；未列出的业务失败仍按 200 + {ok:false} 返回，保持旧客户端兼容。 */
const STATUS_BY_CODE = new Map([
  ['unauthorized', 401],
  ['ticket-invalid', 401],
  ['ticket-expired', 410],
  ['forbidden', 403],
  ['workspace-mismatch', 403],
  ['session-mismatch', 403],
  ['lesson-mismatch', 403],
  ['lesson-revision-stale', 410],
  ['rate-limited', 429],
  ['import-too-many', 413],
  ['import-lesson', 403],
  ['import-workspace', 403],
  ['import-revision', 410],
  ['import-fingerprint', 410],
  ['import-question-revision', 410]
])

const statusOf = (result) => (result !== null && typeof result === 'object' && result.ok === false ? STATUS_BY_CODE.get(result.error?.code) ?? 200 : 200)

/** 二级 .html（非课程首页）不能按 text/html 直出：它会以宿主 origin 执行脚本。 */
const isMarkupFile = (file) => /\.html?$/i.test(String(file))

/** 非 HTML 资源的 Cache-Control：private 只允许浏览器私有缓存；1 小时够一堂课，也让重新打开尽快拿到新字节。 */
const ASSET_CACHE_CONTROL = 'private, max-age=3600'

/** 资源路由的档案投影缓存上限：一个进程通常只读少数几个教学根。 */
const ARCHIVE_PROJECTION_MAX_ENTRIES = 8

/** 文件 stat 指纹；文件不存在也要有稳定值（档案被删除/重建时用来判失效）。 */
function statStamp(file) {
  try {
    const stat = fs.statSync(file)
    return stat.mtimeMs + ':' + stat.size + ':' + stat.ino
  } catch {
    return 'missing'
  }
}

/**
 * 资源路由专用的档案投影缓存（进程内、不落盘）。
 *
 * 每个资源请求都 openArchive 会把日志整份重放 + 校验哈希链，2.1 MB 的 MathJax 旁边还挂着
 * 几十个 css/js/字体请求时这是主要成本。这里按工作区根缓存上一次的档案投影，用
 * workspace.json / index.json 的 stat 指纹做失效探针：任何一次档案提交（发布、登记题目、
 * 交作业）都会原子替换 index.json，指纹一变就重新打开，因此投影不会把旧题目/旧 revision
 * 带进课堂页。失效口径 = lessonRevision 变化（新票 → 新 revision → 缓存键不同）、
 * workspaceId 变化（身份文件指纹变）、进程重启。
 * 只缓存「打开成功」的结果；打开失败照常抛给调用方（404 archive-unavailable）。
 * 这个工厂同时是测试注入点：测试传实例进来读 stats().replays 当 openArchive 计数桩。
 */
export function createArchiveProjectionCache({ maxEntries = ARCHIVE_PROJECTION_MAX_ENTRIES } = {}) {
  const limit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : ARCHIVE_PROJECTION_MAX_ENTRIES
  const entries = new Map()
  const stats = { replays: 0, hits: 0 }
  // 探针用 archive.path 而不是 archiveDirOf(root)：旧布局（0.5.0 的 .teach）在迁移失败时
  // 档案实际还在旧目录里，按新路径取指纹会永远 'missing'，缓存就再也不会失效。
  const probeOf = (dir) => ({ identity: statStamp(path.join(dir, 'workspace.json')), index: statStamp(path.join(dir, 'index.json')) })
  const sameProbe = (cached, current) => cached.identity === current.identity && cached.index === current.index
  return {
    /** 取档案投影：索引与身份文件都没变就直接复用，否则全量重放一次。 */
    get(root) {
      const cached = entries.get(root)
      if (cached !== undefined && sameProbe(cached.probe, probeOf(cached.archive.path))) {
        stats.hits += 1
        return cached.archive
      }
      stats.replays += 1
      const archive = openArchive(root, { create: false, repairIndex: false })
      // 打开过程可能顺手自愈索引（writeIndex），指纹要在打开之后再取一次，否则每次都误判为失效。
      entries.delete(root)
      entries.set(root, { archive, probe: probeOf(archive.path) })
      while (entries.size > limit) {
        const oldest = entries.keys().next()
        if (oldest.done === true) break
        entries.delete(oldest.value)
      }
      return archive
    },
    stats() {
      return { ...stats, entries: entries.size }
    },
    clear() {
      entries.clear()
    }
  }
}

/** If-None-Match 比较：支持 W/ 前缀与逗号列表（浏览器可能带多个）。 */
function ifNoneMatch(header, etag) {
  if (typeof header !== 'string' || header.length === 0) return false
  for (const raw of header.split(',')) {
    const value = raw.trim()
    if (value === '*') return true
    if ((value.startsWith('W/') ? value.slice(2) : value) === etag) return true
  }
  return false
}

function failure(code, message, details) {
  return { ok: false, error: { code, message, details: details ?? {} } }
}

function success(value) {
  return { ok: true, value }
}

function str(value, label, max) {
  const limit = max ?? 200000
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(label + ' 不能为空')
  if (value.length > limit) throw new Error(label + ' 太长')
  return value
}

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, classroomHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }))
  res.end(body)
}

function writeFailure(res, status, code, message) {
  writeJson(res, status, failure(code, message))
}

/** 请求头取值：Node 给的是 string | string[] | undefined。 */
function headerValue(req, name) {
  const raw = req.headers === undefined || req.headers === null ? undefined : req.headers[name]
  return Array.isArray(raw) ? (typeof raw[0] === 'string' ? raw[0] : '') : typeof raw === 'string' ? raw : ''
}

/**
 * 这一次请求是不是浏览器在把文档导航到这个地址（iframe、页签、直接粘贴 URL）。
 * 是的话失败必须回一页给人看：把 RPC 的 JSON 信封摊在课程页上，用户只会读到一段看不懂的报文。
 */
function wantsDocument(req) {
  if (headerValue(req, 'accept').toLowerCase().includes('text/html')) return true
  const destination = headerValue(req, 'sec-fetch-dest').toLowerCase()
  return destination === 'document' || destination === 'iframe' || destination === 'frame' || destination === 'embed' || destination === 'object'
}

function escapeHtmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 文档导航失败时的那一页：一句人话 + 一条回到课程页的路。没有脚本，也不请求外部资源，
 * 免得课程页里的链接再点出一个 JSON。
 */
function writeDocumentFailure(res, status, message, backHref) {
  const link = backHref === '' ? '' : '<p><a href="' + escapeHtmlText(backHref) + '">回到课程页</a></p>'
  const body = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>课堂</title><style>'
    + ':root{color-scheme:light dark}body{margin:0;padding:24px;font:14px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#0f1115;background:#fff}'
    + 'p{margin:0 0 10px}strong{font-size:15px;font-weight:600}a{color:inherit}'
    + '@media (prefers-color-scheme:dark){body{color:#f9fafb;background:#151517}}'
    + '</style></head><body><p><strong>' + escapeHtmlText(message) + '</strong></p>' + link + '</body></html>'
  res.writeHead(status, classroomHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"
  }))
  res.end(body)
}

function parseAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return null
  const match = /^dsh-resource:\/\/file\/session\/[^/]+\/(.+)$/.exec(address)
  if (match === null) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

function findLesson(root, archive, wanted) {
  if (typeof wanted !== 'string' || wanted.length === 0) return undefined
  const relative = path.isAbsolute(wanted) ? path.relative(root, wanted) : wanted
  const normalized = relative.split(path.sep).join('/')
  for (const lesson of Object.values(archive.state.lessons)) {
    if (lesson.path === normalized) return lesson
    try {
      if (fs.realpathSync.native(path.resolve(root, lesson.path)) === fs.realpathSync.native(path.resolve(root, normalized))) return lesson
    } catch {
      // 路径不存在的候选直接跳过
    }
  }
  return undefined
}

function sessionContext(ctx, sessionId, options = {}) {
  const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') {
    throw new Error('宿主没有 sessions 服务，课堂无法定位会话')
  }
  const session = sessions.get(sessionId)
  if (session === undefined || session === null) throw new Error('没有这条会话：' + sessionId)
  const cwd = session.header !== undefined && session.header !== null ? session.header.cwd : undefined
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('这条会话没有工作区')
  const sessionRoot = fs.realpathSync.native(cwd)
  // 档案与课程相对**教学根**解析（配置 > 会话内绑定 > 会话工作区），与工具侧完全同一口径；
  // 否则学习者 bind 到子目录后，工具写新根、课堂读旧根，列表直接空掉。
  const config = typeof options.getConfig === 'function' ? options.getConfig() : undefined
  const teachingRoot = config?.workspace?.teachingRoot
  const root = resolveTeachingRoot(sessionRoot, { teachingRoot })
  return { session: session, root: fs.realpathSync.native(root) }
}

function questionAnswers(state, lessonId) {
  return Object.values(state.submissions)
    .filter((item) => item.lessonId === lessonId)
    .map((submission) => ({
      id: submission.id,
      questionId: submission.questionId,
      submittedAt: submission.submittedAt,
      // 结论统一走 verdictViewOf：历史结论、是否失效、失效原因、有效结论一次给齐。
      // 0.6.1 只在各出口自己查 latestAssessment，失效的旧通过照样报 passed。
      ...verdictViewOf(state, submission)
    }))
}

/**
 * 一条评估的结论视图：与 verdictViewOf 同一口径（沿用 staleReason 与「有效才算数」的规则），
 * 但按调用方挑定的那条评估展开 —— 最新评估被作废后，侧栏要能回退到更早那条结论。
 */
function assessmentView(state, assessment) {
  const reason = staleReason(state, assessment)
  const stale = reason !== '' && reason !== '还没有评估'
  return {
    verdict: assessment.verdict,
    verdictAt: assessment.createdAt ?? null,
    stale,
    staleReason: stale ? reason : '',
    effectiveVerdict: assessment.verdict === null || stale ? null : assessment.verdict
  }
}

/** 待批改的提交：status === 'pending'（开放题提交后还没有任何评估）。 */
function pendingOf(state, lessonId) {
  return Object.values(state.submissions)
    .filter((item) => item.lessonId === lessonId && item.status === 'pending')
    .sort((left, right) => String(left.submittedAt ?? '').localeCompare(String(right.submittedAt ?? '')))
    .map((submission) => ({
      submissionId: submission.id,
      questionId: submission.questionId,
      questionRevision: Number.isInteger(submission.questionRevision) ? submission.questionRevision : 0,
      submittedAt: submission.submittedAt
    }))
}

/**
 * 注册课堂资源路由与 RPC。
 * @param {object} ctx 宿主上下文（需要 webServer + connection）
 * @param {object} [options] getConfig / rpcRateLimit；caches 只给测试注入自带计数的
 *   {assets, archive} 实例（生产不传，走默认容量上限）
 * @returns {{enabled: boolean, reason?: string, service?: object}}
 */
export function registerClassroom(ctx, options) {
  const opts = options ?? {}
  const get = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  const webServer = get('webServer')
  const connection = get('connection')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    return { enabled: false, reason: '宿主没有 webServer，课堂资源不提供' }
  }
  // 只借宿主的鉴权围栏（Host/Origin + 浏览器登录态），不用 connection.rpc：
  // 这条自建通道在 0.2.1-rc.3 上注册不出 HTTP 路由（HostConnectionService.register 内部
  // 取 owner.webServer，而 connection 插件自己没 inject webServer），POST 会落到静态
  // 处理器返回 405 —— 2026-10-27 真实会话里侧栏就是这么"读不到课程列表"的。
  // 现在 RPC 走我们自己的 /teach-classroom/rpc/*，鉴权用 connection.requestRejection。
  if (connection === undefined || typeof connection.requestRejection !== 'function') {
    return { enabled: false, reason: '宿主没有 connection.requestRejection，课堂回传的鉴权无法保证' }
  }

  const secret = createSecret()
  /** 会话上下文（会话 + 解析到教学根的工作区），所有 RPC 共用同一口径。 */
  const sessionOf = (sessionId) => sessionContext(ctx, sessionId, opts)
  // 进程内读缓存（不落盘，随注册实例生灭）：资源字节 + 档案投影。
  // 测试通过 opts.caches 注入自带计数的实例，生产走默认上限。
  const caches = opts.caches ?? {}
  const assetCache = caches.assets ?? createAssetCache()
  const archiveCache = caches.archive ?? createArchiveProjectionCache()

  /** 每 endpoint + 每 session 的进程内令牌桶（默认 60 次/分钟），超限 429。 */
  const rateOption = opts.rpcRateLimit
  const rateLimit = Number.isInteger(rateOption?.limit) && rateOption.limit > 0 ? rateOption.limit : DEFAULT_RPC_LIMIT
  const rateWindowMs = Number.isInteger(rateOption?.windowMs) && rateOption.windowMs > 0 ? rateOption.windowMs : DEFAULT_RPC_WINDOW_MS
  const buckets = new Map()
  const allow = (endpoint, sessionId) => {
    const key = endpoint + '|' + (typeof sessionId === 'string' ? sessionId : '')
    const now = Date.now()
    const bucket = buckets.get(key)
    if (bucket === undefined || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + rateWindowMs })
      // 桶只按 endpoint+session 累积；会话很多时顺手清掉过期的，避免进程内无限增长。
      if (buckets.size > 4096) for (const [itemKey, item] of buckets) if (item.resetAt <= now) buckets.delete(itemKey)
      return true
    }
    if (bucket.count >= rateLimit) return false
    bucket.count += 1
    return true
  }

  /**
   * 验票并绑定到档案事实。票是身份依据：payload.sessionId / lessonId 只做一致性比对。
   * 缺票 401、验签失败 401、过期为 410、workspace 不符 403、lesson/revision 不符 410、
   * payload.sessionId 与 claims.sessionId 不一致 403。
   */
  const requireTicket = (payload, ticket) => {
    const value = typeof ticket === 'string' ? ticket : ''
    if (value.length === 0) return { failure: failure('unauthorized', '课堂接口需要请求头 X-Teach-Classroom 里的能力票') }
    const verified = verifyToken(secret, value)
    if (!verified.ok) {
      if (verified.code === 'expired') return { failure: failure('ticket-expired', '课堂链接已过期，重新打开课程') }
      return { failure: failure('ticket-invalid', '课堂链接无效') }
    }
    const claims = verified.claims
    const askedSession = typeof payload?.sessionId === 'string' && payload.sessionId.length > 0 ? payload.sessionId : ''
    if (askedSession !== '' && askedSession !== claims.sessionId) return { failure: failure('session-mismatch', '课堂票不属于这条会话') }
    if (typeof payload?.lessonId === 'string' && payload.lessonId.length > 0 && payload.lessonId !== claims.lessonId) {
      return { failure: failure('lesson-mismatch', '课堂票与请求的课程不一致') }
    }
    const currentSession = sessionOf(claims.sessionId)
    const session = { ...currentSession, root: claims.contentVersion ? claims.root : currentSession.root }
    const archive = openArchive(session.root, { create: false, repairIndex: false })
    if (archive.workspaceId !== claims.workspaceId) return { failure: failure('workspace-mismatch', '课堂票不属于这个工作区') }
    const found = lessonOf(archive, claims.lessonId, claims.revision)
    if (found.error !== undefined) return { failure: failure('lesson-revision-stale', '课程版本已变化，重新打开课堂') }
    return { bound: { claims: claims, session: session, archive: archive, lesson: found.lesson } }
  }

  const open = (payload) => {
    const sessionId = str(payload?.sessionId, 'sessionId', 200)
    const session = sessionOf(sessionId)
    const archive = openArchive(session.root, { create: false, repairIndex: false })
    // 两条入口：按 lessonId（侧栏课程列表直接开一课）或按地址（文件树/模型给的 HTML 路径）。
    const askedId = typeof payload?.lessonId === 'string' && payload.lessonId.length > 0 ? payload.lessonId : null
    const wanted = typeof payload?.path === 'string' && payload.path.length > 0 ? payload.path : parseAddress(payload?.address)
    const lesson = askedId !== null ? archive.state.lessons[askedId] : findLesson(session.root, archive, wanted)
    if (lesson === undefined) {
      return failure('lesson-not-found', askedId !== null ? '课程不存在或还没发布' : '这个地址不在已发布课程清单里')
    }
    if (payload?.contentVersion && lesson.contentVersion !== payload.contentVersion) return failure('lesson-version-not-found', '没有保存这个课程内容版本')
    const ticket = issueToken(secret, {
      root: session.root,
      workspaceId: archive.workspaceId,
      sessionId: sessionId,
      lessonId: lesson.id,
      revision: lesson.revision,
      collectionId: learningScope().collectionId ?? 'default',
      contentVersion: lesson.contentVersion
    })
    return success({
      url: ROUTE_PREFIX + '/' + ticket.token + '/' + encodeRelative(lesson.path),
      title: lesson.title,
      lessonId: lesson.id,
      revision: lesson.revision,
      sessionId: sessionId,
      collectionId: learningScope().collectionId ?? 'default',
      contentVersion: lesson.contentVersion,
      reading: readReading(archive, { workspaceId: archive.workspaceId, collectionId: learningScope().collectionId ?? 'default', lessonId: lesson.id, contentVersion: lesson.contentVersion }),
      factCheck: archive.state.factChecks?.[lesson.id]?.[lesson.contentVersion] ?? null,
      expiresAt: ticket.expiresAt,
      nonce: ticket.payload.nonce,
      questions: lessonQuestionsOf(archive.state, lesson.id).map(questionView)
    })
  }

  const submit = (payload, bound) => {
    const session = bound.session
    const lessonId = bound.claims.lessonId
    const revision = Number(payload?.revision)
    if (!Number.isInteger(revision) || revision < 1) return failure('bad-request', '缺少课程 revision')
    // 票已经绑定到（会话 + 课程 + revision）；payload 里的 revision 只做一致性比对，不作身份依据。
    if (revision !== bound.claims.revision) return failure('lesson-revision-stale', '课程版本已变化，重新打开课堂')
    const archive = bound.archive
    const found = lessonOf(archive, lessonId, revision)
    if (found.error !== undefined) return failure(found.error, '课程不存在或版本已过期')
    const questionId = str(payload?.questionId, 'questionId', 128)
    const question = archive.state.questions[questionId]
    if (question === undefined) return failure('question-not-found', '没有这道题')
    if (question.lessonId !== lessonId) return failure('question-not-in-lesson', '题目不属于这节课')
    if (question.status === 'retired') return failure('question-retired', '这道题已作废')
    if (payload?.questionRevision !== undefined && Number(payload.questionRevision) !== question.revision) {
      return failure('question-revision-stale', '题目已改版，刷新课堂后再提交')
    }
    const rawAnswer = str(payload?.rawAnswer, 'rawAnswer', 100000)
    const options = {
      source: 'classroom',
      hintsUsed: payload?.hintsUsed === true,
      showedSolution: payload?.showedSolution === true
    }
    if (typeof payload?.idempotencyKey === 'string' && payload.idempotencyKey.length > 0) options.idempotencyKey = payload.idempotencyKey
    try {
      const recorded = recordSubmission(session.root, {
        questionId: questionId,
        rawAnswer: rawAnswer,
        source: options.source,
        hintsUsed: options.hintsUsed,
        showedSolution: options.showedSolution,
        idempotencyKey: options.idempotencyKey
      })
      // 幂等命中时档案层才补 verdict/stale；这里按刚提交后的投影再兜一次底，
      // 保证课堂永远拿到同一套口径（前端不必猜「这次是不是幂等返回」）。
      let latest = archive.state
      try {
        latest = openArchive(session.root, { create: false, repairIndex: false }).state
      } catch {
        // 刚提交成功时档案一定可读；万一读不到就退回提交前的投影，不影响回执。
      }
      const submission = latest.submissions[recorded.submissionId]
      const view = submission === undefined ? null : verdictViewOf(latest, submission)
      const value = { ...recorded }
      if (view !== null) {
        if (value.verdict === undefined) value.verdict = view.verdict
        if (value.stale === undefined) value.stale = view.stale
        if (value.staleReason === undefined) value.staleReason = view.staleReason
        if (value.verdictAt === undefined) value.verdictAt = view.verdictAt
      }
      // 没有结论 = 开放题/待补录：前端据此显示「已保存，等待导师批改」而不是「等待评估」。
      value.needsGrading = value.verdict === null || value.verdict === undefined
      return success(value)
    } catch (error) {
      return failure(error?.code ?? 'submit-failed', error instanceof Error ? error.message : String(error))
    }
  }

  const status = (payload, bound) => {
    const lessonId = bound.claims.lessonId
    const archive = bound.archive
    const lesson = archive.state.lessons[lessonId]
    if (lesson === undefined) return failure('lesson-not-found', '课程还没发布')
    const pending = pendingOf(archive.state, lessonId)
    return success({
      lesson: { id: lesson.id, title: lesson.title, path: lesson.path, revision: lesson.revision },
      questions: lessonQuestionsOf(archive.state, lessonId).map(questionView),
      submissions: questionAnswers(archive.state, lessonId),
      pending,
      pendingCount: pending.length
    })
  }

  /** 待批改清单：开放题提交后还没有评估的那些，侧栏「待批改 N」与课堂都用它。
   * 目前没有真实调用方（client.js 里没有 classroom/pending），因此保持宿主围栏 + 会话存在性 + 限频，
   * 不要求能力票——否则它只会变成「只能被测试调用」的死端点。 */
  const pendingSubmissions = (payload) => {
    const sessionId = str(payload?.sessionId, 'sessionId', 200)
    const session = sessionOf(sessionId)
    const lessonId = str(payload?.lessonId, 'lessonId', 128)
    const archive = openArchive(session.root, { create: false, repairIndex: false })
    const lesson = archive.state.lessons[lessonId]
    if (lesson === undefined) return failure('lesson-not-found', '课程还没发布')
    const pending = pendingOf(archive.state, lessonId)
    return success({ lessonId: lesson.id, revision: lesson.revision, pending, pendingCount: pending.length })
  }

  const exportLesson = (payload, bound) => {
    const session = bound.session
    // 票已校验 lessonId + revision 与档案一致（不一致是 410），这里直接用票绑定的那节课。
    const lesson = bound.lesson
    try {
      return success(buildOffline(path.resolve(session.root, lesson.artifactRoot ?? '.'), bound.archive.state, lesson))
    } catch (error) {
      return failure('export-failed', error instanceof Error ? error.message : String(error))
    }
  }

  const importProgress = (payload, bound) => {
    const archive = bound.archive
    const lesson = bound.lesson
    // 目标课由票决定（claims.lessonId）；payload 与文件里的 lessonId 只做一致性比对。
    const lessonId = bound.claims.lessonId
    const data = payload?.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return failure('bad-request', '导入内容必须是对象')
    if (data.collectionId !== undefined && data.collectionId !== (bound.claims.collectionId ?? 'default')) return failure('import-collection', '导入文件不是这个教学集合的')
    if (data.contentVersion !== undefined && data.contentVersion !== bound.claims.contentVersion) return failure('import-version', '导入文件不是当前课程内容版本')
    if (data.version !== 1) return failure('import-version', '只支持 version 1 的学习进度文件')
    if (data.lessonId !== undefined && data.lessonId !== lessonId) return failure('import-lesson', '导入文件不是这节课程的')
    // 离线导出会把 workspaceId / revision / fingerprint 写进文件：这些身份字段不是「防误用」，
    // 而是导入的前置条件——对不上就整份拒绝，不能拿另一个工作区/另一版课程的记录当自报。
    if (typeof data.workspaceId === 'string' && data.workspaceId.length > 0 && data.workspaceId !== archive.workspaceId) {
      return failure('import-workspace', '导入文件不是这个工作区的')
    }
    if (Number.isInteger(data.revision) && data.revision !== lesson.revision) return failure('import-revision', '导入文件对应旧版课程')
    if (typeof data.fingerprint === 'string' && data.fingerprint.length > 0 && data.fingerprint !== lesson.fingerprint) {
      return failure('import-fingerprint', '导入文件对不上这节课程的发布指纹')
    }
    // 三种形状都收：离线页导出的是 items（快照提交 + 本机记录），旧文件是 selfReports，
    // submissions 作为最后兜底（每项用 rawAnswer 当自报内容）。
    const items = Array.isArray(data.selfReports)
      ? data.selfReports
      : Array.isArray(data.items)
        ? data.items
        : Array.isArray(data.submissions)
          ? data.submissions
          : []
    // 条数上限在事务之前判：超限一律不写，别留下半个导入。
    if (items.length > IMPORT_MAX_ITEMS) {
      return failure('import-too-many', '一次最多导入 ' + IMPORT_MAX_ITEMS + ' 条学习记录，请拆分文件后再导入')
    }
    const accepted = []
    let skipped = 0
    let staleQuestion = ''
    for (const item of items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        skipped += 1
        continue
      }
      const question = archive.state.questions[item.questionId]
      if (question === undefined || question.lessonId !== lessonId || question.status === 'retired') {
        skipped += 1
        continue
      }
      // 题目改版后旧文件里的自报对不上当前题面：整份拒绝，不做「挑着导入」。
      if (Number.isInteger(item.questionRevision) && item.questionRevision !== question.revision) {
        staleQuestion = String(item.questionId)
        continue
      }
      const claim = typeof item.claim === 'string' ? item.claim : typeof item.rawAnswer === 'string' ? item.rawAnswer : ''
      if (claim.trim().length === 0 || claim.length > 2000) {
        skipped += 1
        continue
      }
      const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : 'import-' + crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 24)
      if (!IMPORT_ID_PATTERN.test(id)) {
        skipped += 1
        continue
      }
      accepted.push({ id: id, claim: claim, questionId: question.id })
    }
    if (staleQuestion !== '') return failure('import-question-revision', '导入文件里的题目已改版（' + staleQuestion + '），重新导出学习进度后再导入')
    // 一次批量事务：单条 journal 条目 + 单次 fsync；部分校验失败在事务前就跳过，不会半写。
    const written = importSelfReports(archive, accepted)
    return success({ imported: written.imported, skipped: skipped + written.skipped, lessonId: lessonId, revision: lesson.revision, error: written.error || undefined })
  }

  const diagnostics = () => {
    const config = typeof opts.getConfig === 'function' ? opts.getConfig() : undefined
    return success({
      enabled: true,
      route: ROUTE_PREFIX,
      animation: config !== undefined && config.animation !== undefined && config.animation.root ? 'configured' : 'unconfigured'
    })
  }

  /** 侧栏课程列表的数据源：已发布课程 + 课堂挂点 + 是否具备自动打开能力。纯读，不建档案。 */
  const catalog = (payload) => {
    const sessionId = str(payload?.sessionId, 'sessionId', 200)
    const session = sessionOf(sessionId)
    const tools = get('tools')
    const openable = tools !== undefined && typeof tools.get === 'function' && tools.get('sidebar_open') !== undefined
    const archive = tryOpenArchive(session.root, { repairIndex: false })
    if (archive === null) {
      return success({ initialized: false, root: session.root, revision: 0, lessons: [], openable, collectionId: 'default', collections: collectionList(null), reading: readingSummary([]) })
    }
    const state = archive.state
    const assessments = Object.values(state.assessments)
    const submissionsOf = new Map()
    for (const submission of Object.values(state.submissions)) {
      if (submission.lessonId === null || submission.lessonId === undefined) continue
      const list = submissionsOf.get(submission.lessonId) ?? []
      list.push(submission)
      submissionsOf.set(submission.lessonId, list)
    }
    const lessons = Object.values(state.lessons)
      .map((lesson) => {
        const questions = lessonQuestionsOf(state, lesson.id)
        const registered = new Set(questions.map((question) => question.id))
        const pageIds = Array.isArray(lesson.questionIds) ? lesson.questionIds : []
        const submissions = submissionsOf.get(lesson.id) ?? []
        // 最近一条结论按评估 createdAt 取（0.6.1 读的是不存在的 at，永远挑不到）。
        // 作废的评估不算结论：作废最新一条后要回退到更早那条，而不是显示空。
        const latest = assessments
          .filter((entry) => entry.voidedAt === null || entry.voidedAt === undefined)
          .filter((entry) => submissions.some((submission) => submission.id === entry.submissionId))
          .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')) || String(right.id).localeCompare(String(left.id)))[0]
        const view = latest === undefined ? null : assessmentView(state, latest)
        const submittedAt = submissions.map((item) => item.submittedAt).sort().at(-1)
        return {
          id: lesson.id,
          title: lesson.title,
          path: lesson.path,
          revision: lesson.revision,
          publishedAt: lesson.publishedAt,
          contentVersion: lesson.contentVersion,
          reading: readReading(archive, { workspaceId: archive.workspaceId, collectionId: learningScope().collectionId ?? 'default', lessonId: lesson.id, contentVersion: lesson.contentVersion }),
          versions: Object.values(state.lessonVersions?.[lesson.id] ?? {}).map((v) => ({ contentVersion: v.contentVersion, publishedAt: v.lesson.publishedAt })),
          questionCount: questions.length,
          pageQuestionIds: pageIds,
          unmappedQuestionIds: [...registered].filter((id) => !pageIds.includes(id)),
          missingPageIds: pageIds.filter((id) => !registered.has(id)),
          // lastVerdict 保留历史结论；是否仍有效另给三位（与 verdictViewOf 同一口径）。
          lastVerdict: view === null ? null : view.verdict,
          lastVerdictAt: view === null ? null : view.verdictAt,
          lastVerdictStale: view === null ? null : view.stale,
          lastVerdictStaleReason: view === null || !view.stale ? null : view.staleReason,
          lastSubmittedAt: submittedAt === undefined ? null : submittedAt
        }
      })
      .sort((left, right) => String(right.publishedAt ?? '').localeCompare(String(left.publishedAt ?? '')))
    // 剪掉空值：侧栏是 JSON over RPC，缺字段比 null 更好读（与工具出口的 pruneEmpty 同一口径）。
    const clean = (value) => {
      if (Array.isArray(value)) return value.map(clean)
      if (value === null || typeof value !== 'object') return value
      const out = {}
      for (const [key, item] of Object.entries(value)) {
        if (item === null || item === undefined) continue
        out[key] = clean(item)
      }
      return out
    }
    const all = archive.globalState
    const available = collectionList(all).flatMap((c) => {
      const source = collectionState(all, c.id)
      return Object.values(source.lessons).filter((l) => l.contentVersion).map((l) => ({ sourceId: c.id, lessonId: l.id, title: l.title, contentVersion: l.contentVersion }))
    })
    return success(clean({ initialized: true, root: session.root, revision: state.revision, lessons, openable,
      collectionId: learningScope().collectionId ?? 'default', collections: collectionList(all), available: [...new Map(available.map((v) => [v.lessonId + v.contentVersion, v])).values()],
      reading: readingSummary(lessons.map((l) => l.reading)) }))
  }

  const rateLimited = () => failure('rate-limited', '课堂接口调用太频繁（每分钟上限 ' + rateLimit + ' 次），稍后再试')

  const rpcHandler = async (endpoint, payload, signal, peer, ticket) => {
    if (peer === undefined || peer.principal === undefined || peer.principal.kind !== 'owner') {
      return failure('forbidden', '课堂回传只接受本机 owner')
    }
    const name = String(endpoint ?? '').replace(/^\/+/, '')
    const body = payload === null || typeof payload !== 'object' || Array.isArray(payload) ? {} : payload
    if (signal !== undefined && signal.aborted) return failure('aborted', '请求已取消')
    try {
      if (!TICKET_ENDPOINTS.has(name) && ['preferences/get', 'preferences/set', 'collections/manage', 'collections/select', 'classroom/catalog', 'classroom/open', 'classroom/pending'].includes(name)) {
        const sessionId = str(body.sessionId, 'sessionId', 200)
        const session = sessionOf(sessionId)
        const prefsService = get('teachPreferences')
        const prefs = prefsService ? await prefsService.ensure(sessionId) : null
        if (name === 'preferences/get') {
          if (!prefs) return failure('storage-unavailable', '宿主会话偏好存储未就绪，无法保存教学设置')
          return success({ ...prefs, collectionId: prefs.collections[session.root] ?? 'default', collections: withLearningScope({}, () => collectionList(tryOpenArchive(session.root, { repairIndex: false })?.globalState)) })
        }
        if (name === 'preferences/set' || name === 'collections/select') {
          if (!allow(name, sessionId)) return rateLimited()
          if (!prefsService) return failure('storage-unavailable', '宿主会话偏好存储未就绪')
          if (body.collectionId !== undefined && !withLearningScope({}, () => collectionList(tryOpenArchive(session.root, { repairIndex: false })?.globalState)).some((c) => c.id === body.collectionId)) return failure('collection-not-found', '教学集合不存在')
          const next = await prefsService.update(sessionId, body, session.root)
          return success({ ...next, collectionId: next.collections[session.root] ?? 'default', collections: withLearningScope({}, () => collectionList(tryOpenArchive(session.root, { repairIndex: false })?.globalState)) })
        }
        if (name === 'collections/manage') {
          if (!allow(name, sessionId)) return rateLimited()
          return success(manageCollection(session.root, body))
        }
        const collectionId = body.collectionId ?? prefs?.collections[session.root] ?? 'default'
        const scope = { collectionId, lessonId: body.lessonId, contentVersion: body.contentVersion }
        return withLearningScope(scope, () => {
          if (!allow(name, sessionId)) return rateLimited()
          if (name === 'classroom/open') return open(body)
          if (name === 'classroom/catalog') return catalog(body)
          return pendingSubmissions(body)
        })
      }
      if (TICKET_ENDPOINTS.has(name)) {
        const verified = verifyToken(secret, typeof ticket === 'string' ? ticket : '')
        const scope = verified.ok ? { collectionId: verified.claims.collectionId ?? 'default', lessonId: verified.claims.lessonId, contentVersion: verified.claims.contentVersion } : {}
        return withLearningScope(scope, () => {
        const checked = requireTicket(body, ticket)
        if (checked.failure !== undefined) return checked.failure
        if (!allow(name, checked.bound.claims.sessionId)) return rateLimited()
        if (name === 'classroom/reading') {
          const bound = checked.bound
          bound.archive.initializeLearning()
          const lesson = bound.archive.state.lessons[bound.claims.lessonId]
          return success(saveReading(bound.archive, { ...bound.claims, contentVersion: bound.claims.contentVersion ?? lesson.contentVersion, windowId: bound.claims.nonce }, body))
        }
        if (name === 'classroom/submit') return submit(body, checked.bound)
        if (name === 'classroom/status') return status(body, checked.bound)
        if (name === 'classroom/export') return exportLesson(body, checked.bound)
        return importProgress(body, checked.bound)
        })
      }
      // 引导入口：选课首屏还没有可绑定的课程票（票的粒度是会话+课程+revision），
      // 只能靠宿主围栏 + 会话存在性 + 限频；三者都不写档案（open 只签票，catalog 只读）。
      if (name === 'classroom/open') {
        if (!allow(name, body.sessionId)) return rateLimited()
        return open(body)
      }
      if (name === 'classroom/catalog') {
        if (!allow(name, body.sessionId)) return rateLimited()
        return catalog(body)
      }
      // pending 没有真实客户端调用方，按引导入口同等口径（围栏 + 会话存在性 + 限频）。
      if (name === 'classroom/pending') {
        if (!allow(name, body.sessionId)) return rateLimited()
        return pendingSubmissions(body)
      }
      if (name === 'diagnostics/get') return diagnostics()
      return failure('unknown-endpoint', '未知课堂接口：' + name)
    } catch (error) {
      return failure(error?.code ?? 'classroom-error', error instanceof Error ? error.message : String(error))
    }
  }

  /** 课堂接口的请求体上限：报名单、离线进度这种 JSON，4 MiB 足够。 */
  const RPC_BODY_LIMIT = 4 * 1024 * 1024

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let chunks = []
      let size = 0
      let finished = false
      const finish = (error) => {
        if (finished) return
        finished = true
        if (error !== undefined) reject(error)
        else resolve(Buffer.concat(chunks))
        chunks = []
      }
      req.on('data', (chunk) => {
        if (finished) return
        size += chunk.length
        if (size > RPC_BODY_LIMIT) {
          finish(new Error('body-too-large'))
          req.resume?.()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => finish())
      req.on('error', finish)
      req.on('aborted', () => finish(new Error('request-aborted')))
      req.on('close', () => { if (req.complete !== true) finish(new Error('request-aborted')) })
    })

  /** 鉴权只依赖宿主的登录围栏；服务失效时拒绝，不能退回仅同源检查。 */
  const fenceStatus = (req) => {
    try {
      if (typeof connection.requestRejection !== 'function') return 403
      return connection.requestRejection(req)
    } catch {
      return 403
    }
  }

  /**
   * 课堂回传的 HTTP 入口：POST /teach-classroom/rpc/<endpoint>，体是 {payload}。
   * 路由和课程页共用同一个 /teach-classroom 前缀，不另开端口或通道。
   */
  const handleRpcRequest = async (req, res, url) => {
    const prefix = ROUTE_PREFIX + '/rpc/'
    if (!url.pathname.startsWith(prefix)) {
      writeFailure(res, 404, 'not-found', '未知课堂接口')
      return
    }
    const rejection = fenceStatus(req)
    if (rejection !== undefined) {
      writeFailure(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden', rejection === 401 ? '先登录再调用课堂接口' : '课堂接口只接受本机页面')
      return
    }
    let endpoint
    try {
      endpoint = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/\/+$/, '')
    } catch {
      writeFailure(res, 400, 'bad-endpoint', '接口名不合法')
      return
    }
    let payload = {}
    try {
      const raw = await readBody(req)
      const parsed = JSON.parse(raw.toString('utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) ||
          parsed.payload === null || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) throw new Error('bad-body')
      payload = parsed.payload
    } catch (error) {
      const oversized = error.message === 'body-too-large'
      writeFailure(res, oversized ? 413 : 400, oversized ? 'body-too-large' : 'bad-body', oversized ? '请求体超过 4 MiB' : '请求体必须是包含 payload 对象的 JSON，且完整传输')
      return
    }
    // 票只从请求头取：body 里的 sessionId / token 都不是身份依据。
    const rawTicket = req.headers === undefined || req.headers === null ? undefined : req.headers[TICKET_HEADER]
    const ticket = Array.isArray(rawTicket) ? rawTicket[0] : typeof rawTicket === 'string' ? rawTicket.trim() : ''
    const result = await rpcHandler(endpoint, payload, undefined, { principal: { kind: 'owner' } }, ticket)
    writeJson(res, statusOf(result), result)
  }

  const routeHandler = async (req, res) => {
    // 文档导航与 RPC/资源请求要两种失败形态：前者回一页人能读的东西，后者仍是 JSON 信封。
    const navigation = wantsDocument(req)
    const fail = (status, code, message, back) => {
      if (navigation) writeDocumentFailure(res, status, message, back ?? '')
      else writeFailure(res, status, code, message)
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://local')
    } catch {
      fail(400, 'bad-url', '请求地址不合法')
      return
    }
    if (req.method === 'POST') {
      await handleRpcRequest(req, res, url)
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fail(405, 'method-not-allowed', '只支持 GET/HEAD/POST')
      return
    }
    const rest = url.pathname.slice(ROUTE_PREFIX.length)
    if (!rest.startsWith('/')) {
      fail(404, 'not-found', '缺资源路径')
      return
    }
    // 末尾斜杠是「目录式地址」，不是路径的一段：`.../lessons/` 与 `.../lessons` 指同一个目录。
    // 直接把它当空段丢给解码器，课程页里任何 `href="./"`、`href="../reference/"` 都会变成 bad-path。
    const raw = rest.slice(1)
    const directory = raw === '' || raw.endsWith('/')
    const segments = raw.split('/')
    while (segments.length > 0 && segments[segments.length - 1] === '') segments.pop()
    const token = segments.length === 0 ? '' : segments.shift()
    const verified = verifyToken(secret, token)
    if (!verified.ok) {
      const statusCode = verified.code === 'expired' ? 410 : 401
      fail(statusCode, verified.code, verified.code === 'expired' ? '课堂链接已过期，重新打开课程' : '课堂链接无效')
      return
    }
    const claims = verified.claims
    return withLearningScope({ collectionId: claims.collectionId ?? 'default', lessonId: claims.lessonId, contentVersion: claims.contentVersion }, async () => {
    let archive
    try {
      // 投影缓存：档案提交会原子替换 index.json，指纹不变就不再重放整份日志。
      archive = archiveCache.get(claims.root)
    } catch (error) {
      fail(404, 'archive-unavailable', error instanceof Error ? error.message : String(error))
      return
    }
    if (archive.workspaceId !== claims.workspaceId) {
      fail(403, 'workspace-mismatch', '课堂链接不属于这个工作区')
      return
    }
    const found = lessonOf(archive, claims.lessonId, claims.revision)
    if (found.error !== undefined) {
      fail(410, found.error, '课程版本已变化，重新打开课堂')
      return
    }
    const lessonHref = ROUTE_PREFIX + '/' + token + '/' + encodeRelative(found.lesson.path)
    // 只带票据（或票据后带一个斜杠）就是课程页本身：资源解析口径与 lesson.path 一致，
    // `<base href>` 按 lesson.path 的目录算，`../assets/course.css` 这类相对引用才不会跑到票据层级上。
    const rel = segments.length === 0 ? '' : decodeRelative(segments)
    if (rel === null) {
      fail(400, 'bad-path', '资源路径不合法', lessonHref)
      return
    }
    // 目录式地址先当「目录下的 index.html」解释；清单里没有这一页再说这一页不存在。
    let asset = assetCache.read(path.resolve(claims.root, found.lesson.artifactRoot ?? '.'), claims.workspaceId, found.lesson, rel)
    if (asset.error !== undefined && directory) {
      const index = assetCache.read(path.resolve(claims.root, found.lesson.artifactRoot ?? '.'), claims.workspaceId, found.lesson, rel + '/index.html')
      if (index.error === undefined) asset = index
    }
    // 字节缓存：键含 (root, workspaceId, lessonId, revision, rel)，命中时不再 stat/readFile/sha256。
    if (asset.error !== undefined) {
      fail(asset.status ?? 404, asset.error, '这一页不在已发布清单里', lessonHref)
      return
    }
    const bytes = asset.bytes
    // 课程页要注入 <base> 与课堂桥；同一条清单里的其它已发布页面（参考页、速查页）在
    // 「文档导航」时可以当普通页面打开，只注入 <base> —— 它们没有题目，也不该冒领课堂桥。
    // 非文档请求（脚本取字节、离线导出）仍按纯文本给，切断「把任意发布页当文档执行」的路。
    const markupAsPage = asset.html || (navigation && isMarkupFile(asset.file))
    // 只有「正文就是清单里那份字节」的资源发 ETag：注入了 <base>/桥的资源字节已不同，
    // 且注入内容含票据 nonce，浏览器复用旧页会让桥的 nonce 对不上 —— 所以这些继续 no-store。
    const etag = markupAsPage || typeof asset.manifest?.sha256 !== 'string' ? null : '"' + asset.manifest.sha256 + '"'
    const cacheControl = markupAsPage ? 'no-store' : ASSET_CACHE_CONTROL
    const headersOf = (extra) => classroomHeaders({ 'Cache-Control': cacheControl, ...(etag === null ? {} : { ETag: etag }), ...extra })
    const mime = markupAsPage ? mimeFor(asset.file) : isMarkupFile(asset.file) ? 'text/plain; charset=utf-8' : mimeFor(asset.file)
    let body = bytes
    if (markupAsPage) {
      const dir = path.posix.dirname(asset.relative)
      const baseHref = ROUTE_PREFIX + '/' + token + '/' + (dir === '.' ? '' : encodeRelative(dir) + '/')
      if (!asset.html) {
        body = Buffer.from(injectBaseHref(bytes.toString('utf8'), baseHref), 'utf8')
      } else {
        // 题目清单随课程页一起下发：桥据此判断页面里的 data-question-id 是不是这节课
        // 已登记的题目，只给能挂上的 quiz 补「提交到课堂」按钮（只读，不带标准答案）。
        const questions = lessonQuestionsOf(archive.state, claims.lessonId).map(questionView)
        const injected = injectClassroomHtml(bytes.toString('utf8'), {
          baseHref: baseHref,
          bootstrap: {
            tracking: true,
            nonce: claims.nonce,
            workspaceId: claims.workspaceId,
            lessonId: claims.lessonId,
            revision: claims.revision,
            sessionId: claims.sessionId,
            collectionId: claims.collectionId ?? 'default',
            contentVersion: claims.contentVersion,
            reading: readReading(archive, { ...claims }),
            questions
          }
        })
        body = Buffer.from(injected, 'utf8')
      }
      // 服务端强制隔离：sandbox 让课程页即使被直接打开也是 opaque origin（拿不到宿主 Cookie /
      // 同源接口），frame-ancestors 'self' 只允许侧栏（同源）嵌入。两者都不能省：
      // 宿主侧栏 iframe 的 sandbox 只在嵌入方存在时生效，直接打开 URL 时只有响应头拦得住。
      // 资源隔离：Chromium 检查确认 'self' 资源在
      // sandbox 下照常加载（sandbox 不改 URL origin 对 'self' 的匹配），桥的内联脚本也能跑。
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'")
    }
    // 条件请求：清单 sha256 就是资源版本，浏览器带 If-None-Match 时连字节都不发。
    // Range 请求不参与 304（206 的语义已经足够），避免多段/断点续传与条件请求互相干扰。
    if (etag !== null && req.headers.range === undefined && ifNoneMatch(req.headers['if-none-match'], etag)) {
      res.writeHead(304, headersOf({}))
      res.end()
      return
    }
    const range = req.headers.range === undefined ? null : parseRange(req.headers.range, body.length)
    if (range !== null && range.unsatisfiable === true) {
      res.writeHead(416, headersOf({ 'Content-Range': 'bytes */' + body.length }))
      res.end()
      return
    }
    if (range !== null) {
      const chunk = body.subarray(range.start, range.end + 1)
      res.writeHead(206, headersOf({
        'Content-Type': mime,
        'Content-Length': chunk.length,
        'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + body.length,
        'Accept-Ranges': 'bytes'
      }))
      if (req.method === 'HEAD') res.end()
      else res.end(chunk)
      return
    }
    res.writeHead(200, headersOf({ 'Content-Type': mime, 'Content-Length': body.length, 'Accept-Ranges': 'bytes' }))
    if (req.method === 'HEAD') res.end()
    else res.end(body)
    })
  }

  // 一条前缀路由同时承载课程资源（GET/HEAD）与课堂回传（POST /rpc/*）：不依赖
  // connection.rpc 的自建通道（那个在本宿主版本里注册不出 HTTP 路由）。
  ctx.effect(() => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: routeHandler }), 'teach-me: classroom route and rpc')

  return {
    enabled: true,
    service: {
      open: open,
      submit: submit,
      status: status,
      exportLesson: exportLesson,
      importProgress: importProgress,
      route: ROUTE_PREFIX
    }
  }
}
