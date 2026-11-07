import { learningScope, withLearningScope } from './learning-scope.js'
/* 档案之上的业务操作：发布课程、登记提交、判分、复习、资料索引。
 *
 * 这里集中三条硬规则：
 *   1. 先落原始答案，再评估；评估失败不吞答案。
 *   2. passed 只能来自逐条标准 + 独立证据；题目/课程改版或材料变化后只能待复核。
 *   3. 幂等键相同、内容不同 -> 冲突，绝不静默覆盖旧提交。 */

import fs from 'node:fs'
import path from 'node:path'
import { cssRefsOf } from './css-refs.js'
import { IdempotencyConflictError, RevisionConflictError, ValidationError } from './errors.js'
import { normalizeRubric } from './rubric.js'
import { assertGoalLinks, goalChangesOf, goalInputOf } from './goals.js'
import { openArchive, tryOpenArchive } from './store.js'
import {
  ANIMATION_JOB_MODES,
  ANIMATION_JOB_STATES,
  DETERMINISTIC_TYPES,
  QUESTION_TYPES,
  SUBMISSION_SOURCES,
  materialsFingerprintOf,
  staleReason,
  verdictViewOf
} from './state.js'
import { assertInside, canonicalJson, hashJson, nowIso, randomId, resolveInside, sha256, stamp } from './util.js'

const REVIEW_INTERVALS = [1, 3, 7, 14]
const DAY_MS = 24 * 60 * 60 * 1000

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const toPosix = (value) => value.split(path.sep).join('/')

function requireString(value, label, { max = 20000 } = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ValidationError(label + ' 不能为空')
  if (value.length > max) throw new ValidationError(label + ' 太长')
  return value
}

function optionalString(value, label, max = 20000) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new ValidationError(label + ' 必须是字符串')
  if (value.length > max) throw new ValidationError(label + ' 太长')
  return value
}

/** 可选的 ISO 时间：空值给 null，非法值明确失败。 */
function optionalIso(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(label + ' 不是 ISO 时间：' + String(value))
  }
  return new Date(Date.parse(value)).toISOString()
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value)) {
    throw new ValidationError(label + ' 不是合法标识')
  }
  return value
}

/** 必填标识：空值与非法值都明确失败。 */
function requireId(value, label) {
  const id = optionalId(value, label)
  if (id === null) throw new ValidationError(label + ' 不能为空')
  return id
}

/** 可选的正整数（课程版本）；空值给 null。 */
function optionalPositiveInteger(value, label) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new ValidationError(label + ' 必须是正整数')
  return number
}

/** 解析课程文件：必须在工作区内、必须是文件；返回绝对路径与工作区相对路径。 */
export function resolveLessonFile(root, lessonPath) {
  requireString(lessonPath, '课程路径', { max: 2000 })
  const absolute = path.isAbsolute(lessonPath) ? lessonPath : path.join(root, lessonPath)
  const real = assertInside(root, absolute, '课程路径')
  const stat = fs.statSync(real)
  if (!stat.isFile()) throw new ValidationError('课程路径不是文件：' + lessonPath)
  if (!/\.html?$/i.test(real)) throw new ValidationError('课程必须是 .html 文件：' + lessonPath)
  return { absolute: real, relative: toPosix(path.relative(root, real)), size: stat.size }
}

/**
 * 解析一个"将要存在"的课程路径：只校验父目录真实、在界内、文件名是 .html。
 * 演练（dryRun）时页面还在内存里（例如 spec 路线还没编译落盘），不能让 dryRun 为了预检写盘。
 */
function resolveLessonTarget(root, lessonPath) {
  requireString(lessonPath, '课程路径', { max: 2000 })
  const absolute = path.isAbsolute(lessonPath) ? lessonPath : path.join(root, lessonPath)
  const parent = assertInside(root, path.dirname(absolute), '课程目录')
  const target = path.join(parent, path.basename(absolute))
  if (!/\.html?$/i.test(target)) throw new ValidationError('课程必须是 .html 文件：' + lessonPath)
  if (fs.existsSync(target)) return resolveLessonFile(root, target)
  return { absolute: target, relative: toPosix(path.relative(root, target)), size: 0 }
}

/** 解析任意工作区文件（材料索引不要求 .html）。 */
export function resolveWorkspaceFile(root, filePath) {
  requireString(filePath, '文件路径', { max: 2000 })
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(root, filePath)
  const real = assertInside(root, absolute, '文件路径')
  const stat = fs.statSync(real)
  if (!stat.isFile()) throw new ValidationError('不是文件：' + filePath)
  return { absolute: real, relative: toPosix(path.relative(root, real)), size: stat.size }
}

/* 课程页里可能指向本地资源的标签与属性。kind 默认就是标签名；海报（poster）是封面图，
 * 不是媒体文件本身，所以单独记成 <tag>-poster（例如 video-poster），清单里一眼能分清。
 * 每个条目的形状始终是 {path, kind, sha256, size}，课堂路由只按 path 服务。 */
const ASSET_TAG_PATTERN = /<(script|link|img|video|audio|source|track|a|object|embed)\b([^>]*)>/gi
const ASSET_ATTR_PATTERN = /\b(src|href|poster|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi

/**
 * 从真实标签里抽本地引用（注释里的字不算）。外部 URL、协议相对、锚点直接跳过。
 * @returns {{tag: string, attr: string, kind: string, raw: string, clean: string}[]}
 */
export function localAssetRefs(html) {
  const refs = []
  let tag
  ASSET_TAG_PATTERN.lastIndex = 0
  while ((tag = ASSET_TAG_PATTERN.exec(html)) !== null) {
    const name = tag[1].toLowerCase()
    let attr
    ASSET_ATTR_PATTERN.lastIndex = 0
    while ((attr = ASSET_ATTR_PATTERN.exec(tag[2])) !== null) {
      const attrName = attr[1].toLowerCase()
      const raw = (attr[3] ?? attr[4] ?? attr[5] ?? '').trim()
      if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) continue
      const clean = raw.split('#')[0].split('?')[0]
      if (!clean || clean.endsWith('/')) continue
      refs.push({ tag: name, attr: attrName, kind: attrName === 'poster' ? name + '-poster' : name, raw, clean })
    }
  }
  return refs
}

/** CSS 依赖递归的深度上限：链式 @import 再深也不收，防止一份文件把扫描拖成无限。 */
const CSS_DEPTH_LIMIT = 8

/** 页面里的 <style> 块正文；与 css-refs.js 的 STYLE_BLOCK_PATTERN 同口径（那边没导出）。 */
const STYLE_BLOCK_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi

/**
 * 抽课程页真实引用的本地资源：脚本、样式、图片、音视频、字幕、链接与嵌入对象。
 * 只收「工作区内、真实存在且是文件」的路径：工作区内的缺失/目录不进课堂清单
 * （lesson_lint 会把 script/link/img 的缺失报成硬伤）；越界（含符号链接逃逸、
 * 以及指向工作区外的缺失路径）仍然抛 ValidationError。
 *
 * 0.6.2 起再往下走一层 CSS 依赖：样式表里的 url()/@import 与页面 <style> 块里的
 * url() 也要进清单。课堂路由按清单服务文件，漏收就是静默 404；离线导出把 CSS 换成
 * data URI 后相对路径没有基准，图就丢了。CSS 依赖里发现的新资源 kind 记 'css'
 * （清单里一眼看出这条是从样式表带出来的），图片/字体/媒体只登记不递归，.css 继续
 * 递归（深度上限 CSS_DEPTH_LIMIT，seen 防环）。
 */
