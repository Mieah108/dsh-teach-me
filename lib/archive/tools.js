/* 教学档案的工具面：发布课程、登记题目与提交、记录评估、复习、资料索引、
 * 自报/暂缓，以及开放题的模型盲评。
 *
 * 工具只做「把学习者的真实动作写进档案」，不做推断：
 * 提交先存原始答案；评估只收逐条标准与证据；自报与暂缓各自独立、都不产生通过；
 * 模型批改也走同一条评估路径，通过由 host 按证据推导。
 * 工作区解析不到时所有工具都明确失败，不退回当前目录。 */

import fs from 'node:fs'
import path from 'node:path'

import { compileSpecAt, describeSpecError, isSpecPath, questionsOfSpec, specLintErrors } from '../lessonspec/integrate.js'

import { commitLesson } from './commit.js'
import { CommitRejectedError } from './errors.js'
import { describeError } from './errors.js'
import { gradeOpenSubmission } from './grading.js'
import { GOAL_PARAMETERS, assertGoalLinks, goalInputOf } from './goals.js'
import { pruneEmpty } from './util.js'
import {
  archiveStatus,
  evaluateSubmission,
  finishReview,
  indexMaterial,
  listDueReviews,
  publishLesson,
  readArchiveState,
  recordDeferral,
  recordSelfReport,
  recordSubmission,
  registerQuestion,
  scheduleReview,
  voidAssessment
} from './operations.js'

/**
 * 工具返回值 schema。
 *
 * 只有 text / ok 是必填：失败返回（见 failure）本来就不带领域字段，把 lessonId、materialId
 * 这类字段写进 required 会让「工具报错」这件事本身被宿主的严格校验判成 invalid output，
 * 于是模型永远看不到真实原因（2026-10 的测试会话里 teach_material_index 就这样藏掉了一次
 * 路径错误）。领域字段一律可选，由 test/unit/tool-output-contract.test.js 保证成功路径一定带上。
 *
 * revision / committed 是 archive.transact 给每个写操作追加的回执字段，之前漏声明，
 * 让 publish / register / submission 的成功路径全被判成多出未声明属性。
 */
function output(properties) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text', 'ok'],
      properties: {
        text: { type: 'string', description: '人读回执。' },
        ok: { type: 'boolean', description: '这次动作是否成功写入/读到档案。' },
        error: { type: 'string', description: '失败代码。' },
        revision: { type: 'integer', description: '写入后的档案版本。' },
        committed: { type: 'boolean', description: '这次是否真的写进了 journal；幂等重放为 false。' },
        ...properties
      }
    },
    render: (_args, value) => [{ type: 'text', text: value.text }]
  }
}

const REVISION = {
  type: 'integer',
  description: '写前期望的档案版本。带上它可以避免覆盖别人刚提交的内容；冲突时不会写入。'
}

function workspaceOfOrFail(workspaceOf, exec) {
  try {
    return { root: workspaceOf(exec?.agent) }
  } catch (error) {
    return { error }
  }
}

function failure(error) {
  return {
    text: `没有写入：${error instanceof Error ? error.message : String(error)}`,
    ok: false,
    error: error?.code ?? 'error'
  }
}

function withArchive(workspaceOf, fn) {
  return async (args, exec) => {
    const resolved = workspaceOfOrFail(workspaceOf, exec)
    if (resolved.error !== undefined) return failure(resolved.error)
    try {
      return pruneEmpty({ ok: true, ...(await fn(resolved.root, args ?? {}, exec)) })
    } catch (error) {
      return failure(error)
    }
  }
}

/**
 * 取这条会话的模型路由：优先它自己的请求头（就是这一轮真正在用的导师模型），
 * 其次宿主默认模型。都没有返回 null，由调用方给明确失败。
 */
export function resolveModelRoute(ctx, exec) {
  const session = exec?.agent?.session ?? (typeof ctx.get === 'function' ? ctx.get('agents')?.get?.(exec?.agent?.id)?.session : undefined)
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const config = header?.config
    if (typeof config?.provider === 'string' && config.provider !== '' && typeof config?.model === 'string' && config.model !== '') {
      return { provider: config.provider, model: config.model }
    }
  } catch {
    // 请求头读不到就退回默认模型，不让一次读取失败挡掉批改
  }
  try {
    const selection = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel')?.currentSelection?.() : undefined
    if (typeof selection?.provider === 'string' && selection.provider !== '' && typeof selection?.model === 'string' && selection.model !== '') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    // 同上：拿不到就当没有路由
  }
  return null
}

/** 宿主的 llm 服务；没有就返回 undefined（模型批改必须明确失败，不能伪造通过）。 */
function llmOf(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('llm') : undefined
  } catch {
    return undefined
  }
}

