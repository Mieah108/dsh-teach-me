/* 教学阶段机：一课从「进工作区」到「写学习记录」是一条固定的台阶。
   台阶本身是固定的（哪一步该有哪个产出），怎么走、走多慢是灵活的。
   工具返回当前阶段的清单，等于把「该做的事」钉在模型眼前，
   免得它跳过诊断直接开讲、或者没批准就先渲染视频。 */

import fs from 'node:fs'
import path from 'node:path'
import { readPermissionPreset } from './permission.js'
import { readIfExists } from './util.js'
import { planRunState, watermarksOf } from './archive/runs.js'
import { assertId, runStateOf } from './archive/state.js'
import { tryOpenArchive } from './archive/store.js'

/** 阶段表：id、中文名、这一阶的唯一产出。 */
export const STAGES = [
  { id: 'intake', label: '进工作区', output: '读完 MISSION / NOTES / learning-records / RESOURCES，说清这次要学什么' },
  { id: 'diagnose', label: '分层诊断', output: '用几问定出起点（ZPD），写成一句话' },
  { id: 'plan', label: '提计划', output: '一份小提案：讲哪几件事、什么顺序、要不要做动画；等学习者点头' },
  { id: 'build', label: '写课程页', output: '一个 lessons/NNNN-*.html，含目标、正文、符号表、自测' },
  { id: 'check', label: '自检', output: 'lesson_lint 无硬伤；自测题逐题过「自足性四问」' },
  { id: 'video-pitch', label: '动画提案', output: '讲哪几件事、什么画法、大概几幕；等学习者点头' },
  { id: 'video-build', label: '写动画源码', output: '源码写进工作区中间目录，teach_animation_sync 镜像进工程' },
  { id: 'video-render', label: '渲染', output: 'still 预检通过 → 成片召一次 teach_animation_render → 抽 2–3 帧核验' },
  { id: 'accept', label: '换情境验收', output: '一道新情境题，学习者答对才算学会' },
  { id: 'record', label: '写记录', output: 'learning-records/NNNN-*.md + NOTES/MISSION 需要的更新' }
]

const STAGE_IDS = STAGES.map((stage) => stage.id)
const STAGE_SET = new Set(STAGE_IDS)

/** 允许的下一步（不强制，只用于提示）。 */
function nextOf(id) {
  const index = STAGE_IDS.indexOf(id)
  if (index === -1) return undefined
  return STAGE_IDS[index + 1]
}

/** 读阶段清单文件并替换里面的变量；没有就返回空。 */
function checklistOf(root, id, config, stagingDir) {
  const file = path.join(root, 'prompt', 'stages', `${id}.md`)
  const text = readIfExists(file)
  if (text === undefined) return []
  // 阶段清单不是 systemPrompt 段，变量要自己替换（段那边由宿主插值）
  const filled = text
    .replaceAll('{{teach_animation_root}}', config.animation?.enabled === true ? config.animation.root : '（未配置）')
    .replaceAll('{{teach_animation_state}}', config.animation?.enabled === true ? 'ready' : 'off')
    .replaceAll('{{teach_animation_soft_limit}}', String(config.animation?.softLimitSeconds ?? 120))
    .replaceAll('{{teach_staging_dir}}', stagingDir)
  return filled
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => (line.startsWith('- ') ? line.slice(2) : line))
}

/** 工程是否就在会话工作区里（决定「要不要审批」这句话怎么说）。 */
function projectInsideWorkspace(root, workspace) {
  if (typeof root !== 'string' || root.length === 0) return false
  if (typeof workspace !== 'string' || workspace.length === 0) return false
  let realRoot
  let realWorkspace
  try {
    realRoot = fs.realpathSync.native(root)
    realWorkspace = fs.realpathSync.native(workspace)
  } catch {
    return false
  }
  return realRoot === realWorkspace || realRoot.startsWith(realWorkspace + path.sep)
}

/** 只读展示用：工作区解析不到就给占位，不因为目录服务缺失让 teach_stage 失败。 */
function workspaceForDisplay(workspaceOf, agent) {
  try {
    return workspaceOf(agent)
  } catch {
    return undefined
  }
}

/** 阶段回执里的权限一行：只在 auto 下说，别的时候不占版面。 */
function permissionNote(ctx, agent) {
  if (readPermissionPreset(ctx, agent?.session) !== 'auto') return undefined
  return '权限：auto（自动审查）——写入可能被审查通道整段丢弃且不重试；能换回 ask 或 workspace-write 就换。'
}

/** 两处 return 共用：把 describe 的正文与权限注拼起来。 */
function withPermission(ctx, agent, text) {
  const note = permissionNote(ctx, agent)
  return note === undefined ? text : text + '\n\n' + note
}