export function scanLocalAssets(root, lessonFile, html) {
  // 两边都取真实路径再比：macOS 的 /var 与 /private/var 指向同一处，混着比会把工作区内的路径当成越界。
  const realPath = (target, fallback) => {
    try {
      return fs.realpathSync.native(target)
    } catch {
      return fallback
    }
  }
  const dir = realPath(path.dirname(lessonFile), path.dirname(lessonFile))
  const rootReal = realPath(root, path.resolve(root))
  const assets = []
  const seen = new Set()
  const cssSeen = new Set()

  /**
   * 把一个引用按 baseDir 解析成工作区内的真实文件。
   * 缺失、目录、点号目录里的文件都返回 null（工作区内缺失不算错）；
   * 越界（含指向工作区外的缺失路径、符号链接逃逸）抛 ValidationError。
   */
  const resolveRef = (baseDir, raw) => {
    // 越界判定抽到 util.resolveInside：lint 用的是同一个函数，两边不会各说各话。
    const real = resolveInside(rootReal, baseDir, raw)
    if (real === null) return null
    let stat
    try {
      stat = fs.statSync(real)
    } catch {
      return null
    }
    if (!stat.isFile()) return null
    const relative = toPosix(path.relative(rootReal, real))
    // 点号开头的目录（.teach / .dsh-teach-me / .git …）是插件的内部账本：里面可能有
    // 标准答案与历史评估。课堂清单一旦收进去，页面里一个 <a href> 就能把答案取走，
    // 所以一律不进清单（外部 URL、越界路径在前面已经挡掉了）。
    if (relative.split('/').some((segment) => segment.startsWith('.'))) return null
    return { real, relative, size: stat.size }
  }

  /** 登记一个已解析的资源；同一路径只记一次（首次的 kind 生效）。 */
  const addAsset = (found, kind) => {
    if (seen.has(found.relative)) return
    seen.add(found.relative)
    assets.push({ path: found.relative, kind, sha256: sha256(fs.readFileSync(found.real)), size: found.size })
  }

  /** 递归读 .css 里的 url()/@import；按「这个 CSS 文件所在目录」解析。 */
  const scanCssFile = (found, depth) => {
    if (cssSeen.has(found.real)) return
    cssSeen.add(found.real)
    if (depth > CSS_DEPTH_LIMIT) return
    let text
    try {
      text = fs.readFileSync(found.real, 'utf8')
    } catch {
      return
    }
    const baseDir = path.dirname(found.real)
    for (const raw of cssRefsOf(text)) {
      const dep = resolveRef(baseDir, raw)
      if (dep === null) continue
      addAsset(dep, 'css')
      if (/\.css$/i.test(dep.relative)) scanCssFile(dep, depth + 1)
    }
  }

  // 1) HTML 标签属性里的引用
  for (const ref of localAssetRefs(html)) {
    const found = resolveRef(dir, ref.clean)
    if (found === null) continue
    addAsset(found, ref.kind)
  }

  // 2) 页面里 <style> 块的 url()/@import：相对 HTML 所在目录解析
  let style
  STYLE_BLOCK_PATTERN.lastIndex = 0
  while ((style = STYLE_BLOCK_PATTERN.exec(html)) !== null) {
    for (const raw of cssRefsOf(style[1])) {
      const dep = resolveRef(dir, raw)
      if (dep === null) continue
      addAsset(dep, 'css')
      if (/\.css$/i.test(dep.relative)) scanCssFile(dep, 1)
    }
  }

  // 3) 已发现的 .css 逐个递归（含上面第 1、2 步带进来的）
  for (const asset of [...assets]) {
    if (!/\.css$/i.test(asset.path)) continue
    const absolute = path.join(rootReal, asset.path)
    let real
    try {
      real = fs.realpathSync.native(absolute)
    } catch {
      continue
    }
    scanCssFile({ real, relative: asset.path, size: asset.size }, 1)
  }

  return assets.sort((a, b) => a.path.localeCompare(b.path))
}

const QUESTION_ID_ATTR_PATTERN = /\bdata-question-id\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi
const QUESTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/

/**
 * 抽页面声明的题目 id（去重、排序）。页面 quiz 的 data-question-id 必须等于档案里
 * teach_question_register 的 questionId；不是合法标识的占位符/模板表达式直接忽略，
 * 它们本来也挂不上任何题目。
 */
export function questionIdsOf(html) {
  const source = String(html ?? '')
  const ids = new Set()
  let hit
  QUESTION_ID_ATTR_PATTERN.lastIndex = 0
  while ((hit = QUESTION_ID_ATTR_PATTERN.exec(source)) !== null) {
    const raw = (hit[2] ?? hit[3] ?? hit[4] ?? '').trim()
    if (QUESTION_ID_PATTERN.test(raw)) ids.add(raw)
  }
  return [...ids].sort()
}

/**
 * 一节课的课堂挂点对账：页面声明的题目 id vs 档案里这节课的题目。
 * danglingIds = 页面上有、档案里没有（点了提交也没有可挂的题目）；
 * archiveOnlyIds = 档案里有、页面没挂（学习者在课堂里点不到提交按钮）。
 */
export function classroomHookOf(state, lessonId, pageQuestionIds) {
  const lesson = state.lessons[lessonId]
  // 页面刚发布时以这次 HTML 抽出来的 id 为准：幂等重发（内容没变）不会新增事件，
  // 状态里的投影可能还是旧档案（0.3.1 之前发布的课）留下的空数组。
  const declared = Array.isArray(pageQuestionIds) ? [...pageQuestionIds] : Array.isArray(lesson?.questionIds) ? lesson.questionIds : []
  const registered = Object.values(state.questions).filter((question) => question.lessonId === lessonId)
  const registeredIds = new Set(registered.map((question) => question.id))
  return {
    lessonId,
    path: lesson?.path ?? '',
    revision: lesson?.revision ?? 0,
    pageQuestionIds: declared,
    registeredPageIds: declared.filter((id) => registeredIds.has(id)),
    danglingIds: declared.filter((id) => !registeredIds.has(id)),
    archiveOnlyIds: registered
      .filter((question) => question.status !== 'retired' && !declared.includes(question.id))
      .map((question) => question.id)
      .sort()
  }
}

/** 全部课程的课堂挂点汇总（teach_status 的「课堂挂点」段用）。 */
export function classroomHooksOf(state) {
  const lessons = Object.values(state.lessons)
    .map((lesson) => classroomHookOf(state, lesson.id))
    .sort((left, right) => left.lessonId.localeCompare(right.lessonId))
  const summary = { pageQuestions: 0, registered: 0, dangling: 0, danglingIds: [], archiveOnlyIds: [], lessons }
  for (const lesson of lessons) {
    summary.pageQuestions += lesson.pageQuestionIds.length
    summary.registered += lesson.registeredPageIds.length
    summary.dangling += lesson.danglingIds.length
    summary.danglingIds.push(...lesson.danglingIds)
    summary.archiveOnlyIds.push(...lesson.archiveOnlyIds)
  }
  summary.danglingIds.sort()
  summary.archiveOnlyIds.sort()
  return summary
}

/**
 * 页面本地引用的 reference/materials/* 与已索引材料对账。
 * 没索引的材料在档案里没有指纹，引用它的题目只能待复核，所以发布时提醒一句。
 */
