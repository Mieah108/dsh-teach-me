/* 候答闸门：提问之后、回答之前，别继续动文件（ADR-0003 / R1）。
 *
 * 提问本身交给宿主官方 ask_user_question：它会登记 timed 问题、超时返回 pending，
 * 并把「还能答的问题」放进 userQuestions 投影。本模块只做一件事 —— 每次工具执行前
 * 现读那份投影与 live 配置：只要这个会话还有 active 问题，就拒绝依赖回答的写操作。
 *
 * 三条边界（对应审计 R1）：
 *  1. 不缓存「问过了」的状态：投影里 active 清空后自动放行，不需要事件订阅；
 *  2. 读 live 配置：设置页打开/关闭 gateWhileWaiting 立即生效；
 *  3. 超时不是批准：宿主把超时记成 pending，投影仍 active，闸门继续拦。
 */

/** 依赖回答的写操作：等到回答再做，避免「问题还没答，课已经写完」。 */
const GATED_TOOLS = new Set([
  'write',
  'edit',
  'apply_patch',
  'bash',
  // run_code 不在这张表里：它是「传输层」，读写全靠里面的子调用。
  // 整条拦住会把读/查/诊断也一并冻死（0.6.0 的实际症状）；
  // 只拦带 sandbox_permissions 的提权调用（见 escalating()）。
  'str_replace_editor',
  'terminal',
  'pwsh',
  'teach_animation_sync',
  'teach_animation_render',
  'teach_animation_register',
  'teach_commit',
  'teach_lesson_publish',
  'teach_lesson_open',
  'sidebar_open',
  'teach_submission_record',
  'teach_question_register',
  'teach_evaluate',
  'teach_review',
  'teach_self_report',
  'teach_defer',
  'teach_grade_open',
  'teach_material_index',
  'teach_assessment_void',
  'teach_workspace'
])

/** run_code 里只有「提权」这一类才依赖回答；普通读写由内层子调用各自判定。 */
function escalating(execution) {
  const args = execution?.arguments
  if (args === undefined || args === null || typeof args !== 'object') return false
  const escalate = args.sandbox_permissions
  if (escalate === undefined || escalate === null) return false
  return typeof escalate === 'string' ? escalate.length > 0 : escalate !== false
}

/** 这条调用在候答期间是否要拦。 */
function gatedByWaiting(name, execution) {
  if (GATED_TOOLS.has(name)) return true
  return name === 'run_code' && escalating(execution)
}

function activeQuestions(ctx, execution) {
  const session = execution?.agent?.session
  if (session === undefined || session === null) return undefined
  let projections
  try {
    projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
  } catch {
    return undefined
  }
  if (projections === undefined || projections === null || typeof projections.stateOf !== 'function') return undefined
  let state
  try {
    state = projections.stateOf(session, 'userQuestions')
  } catch {
    return undefined
  }
  const active = state?.questions?.active
  return Array.isArray(active) ? active : undefined
}

function denialMessage(active, name) {
  const ids = active
    .map((question) => (typeof question?.callId === 'string' ? question.callId : ''))
    .filter((id) => id.length > 0)
  const which = ids.length > 0 ? `（callId ${ids.join('、')}）` : ''
  const escalateNote =
    name === 'run_code'
      ? '这一条是带了 sandbox_permissions 的提权调用，所以拦；普通 run_code 里的读、查、诊断不受影响。'
      : ''
  return (
    `STOP：还有 ${active.length} 个没答的问题${which}。先让学习者回答；这期间只做读、查、` +
    '诊断这类不依赖答案的事，别写文件、跑命令、渲染或发布。超时只说明还没答，不是批准。' +
    escalateNote
  )
}

/**
 * 注册候答闸门。始终注册（是否拦截由 live 配置决定），配置热改无需重装。
 * @param {object} ctx 预设作用域上下文
 * @param {() => object} getConfig 现取配置
 * @returns {boolean} 是否装上
 */
export function registerWaitingGuard(ctx, getConfig) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (tools === undefined || tools === null || typeof tools.guard !== 'function') return false
  try {
    ctx.effect(
      () =>
        tools.guard((execution) => {
          const name = String(execution?.name ?? '')
          if (!gatedByWaiting(name, execution)) return undefined
          if (name === 'teach_commit' && execution?.arguments?.dryRun === true) return undefined
          const action = execution?.arguments?.action
          if (name === 'teach_workspace' && (action === 'status' || action === undefined)) return undefined
          if (name === 'teach_review' && (action === 'due' || action === undefined)) return undefined
          const config = getConfig()
          if (config?.ask?.gateWhileWaiting !== true) return undefined
          const active = activeQuestions(ctx, execution)
          if (active === undefined || active.length === 0) return undefined
          return denialMessage(active, name)
        }),
      'teach-me.guard(waiting)'
    )
    return true
  } catch {
    return false
  }
}

export { GATED_TOOLS, gatedByWaiting }