function describe(state, root, config, workspace) {
  const stage = STAGES.find((item) => item.id === state.stage) ?? STAGES[0]
  const next = nextOf(stage.id)
  const stagingDir =
    typeof workspace === 'string' && workspace.length > 0 ? path.join(workspace, '.dsh-teach-me') : '<workspace>/.dsh-teach-me'
  const lines = [
    `当前阶段：${stage.id}（${stage.label}）`,
    `这一步的产出：${stage.output}`,
    next === undefined ? '这是最后一步。' : `下一阶：${next}（${STAGES.find((item) => item.id === next)?.label ?? next}）`,
    // 阶段现在会落档案：一句来源说明让「重启后为什么还在这一阶」可解释。
    state.source === 'archive'
      ? `阶段来源：档案（run ${state.runId} v${state.runRevision}）`
      : '阶段来源：内存（还没有写进档案）'
  ]
  if (Array.isArray(state.pending) && state.pending.length > 0) {
    lines.push('', '待确认（确认前别往下讲）：')
    for (const item of state.pending) lines.push(`- ${item.label ?? item.kind}（${item.id}）`)
  }
  const visited = (state.visited ?? []).join(' → ')
  if (visited.length > 0) lines.push(`已走过：${visited}`)
  if (state.note !== undefined && state.note.length > 0) lines.push(`上次留的注：${state.note}`)
  const checklist = checklistOf(root, stage.id, config, stagingDir)
  if (checklist.length > 0) {
    lines.push('', '这一阶过一遍：')
    for (const item of checklist) lines.push(`- ${item}`)
  }

  // 动画工程的状态：没配就说清去哪配；配了就说清源码往哪写、谁来写工程。
  if (config.animation?.enabled !== true) {
    lines.push(
      '',
      '动画：未配置工程（设置 → 插件 → 教学模式 → 动画工程）。这一课默认不做动画；学习者要求时再把这一点告诉他，不要自己找路径。'
    )
  } else {
    lines.push(
      '',
      `动画工程：${config.animation.root}`,
      `这一步的源码写在 ${stagingDir}/animation-src/<slug>/，然后用 teach_animation_sync 镜像进工程、teach_animation_render 渲染。`,
      projectInsideWorkspace(config.animation.root, workspace)
        ? '工程就在会话工作区里：改写工程也不需要审批。'
        : '工程在会话工作区之外：但跨目录写入由插件代做，你不需要为它申请审批。'
    )
    // 闸门确实拦人时才值得占一行；技能不可用时闸门自动放行，不吓唬人。
    if (config.animation.gateSkill === true) {
      lines.push('技能前置：写源码/同步/渲染之前先在会话里加载 teach-animation（skill 工具或 /skill），否则会被闸门拦；这条只在这个会话没加载过时生效。')
    }
  }

  if (config.stages.allowSkip) {
    lines.push('', '（阶段可跳，但跳过的代价要自己承担；别把产出才算完成的台阶当装饰。）')
  } else {
    lines.push('', '（allowSkip=false：阶段不能跳。set 只能进下一阶或留在当前阶，跨阶请先把中间几阶的产出补齐、一阶一阶 advance。）')
  }
  return lines.join('\n')
}

/**
 * 注册 teach_stage 工具。
 * @param {object} ctx 预设作用域上下文
 * @param {() => object} getConfig 现取配置
 * @param {string} packageRoot 包根
 * @param {(agent: object) => string} workspaceOf 取会话工作区
 * @returns {{stageOf: Function, snapshot: Function}}
 */