export function lessonMaterialsOf(state, lessonPath, html) {
  const dir = path.posix.dirname(toPosix(lessonPath))
  const referenced = new Set()
  for (const ref of localAssetRefs(html)) {
    const relative = path.posix.normalize(path.posix.join(dir, ref.clean))
    if (relative === 'reference/materials' || relative.startsWith('reference/materials/')) referenced.add(relative)
  }
  const indexed = new Set(
    Object.values(state.materials)
      .filter((material) => material.kind === 'file' && typeof material.path === 'string')
      .map((material) => material.path)
  )
  return {
    referenced: [...referenced].sort(),
    missing: [...referenced].filter((item) => !indexed.has(item)).sort()
  }
}

/**
 * 解析一次发布要用到的全部事实（只读，不写档案）。
 *
 * 演练（dryRun）用只读方式打开档案：还没有档案时不创建目录、不写身份事件，
 * 所以「先核对再发布」对磁盘零副作用；正式发布仍走 openArchive({ create: true })。
 * @param {string} root 教学根
 * @param {object} input 工具参数
 * @param {{create?: boolean}} [options] create=false 表示只读打开
 * @returns {{archive: object|null, workspaceRoot: string, id: string, title: string, file: object,
 *   htmlText: string, fingerprint: string, assets: object[], questionIds: string[],
 *   objectives: string[], publishedAt: string, existing: object|undefined}}
 */
export function resolvePublish(root, input, { create = true, repairIndex = true, page } = {}) {
  const goals = goalInputOf(input)
  // commit 在写锁内二次核对时传 repairIndex:false：读事实，不顺手重写索引。
  const archive = create ? openArchive(root, { create: true, repairIndex }) : tryOpenArchive(root, { repairIndex })
  // 还没有档案时只读解析根：演练不能为了拿 realpath 去创建档案目录。
  const workspaceRoot = archive === null ? fs.realpathSync.native(root) : archive.root
  const id = optionalId(input.id ?? input.lessonId, 'lesson.id')
  if (id === null) throw new ValidationError('发布课程需要显式 lessonId（稳定身份，后续题目要引用）')
  const title = requireString(input.title ?? id, 'lesson.title', { max: 500 })
  // page.text：内存页面（spec 编译产物，还没落盘）。只用于演练；正式提交前页面已经写到盘上，
  // 走同一条读盘路径，锁内二次核对的行为不变。
  const pageText = typeof page?.text === 'string' ? page.text : undefined
  const file = pageText === undefined ? resolveLessonFile(workspaceRoot, input.path) : resolveLessonTarget(workspaceRoot, input.path)
  const html = pageText === undefined ? fs.readFileSync(file.absolute) : Buffer.from(pageText, 'utf8')
  if (pageText !== undefined) file.size = html.length
  const htmlText = pageText === undefined ? html.toString('utf8') : pageText
  const fingerprint = sha256(html)
  const assets = scanLocalAssets(workspaceRoot, file.absolute, htmlText)
  // 页面声明的课堂挂点：quiz 的 data-question-id 必须先在档案里登记（teach_question_register）。
  const questionIds = questionIdsOf(htmlText)
  const objectives = Array.isArray(input.objectives) ? input.objectives.map((item) => optionalId(item, 'objectives[]')).filter(Boolean)
    : goals === undefined ? [] : archive?.state.lessons[id]?.objectives ?? []
  assertGoalLinks(goals, objectives)
  const publishedAt = nowIso(input.publishedAt)
  return {
    archive,
    workspaceRoot,
    id,
    title,
    file,
    htmlText,
    fingerprint,
    assets,
    questionIds,
    objectives,
    goals,
    publishedAt,
    existing: archive === null ? undefined : archive.state.lessons[id]
  }
}

/**
 * 这次发布在状态上是不是「什么都不用改」：同指纹、同路径、同标题、同资源、同目标。
 *
 * 老档案发布时没有 questionIds 字段（0.3.x）：页面明明挂了题，侧栏与 teach_status
 * 却显示 0 题。内容与路径都没变、但投影是空而页面真有 id 时，要补一次修订把它填上，
 * 所以这种情况不算幂等。
 * @param {object|undefined} existing 当前投影里的这一课
 * @param {object} plan resolvePublish 的结果
 * @returns {boolean}
 */
function publishUnchanged(existing, plan) {
  if (existing === undefined) return false
  const projected = Array.isArray(existing.questionIds) ? existing.questionIds : []
  if (projected.length === 0 && plan.questionIds.length > 0) return false
  return existing.fingerprint === plan.fingerprint && existing.path === plan.file.relative &&
    existing.title === plan.title && canonicalJson(existing.assets) === canonicalJson(plan.assets) &&
    canonicalJson(existing.objectives) === canonicalJson(plan.objectives)
}

/**
 * 演练：算出正式发布会得到的结果，但不 transact、不递增 revision、不写档案。
 * 回执字段与正式发布同一套，只多 committed:false 与 dryRun:true。
 */
function previewPublish(plan) {
  // 没有档案时给一个空投影，课堂挂点按「全部悬空」算 —— 这正是演练要提前看见的。
  const state = plan.archive === null ? { lessons: {}, questions: {}, materials: {} } : plan.archive.state
  const unchanged = publishUnchanged(plan.existing, plan)
  const currentRevision = plan.existing?.revision ?? 0
  const result = {
    lessonId: plan.id,
    lessonRevision: currentRevision,
    fingerprint: plan.fingerprint,
    assets: plan.assets,
    path: plan.file.relative,
    idempotent: unchanged && goalChangesOf(plan.archive?.state ?? { mission: null, objectives: {} }, plan.goals).length === 0,
    title: plan.title,
    dryRun: true,
    committed: false
  }
  // 与正式发布同一套非枚举挂载：只给 formatPublish 读文案，不进工具返回值、不进 journal。
  Object.defineProperty(result, 'classroomHooks', {
    value: {
      ...classroomHookOf(state, plan.id, plan.questionIds),
      materials: lessonMaterialsOf(state, plan.file.relative, plan.htmlText)
    },
    enumerable: false
  })
  Object.defineProperty(result, 'nextRevision', {
    value: unchanged ? currentRevision : currentRevision + 1,
    enumerable: false
  })
  return result
}

/**
 * 发布这一步的 change（producer 内用）。
 * 内容没变（同指纹/路径/标题/资源/目标，且页面挂点已填全）返回 change:null —— 幂等。
 * commit 复用同一个构造器，避免两处各写一份发布规则。
 */
export function publishChangeOf(draft, plan) {
  const existing = draft.lessons[plan.id]
  if (publishUnchanged(existing, plan)) return { change: null, existing }
  const lessonRevision = (existing?.revision ?? 0) + 1
  return {
    change: {
      type: 'lesson.published',
      data: {
        id: plan.id,
        title: plan.title,
        path: plan.file.relative,
        revision: lessonRevision,
        fingerprint: plan.fingerprint,
        assets: plan.assets,
        // 页面声明了哪些课堂挂点（已登记的题目才真的能提交）
        questionIds: plan.questionIds,
        objectives: plan.objectives,
        publishedAt: plan.publishedAt
      }
    },
    existing,
    lessonRevision
  }
}

/**
 * 发布课程。
 *  - dryRun:true 只核对（资源清单、指纹、页面声明的挂点、悬空 id），不写档案；
 *  - 正式发布同内容幂等，内容变了才升 revision；悬空 id 只警告不拒绝 ——
 *    题目登记后课堂与侧栏立即生效，不需要重新发布。
 */