function formatDueQueue(queue) {
  if (queue.initialized !== true) return '档案还没建立，没有到期复习。'
  if (queue.due.length === 0) {
    return '现在没有到期复习。' + (queue.nextDueAt === null ? '' : '下一次到期：' + queue.nextDueAt + '。')
  }
  const lines = ['到期复习 ' + queue.due.length + ' 条（可以挑几条做，其余跳过；不发通知）：']
  for (const item of queue.due) {
    const target = item.questionId === null ? '目标 ' + item.objectiveId : '题目 ' + item.questionId
    const overdue = item.overdueDays <= 0 ? '今天到期' : '逾期 ' + item.overdueDays + ' 天'
    lines.push('- ' + item.id + '：' + target + '，到期 ' + item.dueAt + '（' + overdue + '，间隔 ' + item.intervalDays + ' 天，题目 ' + item.questionStatus + '）')
  }
  if (queue.nextDueAt !== null) lines.push('下一次到期：' + queue.nextDueAt + '。')
  lines.push('跳过用 teach_review（action:"finish"，result:"skipped"）：跳过不算掌握。')
  return lines.join('\n')
}

function formatGrading(result) {
  const lines = []
  if (result.graded === true) {
    lines.push('模型盲评已入库：评估 ' + result.assessmentId + '（' + result.method.model + '，温度 ' + result.method.temperature + '）。')
    lines.push('结论：' + result.verdict + '（由宿主按逐条标准与证据推导，模型不能自己写通过）。')
    for (const item of result.criteria) lines.push('- ' + (item.met ? '✓' : '×') + ' ' + item.id + '：' + item.evidence)
    if (result.reason) lines.push('说明：' + result.reason)
  } else {
    lines.push('这次没有形成模型结论：' + (result.reason ?? ''))
    lines.push('已记为 ' + result.verdict + '（待复核），原始答案没有丢；这不是通过。')
  }
  if (result.ignored.length > 0) lines.push('模型自报的结论字段已忽略：' + result.ignored.join('、') + '（结论只由宿主推导）。')
  if (result.failure) lines.push('失败代码：' + result.failure + '。')
  return lines.join('\n')
}

function formatPublish(result) {
  const assets = Array.isArray(result.assets) ? result.assets : []
  const dry = result.dryRun === true
  const lines = dry
    ? [
        `课程 ${result.lessonId} 演练通过：${assets.length} 个本地资源，档案里现在 revision ${result.lessonRevision}（没有写入档案）。`,
        `页面：${result.path}`,
        `指纹：${String(result.fingerprint).slice(0, 16)}…`
      ]
    : [
        `课程 ${result.lessonId} 已登记：revision ${result.lessonRevision}，${assets.length} 个本地资源。`,
        `页面：${result.path}`,
        `指纹：${String(result.fingerprint).slice(0, 16)}…`
      ]
  if (dry) {
    lines.push(
      result.idempotent
        ? '正式发布会是幂等的：内容与上次一致，不会新增修订。'
        : `正式发布会写成 revision ${result.nextRevision}（现在 ${result.lessonRevision}）。`
    )
  } else if (result.idempotent) {
    lines.push('内容和上次发布完全一致，没有新增修订。')
  }
  // 课堂挂点：页面声明的 data-question-id 要与档案里登记过的题目一致，课堂里才有点得动的提交按钮。
  // classroomHooks 是 publishLesson 挂的非枚举属性（工具输出 schema 不允许额外字段），只给文案用。
  const hooks = result.classroomHooks
  if (hooks !== null && typeof hooks === 'object') {
    const declared = Array.isArray(hooks.pageQuestionIds) ? hooks.pageQuestionIds : []
    const registered = Array.isArray(hooks.registeredPageIds) ? hooks.registeredPageIds : []
    const dangling = Array.isArray(hooks.danglingIds) ? hooks.danglingIds : []
    if (declared.length === 0) {
      lines.push('课堂挂点：页面没有 data-question-id，课堂模式里不会出现「提交到课堂」（题目先用 teach_question_register 登记，再把 questionId 写进页面）。')
    } else {
      lines.push(
        `课堂挂点：页面声明 ${declared.length} 题，其中 ${registered.length} 题已登记` +
          (dangling.length === 0
            ? '，没有悬空 id。'
            : `，悬空 ${dangling.length} 题：${dangling.join('、')}（先 teach_question_register 登记这些题；课堂与侧栏读的是登记后的档案，登记完立即生效，不要重新发布——重发会让已打开的课堂失效）。`)
      )
    }
  }
  const missingMaterials = hooks !== null && typeof hooks === 'object' && hooks.materials !== null && typeof hooks.materials === 'object' && Array.isArray(hooks.materials.missing)
    ? hooks.materials.missing
    : []
  if (missingMaterials.length > 0) {
    lines.push(`资料提醒：页面引用了 ${missingMaterials.length} 个 reference/materials/ 下的本地文件但还没索引（先 teach_material_index）：${missingMaterials.join('、')}`)
  }
  if (dry) lines.push('演练没有写档案：核对完 id 再调一次正式的 publish（省略 dryRun）即可，登记题目放在正式发布之后。')
  return lines.join('\n')
}

