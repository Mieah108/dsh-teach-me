/* 健康诊断：把「装没装上」分成三档，别再用一句「已就绪」盖过去。
 *  - 核心：缺了就没法教学（设置、工具、工作目录）
 *  - 可选：缺了只降级（候答投影、agents 回退、动画执行器）
 *  - 动画：未配置 / 结构不完整 / 已配置但执行器不可用 / 就绪
 * 诊断只读，不发通知、不写文件；设置页的值每次现取。
 */

import fs from 'node:fs'
import path from 'node:path'
import { readPermissionPreset } from './permission.js'

const hasFunction = (value, name) => value !== undefined && value !== null && typeof value[name] === 'function'

/** 收集宿主能力。缺服务只记录，不抛错。 */
export function collectHealth(ctx, getConfig) {
  const get = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  const core = []
  const optional = []

  const settings = get('teachSettings')
  core.push({
    id: 'settings',
    ok: hasFunction(settings, 'get'),
    detail: hasFunction(settings, 'get') ? `来源 ${settings.source ?? 'unknown'}` : '没有 teachSettings 服务：设置页与优先级都不可用'
  })

  const tools = get('tools')
  core.push({
    id: 'tools',
    ok: hasFunction(tools, 'register'),
    detail: hasFunction(tools, 'register') ? '可以注册教学工具' : '没有 tools 服务：教学工具不会出现'
  })

  const workingDirectory = get('workingDirectory')
  core.push({
    id: 'working-directory',
    ok: hasFunction(workingDirectory, 'get'),
    detail: hasFunction(workingDirectory, 'get') ? '可以为会话解析工作区' : '没有工作目录服务：写操作会明确失败'
  })

  const projections = get('sessionProjections')
  optional.push({
    id: 'user-questions',
    ok: hasFunction(projections, 'stateOf'),
    detail: hasFunction(projections, 'stateOf') ? '候答闸门可以读取宿主提问投影' : '读不到提问投影：候答期间不拦写操作，教学仍可继续'
  })

  const agents = get('agents')
  optional.push({
    id: 'agents',
    ok: hasFunction(agents, 'get'),
    detail: hasFunction(agents, 'get') ? '工作区可从 agents 取会话' : '拿不到 agents：只影响执行时没有 agent.session 的兼容路径'
  })

  const llm = get('llm')
  optional.push({
    id: 'llm',
    ok: hasFunction(llm, 'stream'),
    detail: hasFunction(llm, 'stream')
      ? '开放题可以做模型盲评（结论仍由宿主推导）'
      : '没有 llm 服务：开放题只能记待复核，不能模型批改，也不会伪造通过'
  })

  const subprocess = get('subprocess')
  const jobs = get('jobs')
  const executorReady = hasFunction(subprocess, 'spawn') && hasFunction(subprocess, 'resolveExecutable') && hasFunction(jobs, 'start')

  let config
  try {
    config = typeof getConfig === 'function' ? getConfig() : undefined
  } catch {
    config = undefined
  }
  const root = typeof config?.animation?.root === 'string' ? config.animation.root.trim() : ''
  let animation
  if (root === '') {
    animation = { state: 'unconfigured', detail: '设置 → 插件 → 教学模式 → 动画工程留空：这一课默认不做动画' }
  } else {
    const exists = fs.existsSync(root)
    const isDir = exists && fs.statSync(root).isDirectory()
    const hasPackage = isDir && fs.existsSync(path.join(root, 'package.json'))
    const hasModules = isDir && fs.existsSync(path.join(root, 'node_modules'))
    if (!isDir) animation = { state: 'broken', detail: `工程根不存在或不是目录：${root}` }
    else if (!hasPackage) animation = { state: 'broken', detail: `工程根没有 package.json：${root}` }
    else if (!hasModules) animation = { state: 'broken', detail: `工程根没有 node_modules：${root}` }
    else if (!executorReady) animation = { state: 'degraded', detail: '工程在，但宿主缺 subprocess/jobs：自动代渲染关闭，仍可只写源码' }
    else animation = { state: 'ready', detail: root }
  }

  return { core, optional, animation, healthy: core.every((item) => item.ok) }
}

/** 人读报告：先核心，再可选，最后动画。 */
export function formatHealth(health) {
  const mark = (item) => (item.ok ? '✓' : '×')
  const lines = ['核心能力：']
  for (const item of health.core) lines.push(`  ${mark(item)} ${item.id}：${item.detail}`)
  lines.push('可选能力：')
  for (const item of health.optional) lines.push(`  ${item.ok ? '✓' : '!'} ${item.id}：${item.detail}`)
  lines.push('动画：', `  ${health.animation.state}：${health.animation.detail}`)
  lines.push('', health.healthy ? '核心能力都在。' : '核心能力有缺口：先修上面标 × 的项，再开始教学。')
  return lines.join('\n')
}