export function publishLesson(root, input, { expectedRevision } = {}) {
  const plan = resolvePublish(root, input, { create: false, repairIndex: false })
  if (input.dryRun === true) return previewPublish(plan)
  const { id, title, file, fingerprint, assets, questionIds } = plan
  const archive = openArchive(root, { create: true })

  const published = archive.transact('teach_lesson_publish', expectedRevision, (draft) => {
    const planned = publishChangeOf(draft, plan)
    const goals = goalChangesOf(draft, plan.goals)
    if (planned.change === null) {
      return {
        changes: goals,
        result: { lessonId: id, lessonRevision: planned.existing.revision, fingerprint, assets, path: planned.existing.path, idempotent: goals.length === 0 }
      }
    }
    return {
      changes: [...goals, planned.change],
      result: { lessonId: id, lessonRevision: planned.lessonRevision, fingerprint, assets, path: file.relative, idempotent: false, title }
    }
  })
  // 课堂挂点摘要只给 formatPublish 读文案用：工具输出 schema 是 additionalProperties:false，
  // 所以挂成非枚举属性——它不会随 {...result} 进工具返回值，也不进 journal。
  Object.defineProperty(published, 'classroomHooks', {
    value: {
      ...classroomHookOf(archive.state, id, questionIds),
      materials: lessonMaterialsOf(archive.state, file.relative, plan.htmlText)
    },
    enumerable: false
  })
  return published
}

/**
 * 题目输入校验 + 归一化（不碰档案）。
 * commit 与 teach_question_register 共用，保证两处校验规则一致。
 */
export function questionDataOf(input) {
  const id = optionalId(input.id ?? input.questionId, 'question.id')
  if (id === null) throw new ValidationError('题目需要显式 id')
  const lessonId = optionalId(input.lessonId, 'question.lessonId')
  if (lessonId === null) throw new ValidationError('题目必须属于一节课（lessonId）')
  const type = input.type
  if (!QUESTION_TYPES.includes(type)) throw new ValidationError('题目类型不支持：' + String(type))
  const answer = choiceAnswerOf(type, input.answer)
  if (DETERMINISTIC_TYPES.includes(type) && answer === undefined) {
    throw new ValidationError(type + ' 题需要标准答案；没有标准答案就只能记待复核')
  }
  const prompt = requireString(input.prompt, 'question.prompt')
  return {
    id,
    lessonId,
    type,
    prompt,
    objectiveId: optionalId(input.objectiveId, 'question.objectiveId'),
    prerequisite: optionalString(input.prerequisite, 'question.prerequisite', 5000),
    options: Array.isArray(input.options) ? input.options : [],
    answer,
    rubric: Array.isArray(input.rubric) ? input.rubric : [],
    materials: Array.isArray(input.materials) ? input.materials : [],
    status: input.status === 'retired' ? 'retired' : 'active'
  }
}

/** 题目内容是否与档案投影完全一致（一致就不写事件，revision 不动 —— C2 的根因修复）。 */
export function questionUnchanged(existing, data) {
  if (existing === undefined) return false
  const same = (left, right) => canonicalJson(left === undefined ? null : left) === canonicalJson(right === undefined ? null : right)
  return (
    existing.lessonId === data.lessonId &&
    existing.type === data.type &&
    existing.prompt === data.prompt &&
    (existing.objectiveId ?? null) === (data.objectiveId ?? null) &&
    (existing.prerequisite ?? '') === (data.prerequisite ?? '') &&
    same(existing.options ?? [], data.options ?? []) &&
    same(existing.answer ?? null, data.answer ?? null) &&
    same(existing.rubric ?? [], data.rubric ?? []) &&
    same(existing.materials ?? [], data.materials ?? []) &&
    (existing.status ?? 'active') === (data.status ?? 'active')
  )
}

/** 登记/更新题目；题目改版会递增 revision，旧评估由此失效。 */
export function registerQuestion(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const data = questionDataOf(input)
  return archive.transact('teach_question_register', expectedRevision, (draft) => {
    if (draft.lessons[data.lessonId] === undefined) throw new ValidationError('题目所属课程还没发布：' + data.lessonId)
    const previous = draft.questions[data.id]
    return {
      changes: [{ type: 'question.upsert', data }],
      result: { questionId: data.id, questionRevision: (previous?.revision ?? 0) + 1, lessonId: data.lessonId }
    }
  })
}

function normalizeAnswer(value) {
  if (typeof value === 'string') return value
  return canonicalJson(value)
}

function normalizeShort(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * choice 题的标准答案：字符串（单选）或字符串数组（多选）。
 * 数组要每项 trim 后非空字符串、去重后至少 1 项；其它类型（数字、对象、null）
 * 一律拒绝——不然后面只能判成「与标准答案不一致」，把登记错误藏成判分错误。
 */
function choiceAnswerOf(type, value) {
  if (type !== 'choice' || value === undefined) return value
  if (typeof value === 'string') {
    if (value.trim() === '') throw new ValidationError('choice 题的标准答案不能是空字符串')
    return value
  }
  if (!Array.isArray(value)) {
    throw new ValidationError('choice 题的标准答案必须是字符串或字符串数组（数组 = 多选）')
  }
  const items = []
  for (const item of value) {
    if (typeof item !== 'string') throw new ValidationError('choice 多选的标准答案每一项都必须是字符串')
    const trimmed = item.trim()
    if (trimmed === '') throw new ValidationError('choice 多选的标准答案不能有空项')
    if (!items.includes(trimmed)) items.push(trimmed)
  }
  if (items.length === 0) throw new ValidationError('choice 多选的标准答案至少要有 1 项')
  return items
}

/** 集合比较用的口径：去重后排序（多选与单选都走这套，单选退化成一个元素的集合）。 */
function choiceSetOf(values) {
  return [...new Set(values)].sort()
}

/**
 * 学习者实际交上来的选项集合。支持三种写法：
 *   JSON 数组字符串 '["a","b"]'、英文逗号/中文顿号分隔 'a,b' / 'a、b'、单值 'a'。
 * 单值不做 trim：单选在 0.6.1 是逐字比较，这一条必须保持原样。
 */
function choiceAnswersOf(rawAnswer) {
  if (Array.isArray(rawAnswer)) return rawAnswer.map(normalizeAnswer)
  if (typeof rawAnswer !== 'string') return [normalizeAnswer(rawAnswer)]
  const trimmed = rawAnswer.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map(normalizeAnswer)
    } catch {
      // 不是合法 JSON 数组就按分隔符/单值处理
    }
  }
  if (/[,、]/.test(rawAnswer)) {
    return rawAnswer
      .split(/[,、]/)
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .map(normalizeAnswer)
  }
  return [normalizeAnswer(rawAnswer)]
}

/**
 * 确定性判分。返回 {supported, correct, expected}；
 * supported=false 表示这个题型不能由 host 自动判，应交模型或人工。
 */
