/* 技能前置闸门（M4）：写动画源码、同步、渲染之前，会话里必须先真的加载过
 * teach-animation。
 *
 * 为什么用闸门而不是再加一行阶段提示：
 * 阶段清单（prompt/stages/video-build.md）历史上被模型整段跳过，写源码时没有任何
 * 机制提醒「先看规范」。同一套 tools.guard 已经在候答闸门上验证过，能拦住 PTC
 * 子调用，也能给出可执行的一句话。
 *
 * 「加载过」的三种见证（任一即可，按会话记）：
 *  1. skill 工具成功返回 teach-animation；
 *  2. 直接读了 <包根>/skills/teach-animation/SKILL.md；
 *  3. 学习者用 /skill 直呼（会话里出现 source.kind === 'skill-invocation' 的消息）。
 *
 * 边界：技能没注册、被配置关掉、或宿主没有 tools.guard 时 fail-open —— 闸门不能
 * 变成死路；`teach_animation_sync` 的 dry_run 也放行（只读核对不该被前置知识卡住）。
 */

const SKILL_NAME = 'teach-animation'
const SKILL_SUFFIX = '/skills/' + SKILL_NAME + '/SKILL.md'

function sessionIdOf(execution) {
  const session = execution?.agent?.session
  if (session === undefined || session === null) return undefined
  return typeof session.id === 'string' && session.id.length > 0 ? session.id : undefined
}

/** 按会话记「加载过」；不跨会话、不跨子代理继承。 */
export function createSkillWitness() {
  const sessions = new Set()
  const key = (sessionId) => (sessionId === undefined || sessionId === null ? undefined : String(sessionId))
  return {
    mark(sessionId) {
      const id = key(sessionId)
      if (id !== undefined) sessions.add(id)
    },
    has(sessionId) {
      const id = key(sessionId)
      return id !== undefined && sessions.has(id)
    },
    forget(sessionId) {
      const id = key(sessionId)
      if (id !== undefined) sessions.delete(id)
    },
    size() {
      return sessions.size
    }
  }
}

/** 这条 read 是不是在读技能正文（绝对路径或相对路径都按后缀认）。 */
export function isSkillFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  const normalized = filePath.replaceAll('\\', '/')
  return normalized === SKILL_SUFFIX.slice(1) || normalized.endsWith(SKILL_SUFFIX)
}

/** 这条调用是不是闸门要管的动画写路径。 */
export function gatedCall(name, args) {
  if (name === 'write' || name === 'edit' || name === 'str_replace_editor') {
    const file = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : ''
    const normalized = file.replaceAll('\\', '/')
    return normalized.includes('/.dsh-teach-me/animation-src/') || normalized.startsWith('.dsh-teach-me/animation-src/')
  }
  if (name === 'teach_animation_sync') return args?.dry_run !== true
  if (name === 'teach_animation_render') return true
  return false
}

export const SKILL_GATE_MESSAGE =
  'STOP：写动画源码、同步或渲染之前，先在这个会话里加载 teach-animation 技能' +
  '（skill 工具传 name，或让学习者 /skill teach-animation；技能不可用时直接读 SKILL.md）。' +
  '这不是审批，是前置知识：没读它很容易写错 fps、尺寸、资产路径与安全区。加载后原样重试即可。'

/**
 * 挂证据监听：只观察，不改变任何工具结果。
 * @param {object} ctx 预设作用域上下文
 * @param {ReturnType<typeof createSkillWitness>} witness
 */
export function attachSkillWitness(ctx, witness) {
  try {
    ctx.on('tools/result', (execution, result) => {
      try {
        if (String(execution?.name ?? '') !== 'skill') return
        if (result?.isError === true) return
        if (String(execution?.arguments?.name ?? '') !== SKILL_NAME) return
        witness.mark(sessionIdOf(execution))
      } catch {
        // 证据只做加法，绝不打断结果处理
      }
    })
  } catch {
    // 事件不可用：还有另外两条见证
  }
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'user/message') return
        const source = event?.data?.source
        if (source?.kind !== 'skill-invocation' || String(source?.name ?? '') !== SKILL_NAME) return
        witness.mark(session?.id)
      } catch {
        // 同上
      }
    })
  } catch {
    // 同上
  }
}

/**
 * 注册闸门。available === false（技能没注册/被关）时直接不装，返回 false。
 * @param {object} ctx 预设作用域上下文
 * @param {() => object} getConfig 现取配置
 * @param {{witness: object, available: boolean}} deps
 * @returns {boolean} 是否装上
 */
export function registerSkillGate(ctx, getConfig, { witness, available } = {}) {
  if (available !== true || witness === undefined) return false
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (tools === undefined || tools === null || typeof tools.guard !== 'function') return false
  try {
    ctx.effect(
      () =>
        tools.guard((execution) => {
          let config
          try {
            config = getConfig()
          } catch {
            return undefined
          }
          if (config?.animation?.gateSkill !== true) return undefined
          const name = String(execution?.name ?? '')
          const args = execution?.arguments
          // 读技能正文本身就是见证：放行并记下。
          if (name === 'read' && isSkillFile(args?.file_path)) {
            witness.mark(sessionIdOf(execution))
            return undefined
          }
          if (!gatedCall(name, args)) return undefined
          if (witness.has(sessionIdOf(execution))) return undefined
          return SKILL_GATE_MESSAGE
        }),
      'teach-me.guard(skill)'
    )
    return true
  } catch {
    return false
  }
}

export { SKILL_NAME }