export function registerStageTool(ctx, getConfig, packageRoot, workspaceOf) {
  // 写穿缓存：键是 runId（默认 = agentId）。档案是权威，内存只是本进程的快捷方式。
  const states = new Map()

  /** runId：默认 String(agentId)，工具参数可显式覆盖（Q-B3）。 */
  const runIdOf = (agent, args = {}) => {
    if (args.runId === undefined || args.runId === null || args.runId === '') {
      return assertId(String(agent?.id), 'runId（默认取 agent id）')
    }
    return assertId(args.runId, 'runId')
  }

  /** 打开会话工作区的档案；打不开就给可读原因（读路径降级、写路径 fail closed）。 */
  const openArchiveFor = (agent) => {
    if (typeof workspaceOf !== 'function') return { archive: null, reason: '没有工作目录服务' }
    let workspace
    try {
      workspace = workspaceOf(agent)
    } catch (error) {
      return { archive: null, reason: '解析不到工作区：' + (error instanceof Error ? error.message : String(error)) }
    }
    if (typeof workspace !== 'string' || workspace.length === 0) return { archive: null, reason: '解析不到工作区' }
    try {
      return { archive: tryOpenArchive(workspace, { repairIndex: false }) }
    } catch (error) {
      return { archive: null, reason: '档案打不开：' + (error instanceof Error ? error.message : String(error)) }
    }
  }

  /** 取（或建）这个 run 的状态：档案投影优先，内存兜底。 */
  const stateFor = (agent, args, snapshot) => {
    const runId = runIdOf(agent, args)
    const cached = states.get(runId)
    if (cached !== undefined && snapshot === undefined) return cached
    const { archive, reason } = snapshot ?? openArchiveFor(agent)
    const projection = archive === null ? null : runStateOf(archive.state, runId)
    if (projection === null && cached !== undefined) return cached
    if (projection !== null && cached?.runRevision === projection.revision) return cached
    let state
    if (projection !== null) {
      state = {
        runId,
        stage: projection.stage,
        note: '',
        visited: [],
        pending: Array.isArray(projection.pending) ? projection.pending : [],
        runRevision: projection.revision,
        source: 'archive',
        persisted: true,
        restored: true
      }
    } else {
      const stage = getConfig().stages.start
      state = {
        runId,
        stage,
        note: '',
        visited: [stage],
        pending: [],
        runRevision: 0,
        source: 'memory',
        persisted: false,
        restored: false,
        reason: archive === null ? reason ?? '还没有学习档案' : '档案里没有这个 run 的记录'
      }
    }
    states.set(runId, state)
    return state
  }

  /**
   * 把阶段写进档案（run 级 CAS，不重试、不覆盖）。
   * expectedRevision 只在 producer 内比较，全局 revision 推进不算冲突。
   */
  const persistRunState = (agent, state) => {
    const { archive, reason } = openArchiveFor(agent)
    if (archive === null) {
      state.source = 'memory'
      state.persisted = false
      return { persisted: false, source: 'memory', error: 'archive-not-initialized', nextAction: 'publish-first', reason }
    }
    const runId = state.runId
    const expected = state.runRevision
    const lessonIds = Object.keys(archive.state.lessons ?? {})
    try {
      const result = archive.transact('teach_stage', undefined, (draft) => {
        const current = runStateOf(draft, runId)
        const currentRevision = current?.revision ?? 0
        if (currentRevision !== expected) {
          // 不重试、不覆盖：交给调用方重新读取（nextAction: reload-stage）。
          return { changes: [], result: { conflict: true, currentRevision, currentStage: current?.stage ?? null } }
        }
        const planned = planRunState({
          state: draft,
          runId,
          stage: state.stage,
          pending: state.pending ?? [],
          watermarks: watermarksOf(archive, lessonIds)
        })
        return { changes: [planned.change], result: { runRevision: planned.runRevision } }
      })
      if (result.conflict === true) {
        // 记忆同步成档案里的真值：接下来的返回必须说真话，不能假装推进一步。
        const latest = runStateOf(archive.state, runId)
        if (latest !== null) {
          state.stage = latest.stage
          state.pending = Array.isArray(latest.pending) ? latest.pending : []
          state.runRevision = latest.revision
          state.source = 'archive'
          state.persisted = true
        } else {
          states.delete(runId)
        }
        return {
          persisted: false,
          source: state.source,
          error: 'run-revision-conflict',
          nextAction: 'reload-stage',
          reason: '档案里的 run ' + runId + ' 已是 v' + result.currentRevision + '，这次没有覆盖'
        }
      }
      state.runRevision = Number.isInteger(result.runRevision) ? result.runRevision : expected + 1
      state.source = 'archive'
      state.persisted = true
      return { persisted: true, source: 'archive' }
    } catch (error) {
      state.source = 'memory'
      state.persisted = false
      return {
        persisted: false,
        source: 'memory',
        error: error?.code ?? 'error',
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }

  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (getConfig().tools.stage && tools !== undefined && tools !== null) {
    ctx.effect(
      () =>
        tools.register({
          name: 'teach_stage',
          description:
            'Show or move the current teaching stage. Call it once at the start of every stage: it prints the ' +
            'checklist for that stage, the animation project status and where the animation source goes, so you do not ' +
            'skip diagnosis, start writing before approval, or render before the still check. Use action "advance" when ' +
            'the stage output exists; "show" re-reads after a long detour; "set" jumps (you own the cost; when ' +
            'stages.allowSkip is false, "set" only reaches the next stage or stays put).',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['action'],
            properties: {
              action: {
                type: 'string',
                enum: ['show', 'advance', 'set'],
                description: 'show 只读；advance 进入下一阶；set 直接指定（跳阶要自己承担；allowSkip=false 时只能进下一阶或留在当前阶）。'
              },
              stage: {
                type: 'string',
                enum: STAGE_IDS,
                description: 'set 时要进入的阶段。'
              },
              note: {
                type: 'string',
                description: '可选：给这一阶留一句注（例如「起点比她想的低一档」）。'
              },
              runId: {
                type: 'string',
                description: '可选：这一轮教学的 run 标识（默认取会话 agent id）。同一个 runId 的另一次会话会接着档案里的阶段继续。'
              }
            }
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['stage', 'text'],
              properties: {
                stage: { type: 'string', description: '当前阶段 id。' },
                text: { type: 'string', description: '当前阶段清单。' },
                persisted: { type: 'boolean', description: '这次动作是否写进学习档案；false = 只存在内存，重启会丢。' },
                source: { type: 'string', description: '阶段来源：archive（档案投影）或 memory（进程内兜底）。' },
                runRevision: { type: 'integer', description: '这个 run 在档案里的版本；没有记录时为 0。' },
                error: { type: 'string', description: '写档案失败的代码（如 run-revision-conflict）；成功时不返回。' },
                nextAction: { type: 'string', description: '失败后的可执行下一步（如 reload-stage）。' }
              }
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
          },
          async execute(args, exec) {
            const state = stateFor(exec?.agent, args)
            const action = String(args?.action ?? 'show')
            if (typeof args?.note === 'string' && args.note.length > 0) state.note = args.note

            let refusal
            let changed = false
            if (action === 'advance') {
              const next = nextOf(state.stage)
              if (next === undefined) {
                refusal = { text: '已经是最后一阶了。' }
              } else {
                state.stage = next
                state.visited.push(next)
                changed = true
              }
            } else if (action === 'set' && typeof args?.stage === 'string' && STAGE_SET.has(args.stage)) {
              // allowSkip=false 是强制：只能进下一阶或留在当前阶，跨阶拒绝（state.stage 不动）。
              const next = nextOf(state.stage)
              const allowed = args.stage === state.stage || args.stage === next
              if (getConfig().stages.allowSkip === false && !allowed) {
                const target = next === undefined ? '只能留在当前阶段（已经最后一阶）' : '只能 advance 或 set 到下一阶（' + next + '）'
                refusal = {
                  text: 'allowSkip=false：不能从 ' + state.stage + ' 跳到 ' + args.stage + '，' + target + '。',
                  nextAction: 'advance-stage'
                }
              } else if (args.stage !== state.stage) {
                state.stage = args.stage
                state.visited.push(args.stage)
                changed = true
              }
            }

            // 只写「真的动了」的阶：show 与「保留在当前阶」不产生 journal 行。
            const persistence = changed ? persistRunState(exec?.agent, state) : undefined

            const notes = []
            if (refusal !== undefined) notes.push(refusal.text)
            if (persistence !== undefined && persistence.persisted === false) {
              notes.push('阶段没有写进档案（' + persistence.reason + '）；这个进程重启后可能回到上一次记录。')
            }
            if (state.restored === true) {
              // 恢复提醒只占一次版面：同一个进程后续调用不再重复。
              if (getConfig().stages.allowSkip !== false) notes.push('（阶段从档案恢复：同一 runId 的另一次会话会接着这里继续。）')
              state.restored = false
            }
            const body = describe(state, packageRoot, getConfig(), workspaceForDisplay(workspaceOf, exec?.agent))
            const value = {
              stage: state.stage,
              text: withPermission(ctx, exec?.agent, notes.length === 0 ? body : body + '\n\n' + notes.join('\n')),
              persisted: persistence !== undefined ? persistence.persisted : state.persisted,
              source: persistence !== undefined ? persistence.source : state.source,
              runRevision: state.runRevision
            }
            if (refusal !== undefined && refusal.nextAction !== undefined) value.nextAction = refusal.nextAction
            if (persistence !== undefined && persistence.error !== undefined) value.error = persistence.error
            if (persistence !== undefined && persistence.nextAction !== undefined) value.nextAction = persistence.nextAction
            return value
          }
        }),
      'teach-me.tool(teach_stage)'
    )
  }

  return {
    /** 传会话对象 → 档案优先（跨会话/重启一致）；传 id 字符串 → 只读进程内缓存（旧调用兼容）。 */
    stageOf(agentOrId, snapshot) {
      if (agentOrId !== null && typeof agentOrId === 'object') return stateFor(agentOrId, {}, snapshot)
      const runId = String(agentOrId)
      const cached = states.get(runId)
      if (cached !== undefined) return cached
      const stage = getConfig().stages.start
      const state = {
        runId,
        stage,
        note: '',
        visited: [stage],
        pending: [],
        runRevision: 0,
        source: 'memory',
        persisted: false,
        restored: false,
        reason: '没有会话对象，读不到档案'
      }
      states.set(runId, state)
      return state
    },
    snapshot() {
      return [...states.entries()].map(([runId, state]) => ({ agentId: runId, runId, ...state }))
    }
  }
}