export function gradeDeterministic(question, rawAnswer) {
  if (!question || !DETERMINISTIC_TYPES.includes(question.type) || question.answer === null || question.answer === undefined) {
    return { supported: false }
  }
  const answer = question.answer
  if (question.type === 'choice') {
    // 多选按集合判分：标准答案给数组，提交可以是 'a,b' / '["a","b"]' / 'a、b'；
    // 单选（标准答案是字符串）仍然是「逐字相等」，与 0.6.1 完全一致。
    const expected = Array.isArray(answer) ? choiceSetOf(answer.map(normalizeAnswer)) : [normalizeAnswer(answer)]
    if (expected.length === 1 && normalizeAnswer(rawAnswer) === expected[0]) {
      return { supported: true, correct: true, expected }
    }
    const actual = choiceSetOf(choiceAnswersOf(rawAnswer))
    const correct = actual.length === expected.length && actual.every((item, index) => item === expected[index])
    return { supported: true, correct, expected }
  }
  if (question.type === 'numeric') {
    const expected = typeof answer === 'number' ? { value: answer, tolerance: 0 } : answer
    const actual = Number(String(rawAnswer).trim())
    const tolerance = Number(expected?.tolerance ?? 0)
    const correct = Number.isFinite(actual) && Math.abs(actual - Number(expected?.value)) <= (Number.isFinite(tolerance) ? tolerance : 0)
    return { supported: true, correct }
  }
  if (question.type === 'short') {
    const alternatives = Array.isArray(answer) ? answer : [answer]
    const actual = normalizeShort(rawAnswer)
    const correct = alternatives.some((item) => normalizeShort(item) === actual)
    return { supported: true, correct }
  }
  return { supported: false }
}

function idempotencyKeyFor(input, questionId, rawAnswer) {
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim().length > 0) {
    if (input.idempotencyKey.length > 500) throw new ValidationError('idempotencyKey 太长')
    return input.idempotencyKey
  }
  return 'auto:' + questionId + ':' + sha256(questionId + '\n' + rawAnswer).slice(0, 32)
}

/**
 * 登记一次提交。原始答案先落库；choice/numeric/short 由 host 确定性判分，
 * 其余题型保持待评（needs_review 或交给 teach_evaluate），不会自报通过。
 */
export function recordSubmission(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const questionId = optionalId(input.questionId, 'submission.questionId')
  if (questionId === null) throw new ValidationError('提交必须指明题目 questionId')
  const raw = normalizeAnswer(input.rawAnswer)
  if (typeof raw !== 'string') throw new ValidationError('rawAnswer 必须是字符串或可序列化值')
  if (raw.length > 100000) throw new ValidationError('rawAnswer 太长')
  const source = SUBMISSION_SOURCES.includes(input.source) ? input.source : 'other'
  const baseKey = idempotencyKeyFor(input, questionId, raw)
  const requestHash = sha256('submission\n' + questionId + '\n' + raw)
  const submissionId = randomId('sub')
  const submittedAt = nowIso(input.submittedAt)

  return archive.transact('teach_submission_record', expectedRevision, (draft) => {
    const question = draft.questions[questionId]
    const lesson = question === undefined ? undefined : draft.lessons[question.lessonId]
    const sameContext = (submission) => submission !== undefined &&
      (submission.contentVersion ?? null) === (lesson?.contentVersion ?? null) && submission.questionRevision === (question?.revision ?? 0) && submission.lessonRevision === (lesson?.revision ?? 0) &&
      submission.source === source && submission.hintsUsed === (input.hintsUsed === true) && submission.showedSolution === (input.showedSolution === true)
    const explicitKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim().length > 0
    const legacy = draft.idempotency[baseKey]
    let key = baseKey
    if (!explicitKey && !sameContext(draft.submissions[legacy?.targetId])) {
      key += (lesson?.contentVersion ? ':v' + lesson.contentVersion : '') + ':q' + (question?.revision ?? 0) + ':l' + (lesson?.revision ?? 0) + ':' + source + ':' + (input.hintsUsed === true) + ':' + (input.showedSolution === true)
    }
    const prior = draft.idempotency[key]
    if (prior !== undefined) {
      if (prior.requestHash !== requestHash || !sameContext(draft.submissions[prior.targetId])) throw new IdempotencyConflictError(key)
      const existing = draft.submissions[prior.targetId]
      // 幂等命中也要把「这次提交现在是什么结论」带回去：0.6.1 只回 status 和
      // assessmentId，调用方看到「没有 verdict」会以为还没评过分。书架/课堂重放
      // 同一次提交时因此重复上报。verdict 走统一的 verdictViewOf 口径：
      // 只要曾有过评估就给结论（可能是已失效的历史结论，stale 标出来），
      // 从没评过才给 null + reason。
      const view = existing === undefined ? { verdict: null, stale: false, staleReason: '' } : verdictViewOf(draft, existing)
      return {
        changes: [],
        result: {
          submissionId: prior.targetId,
          status: existing?.status ?? 'pending',
          assessmentId: existing?.latestAssessmentId ?? null,
          verdict: view.verdict,
          reason: view.verdict === null ? '这次提交之前已经记过，还没有评估' : '',
          questionRevision: existing?.questionRevision ?? 0,
          stale: view.stale,
          staleReason: view.staleReason,
          idempotent: true,
          questionId,
          rawAnswer: raw
        }
      }
    }

    const changes = [
      {
        type: 'submission.recorded',
        data: {
          id: submissionId,
          questionId,
          questionRevision: question?.revision ?? 0,
          lessonId: question?.lessonId ?? null,
          lessonRevision: lesson?.revision ?? 0,
          ...(lesson?.contentVersion ? { contentVersion: lesson.contentVersion } : {}),
          rawAnswer: raw,
          source,
          hintsUsed: input.hintsUsed === true,
          showedSolution: input.showedSolution === true,
          idempotencyKey: key,
          requestHash,
          submittedAt
        }
      }
    ]

    let assessmentId = null
    let verdict = null
    let reason = ''
    if (question === undefined) {
      reason = '题目不在档案里，原始答案已保存，等补录题目后再评'
    } else if (question.status === 'retired') {
      reason = '题目已作废，原始答案已保存，不会算通过'
      verdict = 'needs_review'
    } else {
      const graded = gradeDeterministic(question, raw)
      if (graded.supported) {
        verdict = graded.correct ? 'passed' : 'needs_practice'
        assessmentId = randomId('as')
        changes.push({
          type: 'assessment.recorded',
          data: {
            id: assessmentId,
            submissionId,
            questionRevision: question.revision,
            verdict,
            criteria: [
              {
                id: 'deterministic-answer',
                met: graded.correct,
                evidence: graded.correct ? '提交与标准答案一致（host 确定性判分）' : '提交与标准答案不一致（host 确定性判分）'
              }
            ],
            method: { kind: 'deterministic', grader: 'host' },
            materialsFingerprint: materialsFingerprintOf(draft, question.materials ?? []),
            reason: graded.correct ? '' : '答案错了，按需练习处理'
          }
        })
      } else {
        reason = question.type + ' 题需要按标准评估；原始答案已保存，用 teach_evaluate 记录逐条证据'
      }
    }
    return {
      changes,
      result: {
        submissionId,
        status: verdict === null ? 'pending' : verdict === 'needs_review' ? 'needs_review' : 'evaluated',
        assessmentId,
        verdict,
        reason,
        idempotent: false,
        questionId,
        questionRevision: question?.revision ?? 0,
        rawAnswer: raw
      }
    }
  })
}

function normalizeCriteria(input) {
  if (!Array.isArray(input)) return []
  return input.map((item, index) => {
    if (!isPlainObject(item)) throw new ValidationError('criteria[' + index + '] 必须是对象')
    const id = optionalString(item.id, 'criteria[' + index + '].id', 200) || 'criterion-' + (index + 1)
    return {
      id,
      met: item.met === true,
      evidence: optionalString(item.evidence, 'criteria[' + index + '].evidence', 10000)
    }
  })
}

/**
 * 题目登记的 rubric 与这次逐条标准的 id 必须一一对应；不一致时返回一句能直接
 * 给学习者看的说明（缺什么、多出什么），一致返回 null。
 * rubric 为空（存量题目没登记标准）不做校验：那种题仍然可以人工评估。
 */