function formatCommit(result) {
  if (result.dryRun === true) {
    const lines = [`预检通过（演练，没有写档案）：课程 ${result.lessonId} 现在 revision ${result.lessonRevision}。`]
    if (result.idempotent) lines.push('这个幂等键 + 同一份内容已经提交过；正式执行会直接返回既有结果，不会重复写档案。')
    lines.push(`页面声明 ${result.questionIds?.length ?? 0} 个课堂挂点；确认没问题后去掉 dryRun 再提交一次。`)
    return lines.join('\n')
  }
  if (result.step === 'idempotent') {
    return `没有重复提交：同一个幂等键 + 同一份内容已经生效（课程 ${result.lessonId} revision ${result.lessonRevision}）。`
  }
  const lines = [`已提交：课程 ${result.lessonId} revision ${result.lessonRevision}。`]
  lines.push(`页面声明 ${result.questionIds?.length ?? 0} 个课堂挂点；题目按内容去重登记，没改动的题不升 revision。`)
  if (result.open) lines.push(`要打开课堂就调 teach_lesson_open（path: ${result.open.path}）；commit 不代开侧栏。`)
  return lines.join('\n')
}

/** spec 路线多一行：页面是从哪份 spec 编译来的、生成了几条题目。 */
function formatSpecNote(compiled, result) {
  const specId = compiled.spec.id
  const count = result.questionIds?.length ?? 0
  if (result.dryRun === true) {
    return `LessonSpec ${specId} 演练通过（没有写任何文件）：编译出的页面与 ${count} 道题会来自同一份 spec；确认后去掉 dryRun 再提交。`
  }
  return `LessonSpec ${specId} 已编译成页面并提交：页面与 ${count} 道题来自同一份 spec（改课只改 spec，重编译覆盖页面）。`
}

/** commit 的统一失败信封（Q-C4）：code + 在哪一步 + 能不能重试 + 下一步。 */
function commitFailure(error) {
  const plan = describeError(error)
  return {
    text: '没有提交：' + plan.cause,
    ok: false,
    error: plan.code,
    step: plan.step,
    cause: plan.cause,
    recoverable: plan.recoverable,
    nextAction: plan.nextAction
  }
}

function formatSubmission(result) {
  const lines = [`提交已入库：${result.submissionId}`]
  if (result.idempotent) lines.push('同一个幂等键已经记过这份答案，本次没有重复记分。')
  if (result.assessmentId !== null) {
    lines.push(`host 确定性判分：${result.verdict}（评估 ${result.assessmentId}）`)
    lines.push('这是按标准答案算出来的，不是模型自评。')
  } else {
    lines.push('原始答案已保存，还没有评估。')
  }
  if (result.reason) lines.push(result.reason)
  return lines.join('\n')
}

function formatAssessment(result) {
  return [
    `评估已记录：${result.assessmentId}`,
    `结论：${result.verdict}`,
    result.reason ? `说明：${result.reason}` : '通过只来自逐条标准与独立证据。',
    '如果学习者质疑，用 teach_review 之前先检查这条评估的题目版本与材料指纹。'
  ].join('\n')
}