/**
 * 「课堂挂点」段：页面声明了几题、几题真的能提交、哪些 id 悬空，
 * 以及档案里有但页面没挂的题目（课堂里点不到提交按钮）。
 * 输入是 archiveStatus().classroomHooks；缺字段一律按空处理，绝不抛错。
 */
export function formatClassroomHooks(hooks) {
  const summary = hooks !== null && typeof hooks === 'object' ? hooks : {}
  const declared = Number(summary.pageQuestions) || 0
  const registered = Number(summary.registered) || 0
  const danglingCount = Number(summary.dangling) || 0
  const danglingIds = Array.isArray(summary.danglingIds) ? summary.danglingIds : []
  const archiveOnlyIds = Array.isArray(summary.archiveOnlyIds) ? summary.archiveOnlyIds : []
  const lessons = Array.isArray(summary.lessons) ? summary.lessons : []
  const lines = []
  if (declared === 0 && archiveOnlyIds.length === 0) {
    lines.push('课堂挂点：页面还没声明 data-question-id，档案里也没有待挂的题目。')
  } else {
    const danglingText = danglingIds.length > 0 ? '（' + danglingIds.join('、') + '）' : ''
    lines.push(`课堂挂点：页面声明 ${declared} 题，其中 ${registered} 题已登记，悬空 ${danglingCount} 题${danglingText}。`)
    if (danglingIds.length > 0) lines.push('  悬空 id 在档案里没有对应题目：先 teach_question_register 再改页面，否则课堂提交挂不上。')
    if (archiveOnlyIds.length > 0) {
      lines.push(`档案有、页面没挂：${archiveOnlyIds.join('、')}（学习者在课堂里点不到提交按钮；补 data-question-id 或作废这些题）。`)
    }
  }
  // 只有真的存在挂点问题才逐课展开，正常课程不刷屏。
  for (const lesson of lessons) {
    const gap = Array.isArray(lesson?.danglingIds) ? lesson.danglingIds.length : 0
    const unmapped = Array.isArray(lesson?.archiveOnlyIds) ? lesson.archiveOnlyIds.length : 0
    if (gap === 0 && unmapped === 0) continue
    const pageCount = Array.isArray(lesson?.pageQuestionIds) ? lesson.pageQuestionIds.length : 0
    lines.push(`  - ${lesson.lessonId}（${lesson.path ?? ''}）：页面 ${pageCount} 题，悬空 ${gap}，档案有页面没挂 ${unmapped}`)
  }
  return lines.join('\n')
}

/** 权限提示：auto 下写入会被模型审查，审查通道出错时这次调用整段丢弃且不重试。 */
const AUTO_REVIEW_NOTE =
  '权限：auto（自动审查）——每次写入/执行都要先过一次模型审查；审查通道出错时这次调用会被整段丢弃且不自动重试' +
  '（不是你的参数错）。教学会话建议换回 ask 或 workspace-write。'

/**
 * 导师侧待批改入口：开放题提交后没有任何评估，档案里会一直挂着，
 * 不主动说一句就会漏。计数用 summarize 的 pendingGrading，id 从档案状态里取；
 * 没有待批改就一行都不加（不改既有行）。
 */
function pendingGradingNote(state, status) {
  const count = Number(status?.summary?.pendingGrading) || 0
  if (count === 0) return undefined
  let ids = []
  try {
    ids = Object.values(state?.submissions ?? {})
      .filter((item) => item?.status === 'pending')
      .map((item) => String(item.id))
  } catch {
    ids = []
  }
  const list = ids.length > 0 ? '：' + ids.join('、') : ''
  return `待批改 ${count} 条${list}（用 teach_grade_open 批改；开放题不会自动批改）`
}