function rubricMismatchOf(rubricIds, criteria) {
  if (rubricIds.length === 0 || criteria.length === 0) return null
  const expected = new Set(rubricIds)
  const actual = new Set(criteria.map((item) => String(item.id)))
  const missing = rubricIds.filter((id) => !actual.has(id))
  const extra = [...actual].filter((id) => !expected.has(id))
  if (missing.length === 0 && extra.length === 0) return null
  const parts = []
  if (missing.length > 0) parts.push('缺 ' + missing.join('、'))
  if (extra.length > 0) parts.push('多出 ' + extra.join('、'))
  return '评分标准与题目登记的不一致：' + parts.join('；')
}

/** 标准答案判错、但逐条标准全过的情形要单独认出来（确定性题型才可能）。 */
function deterministicConflictOf(question, submission) {
  if (question === undefined || !DETERMINISTIC_TYPES.includes(question.type)) return false
  const answer = question.answer
  if (answer === null || answer === undefined) return false
  if (typeof answer === 'string' && answer.trim() === '') return false
  if (Array.isArray(answer) && answer.length === 0) return false
  const graded = gradeDeterministic(question, submission.rawAnswer)
  return graded.supported === true && graded.correct === false
}

/**
 * 记录评估。调用方只能给逐条标准与证据，不能直接说「通过」；
 * 结论由 host 按「全部满足 + 每项有证据」推导。导师模型的输出同样走这里。
 *
 * 判定链（命中一条就停）：题目不存在 → 提交针对旧题版本 → 题目作废 → 课程改版
 * → 材料指纹 → rubric 覆盖 → 确定性判分冲突 → 空标准 → 全满足/部分不满足/缺证据。
 * rubric 覆盖与确定性一致性这两条是 0.6.2 补的：它们都把「模型/人工自己挑一套
 * 标准」或「标准答案明明判错却全过」挡在 passed 之外，只能落 needs_review。
 * 例外：method.kind === 'override' 且 method.reason 非空，允许人工改判通过，
 * 并在 reason 前面留「人工覆盖：」的痕迹。
 */
export function evaluateSubmission(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const submissionId = optionalId(input.submissionId, 'evaluate.submissionId')
  if (submissionId === null) throw new ValidationError('评估必须指明 submissionId')
  const historical = archive.state.submissions[submissionId]
  if (historical?.contentVersion && archive.state.lessons[historical.lessonId]?.contentVersion !== historical.contentVersion && archive.state.lessonVersions?.[historical.lessonId]?.[historical.contentVersion]) {
    return withLearningScope({ ...learningScope(), lessonId: historical.lessonId, contentVersion: historical.contentVersion }, () => evaluateSubmission(root, input, { expectedRevision }))
  }
  const criteria = normalizeCriteria(input.criteria)
  const method = isPlainObject(input.method) ? input.method : { kind: 'manual' }
  const assessmentId = randomId('as')

  return archive.transact('teach_evaluate', expectedRevision, (draft) => {
    const submission = draft.submissions[submissionId]
    if (submission === undefined) throw new ValidationError('没有这次提交：' + submissionId)
    const question = draft.questions[submission.questionId]
    let verdict
    let reason = optionalString(input.reason, 'evaluate.reason', 10000)
    const currentMaterials = question === undefined ? null : materialsFingerprintOf(draft, question.materials ?? [])
    const suppliedMaterials = input.materialsFingerprint === undefined ? null : optionalString(input.materialsFingerprint, 'evaluate.materialsFingerprint', 200)
    const lesson = submission.lessonId === null || submission.lessonId === undefined ? undefined : draft.lessons[submission.lessonId]
    const rubricIds = question === undefined ? [] : normalizeRubric(question.rubric).map((item) => item.id)
    // 空 criteria 时「rubric 一致」与「确定性一致」都算没问题；但 [].every() 恒为 true，
    // 不能直接拿它当「会通过」，所以 wouldPass 先要求 criteria 非空。
    const wouldPass = criteria.length > 0 && criteria.every((item) => item.met && item.evidence.trim().length > 0)
    const rubricMismatch = rubricMismatchOf(rubricIds, criteria)
    const deterministicConflict = deterministicConflictOf(question, submission)
    const overridden = method.kind === 'override' && typeof method.reason === 'string' && method.reason.trim() !== ''
    if (question === undefined) {
      verdict = 'needs_review'
      reason = reason || '题目不在档案里，不能形成通过'
    } else if (submission.questionRevision !== question.revision) {
      verdict = 'needs_review'
      reason = reason || '提交针对旧版题目（v' + submission.questionRevision + '，现在 v' + question.revision + '），不能算通过'
    } else if (question.status === 'retired') {
      verdict = 'needs_review'
      reason = reason || '题目已作废，不能算通过'
    } else if (lesson !== undefined && lesson.revision !== submission.lessonRevision) {
      verdict = 'needs_review'
      reason = reason || '课程已改版（提交针对旧版课程），不能算通过'
    } else if (suppliedMaterials !== null && suppliedMaterials !== currentMaterials) {
      verdict = 'needs_review'
      reason = reason || '评估依据的材料版本与当前档案不一致'
    } else if (rubricMismatch !== null) {
      // 题目登记了 rubric 就必须逐条对上号：漏评、多评都不能算通过。
      verdict = 'needs_review'
      reason = reason || rubricMismatch
    } else if (deterministicConflict && wouldPass && !overridden) {
      verdict = 'needs_review'
      reason = reason || '确定性判分与逐条标准不一致：标准答案判为错误'
    } else if (criteria.length === 0) {
      verdict = 'needs_review'
      reason = reason || '没有逐条评分标准，不能形成通过'
    } else if (wouldPass) {
      verdict = 'passed'
      if (deterministicConflict) {
        // 走到这里说明有 override：人工改判通过，但要把「这不是标准答案判出来的」留在记录里。
        // reason 优先用调用方给学习者的说明，其次用 method.reason（老师写下的改判理由）。
        const overrideReason = reason !== '' ? reason : typeof method.reason === 'string' ? method.reason.trim() : ''
        reason = '人工覆盖：' + (overrideReason === '' ? '按人工判断改判通过（与标准答案不一致）' : overrideReason)
      }
    } else if (criteria.some((item) => !item.met)) {
      verdict = 'needs_practice'
    } else {
      verdict = 'needs_review'
      reason = reason || '有关键标准缺少独立证据'
    }
    return {
      changes: [
        {
          type: 'assessment.recorded',
          data: {
            id: assessmentId,
            submissionId,
            questionRevision: question?.revision ?? submission.questionRevision,
            verdict,
            criteria,
            method,
            materialsFingerprint: currentMaterials,
            reason
          }
        }
      ],
      result: { assessmentId, submissionId, verdict, reason, committed: true }
    }
  })
}

/** 作废一条评估（质疑/错判改判），历史保留。 */
export function voidAssessment(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const assessmentId = optionalId(input.assessmentId, 'assessmentId')
  if (assessmentId === null) throw new ValidationError('需要 assessmentId')
  const reason = requireString(input.reason, '作废原因', { max: 5000 })
  return archive.transact('teach_assessment_void', expectedRevision, () => ({
    changes: [{ type: 'assessment.voided', data: { id: assessmentId, reason } }],
    result: { assessmentId, voided: true }
  }))
}

function nextIntervalFor(draft, questionId) {
  if (questionId === null) return REVIEW_INTERVALS[0]
  const count = Object.values(draft.reviews).filter((review) => review.questionId === questionId).length
  return REVIEW_INTERVALS[Math.min(count, REVIEW_INTERVALS.length - 1)]
}