export function registerArchiveTools(ctx, config, workspaceOf) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return false
  if (config?.tools?.archive === false) return false

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_lesson_publish',
        description:
          'Publish a lesson HTML page into the workspace archive. Resolves the page inside the workspace, hashes it, ' +
          'records every local resource it really references - script, stylesheet, image, video (and its poster), audio, ' +
          'source, track, link and embed object - as path + SHA-256 + size, notes which data-question-id hooks the page ' +
          'declares, and bumps the lesson revision only when the page content changed. Files inside dot-directories ' +
          '(.dsh-teach-me/archive and friends) are never published. Pass dryRun:true to check the page (resources, ' +
          'fingerprint, declared question ids, dangling ids) without writing the archive or bumping the revision. ' +
          'Use after lesson_lint passes; pass a stable lessonId that questions can cite. Dangling question ids are ' +
          'reported, not rejected: register the questions afterwards and the classroom picks them up immediately - ' +
          'do not republish, republishing invalidates an already open classroom.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'lessonId'],
          properties: {
            path: { type: 'string', description: '课程 HTML 路径（工作区相对或绝对，必须在工作区内）。' },
            lessonId: { type: 'string', description: '稳定的课程身份，例如 lesson-03-derivative。' },
            title: { type: 'string', description: '人读标题；省略时用 lessonId。' },
            objectives: {
              type: 'array',
              items: { type: 'string' },
              description: '这节课覆盖的目标 id（可选）。'
            },
            ...GOAL_PARAMETERS,
            dryRun: {
              type: 'boolean',
              description: '演练：只核对页面与课堂挂点，不写档案、不递增 lesson revision（默认 false）。'
            },
            expectedRevision: REVISION
          }
        },
        output: output({
          lessonId: { type: 'string' },
          lessonRevision: { type: 'integer' },
          title: { type: 'string' },
          path: { type: 'string' },
          idempotent: { type: 'boolean' },
          dryRun: { type: 'boolean', description: '这次是不是演练（没有写档案）。' }
        }),
        execute: withArchive(workspaceOf, (root, args) => {
          const result = publishLesson(root, args, { expectedRevision: args.expectedRevision })
          // D2（§4.4.2）：fingerprint 与逐资源 assets（64 位哈希+大小）是内部事实，
          // 文案还要用，但不进模型回执——模型下一步只需要 id/revision/路径/是否幂等。
          const { fingerprint, assets, ...receipt } = result
          return { ...receipt, text: formatPublish(result) }
        })
      }),
    'teach-me.tool(teach_lesson_publish)'
  )

  // 回滚开关：config.tools.commit = false 时不下发这个工具（档案兼容层保留）。
  if (config?.tools?.commit !== false) {
    ctx.effect(
      () =>
        tools.register({
          name: 'teach_commit',
          description:
            'Publish a lesson page AND register its quiz questions in ONE idempotent commit. Reuse the same idempotencyKey when ' +
            'retrying: same key + same content returns the existing result without writing; same key + different content is a ' +
            'conflict (pick a new key). Unchanged questions never bump their revision, so past passes stay valid. dryRun:true ' +
            'only checks (page, assets, question args, key) and writes nothing. Inside the write lock the commit re-checks the ' +
            'page, its assets and every question and rejects with content-changed / assets-changed / question-revision-changed ' +
            'instead of writing stale facts. path may point at a lesson HTML file OR at a LessonSpec .json: a spec is compiled ' +
            'into <name>.html next to it, its quiz questions are derived from the spec (passing questions as well is rejected), ' +
            'and nothing is written when the spec is invalid or the compiled page has lint errors. Returns the lesson revision, ' +
            'question ids and an open plan; it never opens the sidebar.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['lessonId', 'path', 'idempotencyKey'],
            properties: {
              lessonId: { type: 'string', description: '稳定的课程身份，题目引用它。' },
              path: { type: 'string', description: '课程页面路径：HTML（工作区相对或绝对，必须在工作区内），或 LessonSpec 的 .json（编译产物写到同目录同名 .html）。' },
              title: { type: 'string', description: '人读标题；省略时用 lessonId。' },
              objectives: { type: 'array', items: { type: 'string' }, description: '这节课覆盖的目标 id（可选）。' },
              ...GOAL_PARAMETERS,
              questions: {
                type: 'array',
                items: { type: 'object', additionalProperties: true },
                description:
                  '要登记/更新的题目（可选）。每项与 teach_question_register 的参数同形：questionId、lessonId、type、prompt、answer、options、rubric、materials、prerequisite、objectiveId。path 是 spec 时必须省略（题目由 spec 声明，只留一个来源）。'
              },
              idempotencyKey: { type: 'string', description: '这次提交的幂等键（必填；重试同一份提交必须复用同一个）。' },
              dryRun: { type: 'boolean', description: '只预检：不写档案、不建目录（默认 false）。' },
              expectedRevision: REVISION
            }
          },
          output: output(
            {
              step: { type: 'string', description: '走到哪一步：precheck（演练）/ commit（已写）/ idempotent（命中既有结果）；失败时是出错的阶段。' },
              lessonId: { type: 'string' },
              lessonRevision: { type: 'integer', description: '提交后课程的 revision；幂等命中时是既有值。' },
              questionIds: { type: 'array', items: { type: 'string' }, description: '页面声明的课堂挂点 id。' },
              idempotent: { type: 'boolean', description: '同一幂等键 + 同一份内容已经提交过：这次没有写档案。' },
              dryRun: { type: 'boolean', description: '这次是不是演练（没有写档案）。' },
              open: {
                type: 'object',
                additionalProperties: false,
                required: ['path', 'lessonId'],
                properties: {
                  path: { type: 'string' },
                  lessonId: { type: 'string' }
                }
              },
              spec: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'compiledPath'],
                properties: {
                  id: { type: 'string', description: 'LessonSpec 的 id（只在 spec 路线出现）。' },
                  compiledPath: { type: 'string', description: '编译产物路径（相对工作区）。' }
                }
              },
              cause: { type: 'string', description: '失败原因（人读）。' },
              recoverable: { type: 'boolean', description: '失败后能不能重试。' },
              nextAction: { type: 'string', description: '失败后的可执行下一步：rerun-precheck / fix-input / use-new-key / reload-archive / confirm-workspace。' }
            },
            ['lessonId']
          ),
          execute: async (args, exec) => {
            const resolved = workspaceOfOrFail(workspaceOf, exec)
            if (resolved.error !== undefined) return commitFailure(resolved.error)
            // E2：path 指向 .json 时走 LessonSpec 路线 —— 编译、lint、写页面、题目从 spec 派生，
            // 然后照旧进同一个事务。两道门都在事务之前：编译不过或页面有硬伤，一律不写档案。
            if (isSpecPath(args?.path)) {
              try {
                const goals = goalInputOf(args)
                if (goals !== undefined) {
                  const ids = args.objectives ?? readArchiveState(resolved.root)?.lessons[args.lessonId]?.objectives ?? []
                  assertGoalLinks(goals, ids)
                }
              } catch (error) {
                return commitFailure(error)
              }
              let compiled
              try {
                const specAbs = path.isAbsolute(args.path) ? args.path : path.resolve(resolved.root, args.path)
                if (Array.isArray(args.questions) && args.questions.length > 0) {
                  return commitFailure(
                    new CommitRejectedError(
                      'lesson-spec-questions-conflict',
                      'spec 已经声明了自测题，就不要再传 questions：题目只留一个来源，否则页面与档案会对不上。',
                      { path: args.path }
                    )
                  )
                }
                compiled = compileSpecAt(specAbs)
                const errors = specLintErrors(compiled.html, compiled.htmlPath)
                if (errors.length > 0) {
                  return commitFailure(
                    new CommitRejectedError(
                      'lesson-spec-lint-failed',
                      '编译出的页面有 ' + errors.length + ' 个硬伤，先修 spec：' + errors.slice(0, 3).map((issue) => issue.code).join('、'),
                      { codes: errors.map((issue) => issue.code) }
                    )
                  )
                }
                // dryRun 必须零写：演练的语义是"只核对，不动磁盘"，所以页面留在内存里，
                // 由 commitLesson 的预检按内存文本算指纹（正式提交前才落盘）。
                if (args.dryRun !== true) {
                  fs.mkdirSync(path.dirname(compiled.htmlPath), { recursive: true })
                  fs.writeFileSync(compiled.htmlPath, compiled.html)
                }
              } catch (error) {
                const described = describeSpecError(error)
                return {
                  text: '没有写入：' + described.message,
                  ok: false,
                  error: described.code,
                  cause: described.message,
                  recoverable: described.recoverable,
                  nextAction: described.nextAction
                }
              }
              try {
                const result = commitLesson(
                  resolved.root,
                  {
                    ...args,
                    path: compiled.htmlPath,
                    questions: questionsOfSpec(compiled.spec, args.lessonId)
                  },
                  {
                    expectedRevision: args?.expectedRevision,
                    // 演练时页面还没落盘：把内存文本交给预检，走同一条校验路径。
                    page: args.dryRun === true ? { text: compiled.html } : undefined
                  }
                )
                return {
                  ...result,
                  text: formatCommit(result) + '\n' + formatSpecNote(compiled, result),
                  spec: { id: compiled.spec.id, compiledPath: path.relative(resolved.root, compiled.htmlPath) }
                }
              } catch (error) {
                return commitFailure(error)
              }
            }
            try {
              const result = commitLesson(resolved.root, args, { expectedRevision: args?.expectedRevision })
              return { ...result, text: formatCommit(result) }
            } catch (error) {
              return commitFailure(error)
            }
          }
        }),
      'teach-me.tool(teach_commit)'
    )
  }

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_question_register',
        description:
          'Register or revise one question in the archive before anyone answers it. Questions carry a stable id, the lesson ' +
          'they belong to, the type (choice/numeric/short are graded deterministically and need an answer; explanation/design ' +
          'need a rubric), the stem, the prerequisite/scope, and the rubric the grader must judge against. A choice answer is a ' +
          'string or an array of strings: an array means multi-select and is graded as an unordered set. Re-registering ' +
          'an id bumps its revision, which makes older assessments stale on purpose.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['questionId', 'lessonId', 'type', 'prompt'],
          properties: {
            questionId: { type: 'string', description: '稳定题目 id，提交与复习都引用它。' },
            lessonId: { type: 'string', description: '所属课程（必须已发布）。' },
            type: {
              type: 'string',
              enum: ['choice', 'numeric', 'short', 'explanation', 'design'],
              description: '题型：choice/numeric/short 由宿主确定性判分，explanation/design 按标准评估。'
            },
            prompt: { type: 'string', description: '题干本身要自足：前提与口径写在里面。' },
            prerequisite: { type: 'string', description: '可选：前提/口径（口径句）。' },
            objectiveId: { type: 'string', description: '可选：对应的目标 id。' },
            options: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '选择题选项。' },
            answer: { description: 'choice/numeric/short 的标准答案；没有标准答案就只能记待复核。' },
            rubric: {
              type: 'array',
              description: '开放题的逐条标准（explanation/design 必填）：{id, text} 或字符串，id 用来对回模型批改。',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' }
                }
              }
            },
            materials: { type: 'array', items: { type: 'string' }, description: '题目引用的材料 id（先 teach_material_index）。' },
            status: { type: 'string', enum: ['active', 'retired'], description: 'retired 表示作废，旧评估不再算通过。' },
            expectedRevision: REVISION
          }
        },
        output: output({
          questionId: { type: 'string' },
          questionRevision: { type: 'integer' }
        }),
        execute: withArchive(workspaceOf, (root, args) => {
          const result = registerQuestion(root, args, { expectedRevision: args.expectedRevision })
          // D2：lessonId 是入参回显（重复上下文），文案里已经说了课程 id，不再占一个字段。
          const { lessonId, ...receipt } = result
          return {
            ...receipt,
            text: `题目 ${result.questionId} 已登记：v${result.questionRevision}（课程 ${result.lessonId}）。改动题目会让旧评估失效，这是故意的。`
          }
        })
      }),
    'teach-me.tool(teach_question_register)'
  )

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_submission_record',
        description:
          'Record a learner submission BEFORE judging it. The raw answer is stored with the question revision and source. ' +
          'choice/numeric/short questions are graded deterministically by the host; explanation/design questions stay pending ' +
          'until teach_evaluate records criteria and evidence. Reusing an idempotency key with identical content returns the ' +
          'existing submission; identical key with different content is a hard conflict. Never claim a verdict in the answer.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['questionId', 'rawAnswer'],
          properties: {
            questionId: { type: 'string', description: '题目 id（档案里登记过）。' },
            rawAnswer: { type: 'string', description: '学习者原始答案，原样保存；不要先改写或总结。' },
            source: {
              type: 'string',
              enum: ['classroom', 'chat', 'offline', 'import', 'other'],
              description: '答案来源，默认 other。'
            },
            hintsUsed: { type: 'boolean', description: '作答时是否用过提示。' },
            showedSolution: { type: 'boolean', description: '作答前是否看过解答。' },
            idempotencyKey: { type: 'string', description: '可选幂等键；省略时按题目+答案派生。' },
            expectedRevision: REVISION
          }
        },
        output: output({
          submissionId: { type: 'string' },
          assessmentId: { type: 'string' },
          verdict: { type: 'string' },
          status: { type: 'string' },
          reason: { type: 'string' },
          rawAnswer: { type: 'string' },
          idempotent: { type: 'boolean' },
          questionId: { type: 'string' },
          questionRevision: { type: 'integer' },
          // 幂等命中时也回结论：verdict/verdictViewOf 口径 + 这条结论现在是否已失效
          stale: { type: 'boolean' },
          staleReason: { type: 'string' }
        }),
        execute: withArchive(workspaceOf, (root, args) => {
          const result = recordSubmission(root, args, { expectedRevision: args.expectedRevision })
          return { ...result, text: formatSubmission(result) }
        })
      }),
    'teach-me.tool(teach_submission_record)'
  )

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_evaluate',
        description:
          'Record an assessment for a submission as per-criterion results plus independent evidence. You cannot pass a ' +
          'verdict: the host derives passed only when every criterion is met and each has evidence; otherwise it records ' +
          'needs_practice or needs_review. Submissions against an older question revision, a changed lesson revision, retired ' +
          'questions, or a changed materials fingerprint are forced to needs_review. Criteria ids must cover exactly the ' +
          'rubric registered with the question (missing or extra ids both mean needs_review), and a deterministic question ' +
          'whose standard answer disagrees with the criteria is forced to needs_review unless method.kind is "override" ' +
          'with a non-empty method.reason. Use after reading the learner answer, not instead of storing it.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['submissionId', 'criteria'],
          properties: {
            submissionId: { type: 'string', description: 'teach_submission_record 返回的提交 id。' },
            criteria: {
              type: 'array',
              description: '逐条标准；met 表示这一条是否满足，evidence 是独立证据（引用了哪句话/哪一步）。',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['met', 'evidence'],
                properties: {
                  id: { type: 'string' },
                  met: { type: 'boolean' },
                  evidence: { type: 'string' }
                }
              }
            },
            reason: { type: 'string', description: '给学习者看的简短说明。' },
            method: { type: 'object', additionalProperties: true, description: '评估方式，例如 {kind:"manual"} 或 {kind:"model",model:"…"}。' },
            materialsFingerprint: { type: 'string', description: '评估所依据的材料指纹；与当前档案不一致会转为待复核。' },
            expectedRevision: REVISION
          }
        },
        output: output({
          assessmentId: { type: 'string' },
          submissionId: { type: 'string' },
          verdict: { type: 'string' },
          reason: { type: 'string' }
        }),
        execute: withArchive(workspaceOf, (root, args) => {
          const result = evaluateSubmission(root, args, { expectedRevision: args.expectedRevision })
          return { ...result, text: formatAssessment(result) }
        })
      }),
    'teach-me.tool(teach_evaluate)'
  )

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_review',
        description:
          'Read, schedule, or finish spaced review. action:"due" lists the due queue read-only (id, question, due time, ' +
          'overdue days, question status) plus the next due time; it also works before anything is scheduled. Scheduling ' +
          'defaults to the 1/3/7/14-day ladder per question and never sends notifications. Finishing records completed or ' +
          'skipped; skipped is not mastery and does not count as passed.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: {
              type: 'string',
              enum: ['due', 'schedule', 'finish'],
              description: 'due 只读列到期队列；schedule 安排一次复习；finish 结束一次复习。'
            },
            reviewId: { type: 'string', description: 'finish 必填。' },
            result: { type: 'string', enum: ['completed', 'skipped'], description: 'finish 必填：完成或跳过。跳过不算掌握。' },
            questionId: { type: 'string', description: 'schedule 时关联题目。' },
            objectiveId: { type: 'string', description: 'schedule 时关联目标。' },
            intervalDays: { type: 'integer', description: 'schedule 时可覆盖间隔（1–3650 天）。' },
            dueAt: { type: 'string', description: 'schedule 时可指定到期时间（ISO）。' },
            expectedRevision: REVISION
          }
        },
        output: output({
          initialized: { type: 'boolean' },
          now: { type: 'string' },
          dueCount: { type: 'integer' },
          nextDueAt: { type: 'string' },
          reviewId: { type: 'string' },
          questionId: { type: 'string' },
          objectiveId: { type: 'string' },
          dueAt: { type: 'string' },
          intervalDays: { type: 'integer' },
          result: { type: 'string' },
          idempotent: { type: 'boolean' },
          dueReviews: { type: 'array', items: { type: 'object', additionalProperties: true } }
        }),
        execute: withArchive(workspaceOf, (root, args) => {
          if (args.action === 'due') {
            const queue = listDueReviews(root)
            // D2：工具面上只留 dueReviews（和 teach_status 档案段一致）；原先还会把同一个
            // 数组再以 due 返回一遍，属于纯重复上下文。dueCount/nextDueAt/now 保留。
            const { due, ...rest } = queue
            return { ...rest, dueReviews: due, text: formatDueQueue(queue) }
          }
          if (args.action === 'schedule') {
            const result = scheduleReview(root, args, { expectedRevision: args.expectedRevision })
            return {
              ...result,
              text: `已安排复习 ${result.reviewId}：${result.dueAt}（间隔 ${result.intervalDays} 天）。到期只提示，不会发通知。`
            }
          }
          if (args.action === 'finish') {
            const result = finishReview(root, args, { expectedRevision: args.expectedRevision })
            return {
              ...result,
              text: `复习 ${result.reviewId} 已记为 ${result.result}。` + (result.result === 'skipped' ? '跳过不算掌握。' : '')
            }
          }
          return { ok: false, text: 'action 只能是 due、schedule 或 finish。', error: 'bad-action' }
        })
      }),
    'teach-me.tool(teach_review)'
  )

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_self_report',
        description:
          'Record that the learner says they already know something (offline self-test, imported progress, spoken claim). ' +
          'This writes a self_report only: it never creates an assessment, never becomes passed, and never changes an ' +
          'existing verdict. Keep the claim verbatim; do not turn it into a judgement.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['claim'],
          properties: {
            claim: { type: 'string', description: '学习者原话或导入的自测结论，原样记录。' },
            questionId: { type: 'string', description: '可选：相关题目。' },
            objectiveId: { type: 'string', description: '可选：相关目标。' },
            id: { type: 'string', description: '可选幂等 id；同 id 同内容不重复记。' },
            expectedRevision: REVISION
          }
        },
        output: output({
          selfReportId: { type: 'string' },
          idempotent: { type: 'boolean' }
        }),
        execute: withArchive(workspaceOf, (root, args) => {
          const result = recordSelfReport(root, args, { expectedRevision: args.expectedRevision })
          return {
            ...result,
            text:
              `已记为自报 ${result.selfReportId}：这是学习者自己的说法，不是评估通过，也不改任何已有结论。` +
              (result.idempotent ? '（同 id 同内容，没有重复记）' : '')
          }
        })
      }),
    'teach-me.tool(teach_self_report)'
  )

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_defer',
        description:
          'Record an explicit deferral: the learner wants to skip this question/objective for now. Writes a deferral ' +
          'only: it never creates an assessment, never becomes passed, and does not finish a scheduled review. Optional ' +
          'until marks when to come back; nothing is scheduled or notified automatically.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            questionId: { type: 'string', description: '暂缓的题目；和 objectiveId 至少给一个。' },
            objectiveId: { type: 'string', description: '暂缓的目标；和 questionId 至少给一个。' },
            reason: { type: 'string', description: '为什么先跳过（学习者可见）。' },
            until: { type: 'string', description: '可选：打算什么时候再回来（ISO 时间）。' },
            id: { type: 'string', description: '可选幂等 id；同 id 同内容不重复记。' },
            expectedRevision: REVISION
          }
        },
        output: output({
          deferralId: { type: 'string' },
          questionId: { type: 'string' },
          objectiveId: { type: 'string' },
          reason: { type: 'string' },
          until: { type: 'string' },
          idempotent: { type: 'boolean' }
        }),
        execute: withArchive(workspaceOf, (root, args) => {
          const result = recordDeferral(root, args, { expectedRevision: args.expectedRevision })
          return {
            ...result,
            text:
              `已记为暂缓 ${result.deferralId}` +
              (result.until === null ? '：这次先跳过。' : `：打算 ${result.until} 再回来。`) +
              '暂缓不是通过，也不改已有结论。'
          }
        })
      }),
    'teach-me.tool(teach_defer)'
  )

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_grade_open',
        description:
          'Grade ONE stored open-question submission (explanation/design) with the session model. It reads the raw answer, ' +
          'question stem, rubric and materials from the archive - never from the caller - and asks for strict JSON of ' +
          'per-criterion met/evidence at temperature 0, blind (no history, no learner identity). The host still derives the ' +
          'verdict: a model cannot pass anything. Missing model service, no rubric, missing/changed materials, model errors, ' +
          'invalid JSON, empty evidence, or criteria that do not match the rubric all end as needs_review with the raw ' +
          'answer kept. There is no verdict parameter by design.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['submissionId'],
          properties: {
            submissionId: { type: 'string', description: 'teach_submission_record 返回的提交 id（原始答案已在档案里）。' },
            expectedRevision: REVISION
          }
        },
        output: output({
          submissionId: { type: 'string' },
          assessmentId: { type: 'string' },
          verdict: { type: 'string' },
          reason: { type: 'string' },
          graded: { type: 'boolean' },
          model: { type: 'string' },
          provider: { type: 'string' },
          method: { type: 'object', additionalProperties: true },
          materialsFingerprint: { type: 'string' },
          failure: { type: 'string' },
          criteria: { type: 'array', items: { type: 'object', additionalProperties: true } },
          ignored: { type: 'array', items: { type: 'string' } }
        }),
        async execute(args, exec) {
          const resolved = workspaceOfOrFail(workspaceOf, exec)
          if (resolved.error !== undefined) return failure(resolved.error)
          try {
            const result = await gradeOpenSubmission(resolved.root, args ?? {}, {
              llm: llmOf(ctx),
              route: resolveModelRoute(ctx, exec),
              expectedRevision: args?.expectedRevision
            })
            return pruneEmpty({ ...result, ok: result.ok, text: formatGrading(result) })
          } catch (error) {
            return failure(error)
          }
        }
      }),
    'teach-me.tool(teach_grade_open)'
  )

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_material_index',
        description:
          'Index a source used by a lesson: a workspace file (hashed) or a URL (unverified by default). Mark verified only ' +
          'when the source itself was checked; unverified sources cannot carry strong numeric claims or conclusions.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'title'],
          properties: {
            materialId: { type: 'string', description: '稳定资料 id；省略时自动生成。' },
            kind: { type: 'string', enum: ['file', 'url'], description: '文件型或链接型。' },
            title: { type: 'string', description: '资料标题。' },
            path: { type: 'string', description: 'kind=file 时的工作区路径。' },
            url: { type: 'string', description: 'kind=url 时的 http(s) 地址。' },
            location: { type: 'string', description: '页码/章节/时间戳等可定位信息。' },
            excerpt: { type: 'string', description: '要引用的摘录。' },
            version: { type: 'string', description: '版本或发布信息。' },
            status: { type: 'string', enum: ['unverified', 'verified'], description: '默认 unverified；确认过才写 verified。' },
            expectedRevision: REVISION
          }
        },
        output: output({
          materialId: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          sha256: { type: 'string' },
          path: { type: 'string' },
          url: { type: 'string' }
        }),
        execute: withArchive(workspaceOf, (root, args) => {
          const result = indexMaterial(root, args, { expectedRevision: args.expectedRevision })
          return {
            ...result,
            text: `资料 ${result.materialId} 已索引（${result.kind}，${result.status}）` + (result.sha256 ? `，sha256 ${result.sha256.slice(0, 16)}…` : '。')
          }
        })
      }),
    'teach-me.tool(teach_material_index)'
  )

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_assessment_void',
        description:
          'Void an assessment after a challenge or a corrected rubric. History is preserved; the voided verdict stops counting ' +
          'as passed. Use this instead of editing past records.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['assessmentId', 'reason'],
          properties: {
            assessmentId: { type: 'string' },
            reason: { type: 'string', description: '为什么作废；学习者可见。' },
            expectedRevision: REVISION
          }
        },
        output: output({ assessmentId: { type: 'string' }, voided: { type: 'boolean' } }, ['assessmentId']),
        execute: withArchive(workspaceOf, (root, args) => {
          const result = voidAssessment(root, args, { expectedRevision: args.expectedRevision })
          return { ...result, text: `评估 ${result.assessmentId} 已作废；原始提交与旧结论都保留。` }
        })
      }),
    'teach-me.tool(teach_assessment_void)'
  )

  return true
}