/** 注册 teach_status：只读诊断，随时可调；有工作区时附带档案状态。 */
export function registerStatusTool(ctx, getConfig, { workspaceOf, stageOf } = {}) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (tools === undefined || tools === null) return false

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_status',
        description:
          'Read-only health check for this teaching session: which core host services are missing (settings, tools, ' +
          'working directory), which optional pieces are degraded (question projection, agents fallback), and whether ' +
          'the animation project is unconfigured, broken, degraded, or ready. Call it when setup looks wrong before ' +
          'asking the learner to check settings.',
        parameters: { type: 'object', additionalProperties: false, properties: { lessonId: { type: 'string', description: '限定课程；省略看工作区。' } } },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'healthy', 'animation'],
            properties: {
              text: { type: 'string', description: '人读诊断。' },
              healthy: { type: 'boolean', description: '核心能力是否都在。' },
              animation: { type: 'string', description: '动画工程状态：unconfigured / broken / degraded / ready。' },
              archive: { type: 'string', description: '学习档案状态：uninitialized / ready / unavailable。' },
              permission: { type: 'string', description: '当前会话的权限预设名（auto / ask / workspace-write 等）；读不到时不返回。' },
              stageSource: { type: 'string', description: '教学阶段来源：archive（档案投影）/ memory（进程内兜底）；读不到阶段时不返回。' },
              stagePersisted: { type: 'boolean', description: '教学阶段是否已写进档案；false = 只存在内存，重启会丢。' }
            }
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
        },
        async execute(args, exec) {
          const health = collectHealth(ctx, getConfig)
          const lines = [formatHealth(health)]
          // 权限预设：只读一行，不缓存。auto 下写入失败的原因常常不在这节课本身。
          const permission = readPermissionPreset(ctx, exec?.agent?.session)
          if (permission === 'auto') lines.push('', AUTO_REVIEW_NOTE)
          else if (permission !== undefined) lines.push('', `权限：${permission}。`)
          let archive = 'unavailable'
          let learningWorkspace
          let snapshot
          const now = Date.now()
          if (typeof workspaceOf === 'function') {
            try {
              const workspace = workspaceOf(exec?.agent)
              learningWorkspace = workspace
              const { archiveStatusFor } = await import('./archive/tools.js')
              const { tryOpenArchive } = await import('./archive/store.js')
              snapshot = tryOpenArchive(workspace, { repairIndex: false })
              const status = archiveStatusFor(workspace, { archive: snapshot, now })
              archive = status.initialized ? 'ready' : 'uninitialized'
              lines.push('', status.text)
              // 待批改：开放题不会自动批改，有就点名，没有不加行。
              const pending = pendingGradingNote(snapshot?.state, status)
              if (pending !== undefined) lines.push(pending)
              // 课堂挂点：档案状态里已经算好了页面声明/已登记/悬空，这里只负责排版。
              if (status.initialized) lines.push('', formatClassroomHooks(status.classroomHooks))
            } catch (error) {
              lines.push('', '档案：还解析不到这条会话的工作区（' + (error instanceof Error ? error.message : String(error)) + '）')
            }
          }
          // 阶段来源：档案优先、内存兜底都要说出来（回滚/重启后"为什么在这一阶"有据可查）。
          let stage
          if (typeof stageOf === 'function') {
            try {
              stage = stageOf(exec?.agent, snapshot === undefined ? undefined : { archive: snapshot })
            } catch {
              stage = undefined
            }
          }
          if (stage !== undefined && stage !== null) {
            const source =
              stage.source === 'archive'
                ? '来源：档案（run ' + stage.runId + ' v' + stage.runRevision + '）'
                : '来源：内存（' + (stage.reason ?? '还没有写进档案') + '）'
            lines.push('', '阶段：' + stage.stage + '（' + source + '）')
            if (Array.isArray(stage.pending) && stage.pending.length > 0) {
              lines.push('待确认 ' + stage.pending.length + ' 条（teach_stage 里列出；确认前别往下讲）。')
            }
          }

          if (learningWorkspace !== undefined && archive === 'ready') {
            try {
              const { projectLearningContext, formatLearningContext } = await import('./archive/context.js')
              const view = projectLearningContext(snapshot.state, snapshot.journalEntries, { lessonId: args?.lessonId, runId: stage?.runId ?? String(exec?.agent?.id), stage, now })
              if (view !== null) lines.push('', formatLearningContext(view))
              const { inspectAssetDrift } = await import('./archive/drift.js')
              const drift = inspectAssetDrift(learningWorkspace, { state: snapshot.state })
              if (drift.issues.length > 0) lines.push(`资产 drift ${drift.issues.length} 处（lesson_lint 查看）`)
            } catch (error) {
              lines.push('', '学习上下文不可用：' + error.message)
            }
          }

          return {
            text: lines.join('\n'),
            healthy: health.healthy,
            animation: health.animation.state,
            archive,
            ...(permission === undefined ? {} : { permission }),
            ...(stage === undefined || stage === null
              ? {}
              : { stageSource: stage.source ?? 'memory', stagePersisted: stage.persisted === true })
          }
        }
      }),
    'teach-me.tool(teach_status)'
  )
  return true
}