/** 安排复习：默认按 1/3/7/14 天阶梯；可以跳过（finishReview skip）。 */
export function scheduleReview(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const questionId = optionalId(input.questionId, 'review.questionId')
  const objectiveId = optionalId(input.objectiveId, 'review.objectiveId')
  if (questionId === null && objectiveId === null) throw new ValidationError('复习要关联题目或目标')
  const id = optionalId(input.id, 'review.id') ?? randomId('rev')
  return archive.transact('teach_review_schedule', expectedRevision, (draft) => {
    if (questionId !== null && draft.questions[questionId] === undefined) throw new ValidationError('没有这道题：' + questionId)
    const intervalDays = Number.isInteger(input.intervalDays) ? input.intervalDays : nextIntervalFor(draft, questionId)
    if (intervalDays < 1 || intervalDays > 3650) throw new ValidationError('复习间隔必须是 1–3650 天')
    const dueAt = input.dueAt === undefined ? nowIso(Date.now() + intervalDays * DAY_MS) : nowIso(input.dueAt)
    return {
      changes: [{ type: 'review.scheduled', data: { id, questionId, objectiveId, dueAt, intervalDays } }],
      result: { reviewId: id, questionId, objectiveId, dueAt, intervalDays }
    }
  })
}

/** 结束一次复习；result 只能是 completed 或 skipped，跳过不记成掌握。 */
export function finishReview(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const reviewId = optionalId(input.reviewId, 'reviewId')
  if (reviewId === null) throw new ValidationError('需要 reviewId')
  const result = input.result
  if (result !== 'completed' && result !== 'skipped') throw new ValidationError('复习结果只能是 completed 或 skipped')
  return archive.transact('teach_review_finish', expectedRevision, (draft) => {
    const review = draft.reviews[reviewId]
    if (review === undefined) throw new ValidationError('没有这条复习：' + reviewId)
    if (review.state === result) return { changes: [], result: { reviewId, result, idempotent: true } }
    return {
      changes: [{ type: 'review.finished', data: { id: reviewId, result } }],
      result: { reviewId, result, idempotent: false }
    }
  })
}

/**
 * 从状态里算到期队列：只读，不发通知、不写盘。
 * 每条带 id/题目/目标/到期时间/间隔/逾期天数/题目状态，方便导师决定先复习哪条。
 */
function dueQueueOf(state, at) {
  const due = []
  let nextDueAt = null
  for (const review of Object.values(state.reviews)) {
    if (review.state !== 'scheduled') continue
    const dueTime = Date.parse(review.dueAt)
    if (Number.isNaN(dueTime)) continue
    if (dueTime > at) {
      if (nextDueAt === null || dueTime < Date.parse(nextDueAt)) nextDueAt = review.dueAt
      continue
    }
    const question = review.questionId === null || review.questionId === undefined ? undefined : state.questions[review.questionId]
    due.push({
      id: review.id,
      questionId: review.questionId ?? null,
      objectiveId: review.objectiveId ?? null,
      dueAt: review.dueAt,
      intervalDays: review.intervalDays,
      overdueDays: Math.floor((at - dueTime) / DAY_MS),
      questionStatus: review.questionId === null || review.questionId === undefined ? 'no-question' : question === undefined ? 'missing' : question.status,
      questionType: question?.type ?? null,
      questionRevision: question?.revision ?? null
    })
  }
  due.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id))
  return { due, nextDueAt }
}

/**
 * 到期复习队列（只读）。档案没建立时返回 initialized:false，不创建任何文件。
 * now 可注入，测试与离线诊断用同一套判定。
 */
export function listDueReviews(root, { now = Date.now() } = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  // repairIndex:false —— 纯读：连落后的索引都不补写，队列查询不改磁盘。
  const archive = tryOpenArchive(root, { repairIndex: false })
  if (archive === null) return { initialized: false, now: nowIso(at), due: [], dueCount: 0, nextDueAt: null }
  const queue = dueQueueOf(archive.state, at)
  return { initialized: true, now: nowIso(at), due: queue.due, dueCount: queue.due.length, nextDueAt: queue.nextDueAt }
}

/** 索引一份材料；文件必须在工作区内，URL 默认 unverified。 */
export function indexMaterial(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const workspaceRoot = archive.root
  const id = optionalId(input.id ?? input.materialId, 'material.id') ?? randomId('mat')
  const kind = input.kind === 'url' ? 'url' : 'file'
  const title = requireString(input.title ?? id, 'material.title', { max: 500 })
  let relative = null
  let url = null
  let digest = null
  if (kind === 'file') {
    relative = resolveWorkspaceFile(workspaceRoot, input.path).relative
    digest = sha256(fs.readFileSync(path.join(workspaceRoot, relative)))
  } else {
    url = requireString(input.url, 'material.url', { max: 2000 })
    if (!/^https?:\/\//i.test(url)) throw new ValidationError('资料 URL 必须是 http(s)')
    if (typeof input.sha256 === 'string') digest = input.sha256
  }
  const retrievedAt = nowIso(input.retrievedAt)
  const status = input.status === 'verified' ? 'verified' : 'unverified'
  return archive.transact('teach_material_index', expectedRevision, () => ({
    changes: [
      {
        type: 'material.indexed',
        data: {
          id,
          kind,
          path: relative,
          url,
          title,
          location: optionalString(input.location, 'material.location', 500),
          excerpt: optionalString(input.excerpt, 'material.excerpt'),
          version: optionalString(input.version, 'material.version', 200),
          retrievedAt,
          sha256: digest,
          status,
          verifiedAt: status === 'verified' ? nowIso() : null
        }
      }
    ],
    result: { materialId: id, kind, status, sha256: digest, path: relative, url }
  }))
}

/** 记录学习者的自报（导入/离线自测），只作 self_report，不形成 passed。 */
export function recordSelfReport(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const id = optionalId(input.id, 'selfReport.id')
  if (id === null) throw new ValidationError('自报需要显式 id')
  const claim = requireString(input.claim, 'selfReport.claim', { max: 2000 })
  const questionId = optionalId(input.questionId, 'selfReport.questionId')
  const objectiveId = optionalId(input.objectiveId, 'selfReport.objectiveId')
  return archive.transact('teach_self_report', expectedRevision, (draft) => {
    const existing = draft.selfReports[id]
    if (existing !== undefined) {
      if (existing.claim === claim && existing.questionId === questionId && existing.objectiveId === objectiveId) return { changes: [], result: { selfReportId: id, idempotent: true } }
      throw new IdempotencyConflictError(id)
    }
    return {
      changes: [
        {
          type: 'self_report.recorded',
          data: {
            id,
            questionId,
            objectiveId,
            claim
          }
        }
      ],
      result: { selfReportId: id, idempotent: false }
    }
  })
}

/**
 * 记录学习者明确暂缓（这次先跳过/等以后）。只写 deferral 事件：
 * 不改评估、不改复习状态、不产生 passed。同 id 同内容幂等，不同内容硬冲突。
 */
export function recordDeferral(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const questionId = optionalId(input.questionId, 'deferral.questionId')
  const objectiveId = optionalId(input.objectiveId, 'deferral.objectiveId')
  if (questionId === null && objectiveId === null) throw new ValidationError('暂缓要关联题目或目标，不能只说「先跳过」')
  const reason = optionalString(input.reason, 'deferral.reason', 5000)
  const until = optionalIso(input.until, 'deferral.until')
  const id = optionalId(input.id, 'deferral.id') ?? randomId('defer')
  return archive.transact('teach_defer', expectedRevision, (draft) => {
    if (questionId !== null && draft.questions[questionId] === undefined) throw new ValidationError('没有这道题：' + questionId)
    const existing = draft.deferrals[id]
    if (existing !== undefined) {
      const same = existing.questionId === questionId && existing.objectiveId === objectiveId && existing.reason === reason && existing.until === until
      if (same) return { changes: [], result: { deferralId: id, questionId, objectiveId, reason, until, idempotent: true } }
      throw new IdempotencyConflictError(id)
    }
    return {
      changes: [{ type: 'deferral.recorded', data: { id, questionId, objectiveId, reason, until } }],
      result: { deferralId: id, questionId, objectiveId, reason, until, idempotent: false }
    }
  })
}

/** 空档案的课堂挂点：形状与非空时一致，调用方不用判空。 */
function emptyClassroomHooks() {
  return { pageQuestions: 0, registered: 0, dangling: 0, danglingIds: [], archiveOnlyIds: [], lessons: [] }
}

/** 只读状态；未初始化返回初始化提示，不改磁盘。 */
export function archiveStatus(root, options = {}) {
  const archive = Object.hasOwn(options, 'archive') ? options.archive : tryOpenArchive(root, { repairIndex: false })
  if (archive === null) {
    return {
      initialized: false,
      summary: null,
      dueReviews: [],
      dueCount: 0,
      nextDueAt: null,
      warnings: [],
      classroomHooks: emptyClassroomHooks()
    }
  }
  const queue = dueQueueOf(archive.state, options.now ?? Date.now())
  return {
    initialized: true,
    summary: archive.summary(),
    dueReviews: queue.due,
    dueCount: queue.due.length,
    nextDueAt: queue.nextDueAt,
    warnings: archive.warnings,
    // 课堂挂点：页面声明的 data-question-id 与已登记题目的对账（teach_status 用）。
    classroomHooks: classroomHooksOf(archive.state)
  }
}

/** 重建索引（诊断/修复用）。 */
export function rebuildArchive(root) {
  return openArchive(root, { create: false }).rebuild()
}

/** 把当前档案状态导出成可检查对象（课堂导出/诊断用）。 */
export function readArchiveState(root) {
  const archive = tryOpenArchive(root, { repairIndex: false })
  return archive === null ? null : archive.state
}

export { staleReason }

/* —————————————————————————— 动画产物 —————————————————————————— */

/** 可选的 sha256 十六进制；空值给 null，格式不对明确失败。 */
function optionalSha256Hex(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ValidationError(label + ' 必须是 64 位十六进制 sha256')
  }
  return value
}