/** 给 teach_status 的档案段：未初始化时给出人读提示，不改磁盘。 */
export function archiveStatusFor(workspace, options) {
  const status = archiveStatus(workspace, options)
  if (!status.initialized) {
    return { ...status, text: '.dsh-teach-me/archive 里的档案还没建立；第一次发布课程或登记提交时会自动初始化。' }
  }
  const summary = status.summary
  const lines = [
    `档案：workspace ${summary.workspaceId}，revision ${summary.revision}`,
    `课程 ${summary.lessons} / 题目 ${summary.questions} / 提交 ${summary.submissions}（已评估 ${summary.assessed}）/ 通过 ${summary.passed}`,
    `待复核 ${summary.needsReview}，复习 ${summary.reviews}，资料 ${summary.materials}`,
    `自报 ${summary.selfReports ?? 0} / 暂缓 ${summary.deferrals ?? 0}：自报与暂缓都不是通过，只记学习者的动作。`
  ]
  if (status.dueReviews.length > 0) {
    lines.push(`到期复习 ${status.dueReviews.length} 条（可以挑几条做，其余跳过；不发通知）：`)
    for (const review of status.dueReviews) {
      const target = review.questionId === null ? '目标 ' + review.objectiveId : '题目 ' + review.questionId
      lines.push(`  - ${review.id}：${target}，到期 ${review.dueAt}（逾期 ${review.overdueDays} 天，题目 ${review.questionStatus}）`)
    }
  } else {
    lines.push('现在没有到期复习。')
  }
  if (status.nextDueAt !== null && status.nextDueAt !== undefined) lines.push(`下一次到期：${status.nextDueAt}。`)
  if (status.warnings.length > 0) lines.push(`索引提示：${status.warnings.join('；')}`)
  return { ...status, text: lines.join('\n') }
}