/** 可选的非负整数（帧数、毫秒数）；空值给 null。 */
function optionalNonNegativeInteger(value, label) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) throw new ValidationError(label + ' 必须是非负整数')
  return number
}

/** 可选的正数（fps 允许小数，例如 29.97）；空值给 null。 */
function optionalPositiveNumber(value, label) {
  if (value === undefined || value === null) return null
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new ValidationError(label + ' 必须是正数')
  return number
}

/**
 * 记录一次动画渲染产物（事件 lesson.artifact）。
 *
 * 教学档案只记「产物是什么」：路径 + 内容 sha256 + 帧数 / 时长 / fps，
 * 不复制文件本身。lessonId 可以缺省（渲染时这一课可能还没发布），此时只记 path；
 * 同一个 path 再次渲染会追加新事件，投影（state.js）保留最新一条，旧记录留在日志里。
 * at 缺省用当前时间；path 由调用方决定相对于工程根还是工作区，这里只做索引。
 */
export function recordArtifact(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const source = input ?? {}
  const lessonId = optionalId(source.lessonId, 'artifact.lessonId')
  const artifactPath = requireString(source.path, 'artifact.path', { max: 2000 })
  const digest = optionalSha256Hex(source.sha256, 'artifact.sha256')
  const frames = optionalNonNegativeInteger(source.frames, 'artifact.frames')
  const durationMs = optionalNonNegativeInteger(source.durationMs, 'artifact.durationMs')
  const fps = optionalPositiveNumber(source.fps, 'artifact.fps')
  // 静帧产物按帧号区分：render（成片）为 null，still 记下是哪一帧。老档案没有这一位，
  // 投影侧按 null 处理，不给旧日志补默认值。
  const frame = optionalNonNegativeInteger(source.frame, 'artifact.frame')
  // 产物绑课程版本（0.6.4-D4）：调用方显式给了就用它（渲染起手时定格的那一版），
  // 没给就在事务里读档案这一刻的课程版本 —— 两种都不会「事后补算出另一个值」。
  const lessonRevisionGiven = Object.hasOwn(source, 'lessonRevision')
  const requestedLessonRevision = lessonRevisionGiven ? optionalPositiveInteger(source.lessonRevision, 'artifact.lessonRevision') : null
  const at = optionalIso(source.at, 'artifact.at') ?? nowIso()
  return archive.transact('teach_artifact_record', expectedRevision, (draft) => {
    const lessonRevision = lessonRevisionGiven
      ? requestedLessonRevision
      : lessonId === null
        ? null
        : draft.lessons?.[lessonId]?.revision ?? null
    return {
      changes: [
        {
          type: 'lesson.artifact',
          data: { lessonId, lessonRevision, path: artifactPath, sha256: digest, frames, durationMs, fps, frame, at }
        }
      ],
      result: { lessonId, lessonRevision, path: artifactPath, sha256: digest, frames, durationMs, fps, frame, at, committed: true }
    }
  })
}

/**
 * 记一条动画渲染作业事件（事件 animation.job，0.6.4-D4）。
 *
 * append-only：起手写 state='running'，结算时用同一个 jobId 再写一条终态；
 * 投影（state.js）按 jobId 覆盖，所以重启后能从档案回答「上次到哪一步」。
 * input.root 是**动画工程根 realpath**（不是教学档案根；函数第一个参数 root 仍是档案/工作区根）——
 * inspect 按它过滤，写歪了就报出别人的作业。
 * lessonRevision 允许 null（渲染时课程还没发布）。
 */
export function recordAnimationJob(root, input, { expectedRevision } = {}) {
  const archive = openArchive(root, { create: true })
  const source = input ?? {}
  const jobId = requireId(source.jobId, 'animation.jobId')
  const projectRoot = requireString(source.root, 'animation.root', { max: 2000 })
  const composition = requireString(source.composition, 'animation.composition', { max: 128 })
  const mode = ANIMATION_JOB_MODES.includes(source.mode) ? source.mode : null
  if (mode === null) throw new ValidationError('animation.mode 只能是 still 或 render')
  const output = requireString(source.output, 'animation.output', { max: 2000 })
  const lessonRevision = optionalPositiveInteger(source.lessonRevision, 'animation.lessonRevision')
  if (!ANIMATION_JOB_STATES.includes(source.state)) {
    throw new ValidationError('animation.state 不支持：' + String(source.state))
  }
  const jobState = source.state
  const at = optionalIso(source.at, 'animation.at') ?? nowIso()
  return archive.transact('teach_animation_job', expectedRevision, () => ({
    changes: [
      {
        type: 'animation.job',
        // 老版本重放时靠 FORWARD_COMPAT_EVENT_TYPES 跳过这条；这里保持字段只增不改。
        data: { jobId, root: projectRoot, composition, mode, output, lessonRevision, state: jobState, at }
      }
    ],
    result: { jobId, root: projectRoot, composition, mode, output, lessonRevision, state: jobState, at, committed: true }
  }))
}
