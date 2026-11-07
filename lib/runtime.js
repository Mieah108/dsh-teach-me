import { registerFactCheckTools } from './fact-check.js'
import { learningScope } from './archive/learning-scope.js'
import { registerTeachingRuntime } from './teaching-runtime.js'
/* 教学运行期：只装在「教学模式」预设作用域里。
 *
 * 把规则、技能、提问方式、阶段/自检/动画工具与账本装进这个会话：
 * 别的模式开会话时，这里的提示词段、技能、工具都不存在。
 *
 * 配置从两个地方来（ADR-0007）：
 *  - 本行 config：随包分发的默认值；
 *  - profile 全局宿主行的 teachSettings：用户自己的值，优先级更高。
 * 每次要用配置时现取，不缓存进闭包 —— 设置页改完值，这里立刻拿到新引用。
 */

import { fileURLToPath } from 'node:url'
import { resolveConfig } from './config.js'
import { registerPrompt } from './prompt.js'
import { registerSkills } from './skills.js'
import { registerWaitingGuard } from './ask-guard.js'
import { registerAnimationTools } from './animation.js'
import { registerStageTool } from './stages.js'
import { registerLintTool } from './lint.js'
import { registerArchiveTools } from './archive/tools.js'
import { registerLessonOpenTool } from './lesson-open.js'
import { registerWorkspaceTool } from './workspace-tool.js'
import { createLedger, registerReportTool } from './ledger.js'
import { collectHealth, registerStatusTool } from './health.js'
import { attachSkillWitness, createSkillWitness, registerSkillGate, SKILL_NAME } from './skill-gate.js'
import { liveRowConfig, readSettingsService, unwrapVolatile } from './shared/volatile.js'
import { resolveWorkspace } from './workspace.js'

/** 包根目录：<pkgRoot>/lib/runtime.js → <pkgRoot>。 */
function packageRoot() {
  return fileURLToPath(new URL('..', import.meta.url))
}

/**
 * 工作区解析：只认这条会话自己的目录，解析不到就抛 WorkspaceError。
 * 不再退回 defaultDirectory / process.cwd —— 静默写错地方比报错更坏（审计 R6）。
 */
function makeWorkspaceResolver(ctx, getConfig) {
  return (agent) => {
    if (learningScope().root) return learningScope().root
    const config = typeof getConfig === 'function' ? getConfig() : undefined
    return resolveWorkspace(ctx, agent, { teachingRoot: config?.workspace?.teachingRoot })
  }
}

/**
 * @param {object} ctx 预设作用域上下文（已注入 tools）
 * @param {object} [config] cordis.patch.yml 里这一行的 config（随包默认值）
 */
export function applyRuntime(ctx, config) {
  const root = packageRoot()

  const getConfig = () =>
    resolveConfig(unwrapVolatile(liveRowConfig(ctx, config)), readSettingsService(ctx))

  const baseline = getConfig()
  const workspaceOf = makeWorkspaceResolver(ctx, getConfig)
  ctx = registerTeachingRuntime(ctx, workspaceOf).scopedContext
  registerFactCheckTools(ctx, workspaceOf)
  const ledger = createLedger(getConfig)
  ledger.attach(ctx)

  const problems = []
  const failed = (label, error) => {
    problems.push(label)
    ctx.logger?.warn?.(`teach-me: ${label}没装上：${error instanceof Error ? error.message : String(error)}`)
  }

  // 阶段工具的持有者在这里声明：诊断工具先注册，但执行时读到的一定是已装好的实例。
  let stageTool

  try {
    if (!registerStatusTool(ctx, getConfig, { workspaceOf, stageOf: (agent, snapshot) => stageTool?.stageOf?.(agent, snapshot) })) {
      problems.push('诊断工具')
    }
  } catch (error) {
    failed('诊断工具', error)
  }

  let promptInfo = { sections: [], variables: [], dir: '' }
  if (baseline.prompt.enabled) {
    try {
      promptInfo = registerPrompt(ctx, getConfig, root, { stageOf: (agent) => stageTool?.stageOf?.(agent) })
    } catch (error) {
      failed('提示词段', error)
    }
  }

  let skillInfo = { registered: [], skipped: [] }
  if (baseline.skills.enabled) {
    try {
      skillInfo = registerSkills(ctx, baseline, root)
    } catch (error) {
      failed('随包技能', error)
    }
  }

  // 技能前置闸门：写动画源码/同步/渲染前必须先加载 teach-animation。
  // 技能没注册成功时 fail-open（返回 false，不装闸门），绝不制造死路。
  const skillWitness = createSkillWitness()
  attachSkillWitness(ctx, skillWitness)
  const skillGateAvailable = (Array.isArray(skillInfo.registered) ? skillInfo.registered : []).some(
    (item) => item?.name === SKILL_NAME
  )

  // 提问交给宿主官方 ask_user_question；这里只装候答闸门。
  if (!registerWaitingGuard(ctx, getConfig)) {
    problems.push('候答闸门')
    ctx.logger?.warn?.('teach-me: 候答闸门没装上（tools.guard 不可用），等回答期间不会拦截写操作')
  }

  try {
    stageTool = registerStageTool(ctx, getConfig, root, workspaceOf)
  } catch (error) {
    failed('阶段工具', error)
  }

  try {
    registerLintTool(ctx, baseline, workspaceOf)
  } catch (error) {
    failed('自检工具', error)
  }

  try {
    if (!registerArchiveTools(ctx, baseline, workspaceOf)) problems.push('学习档案工具')
  } catch (error) {
    failed('学习档案工具', error)
  }

  // 发布成功后把课打开：只有宿主真的能驱动侧栏（装了第三方侧栏插件并注册 sidebar_open）才会弹。
  try {
    if (!registerLessonOpenTool(ctx, baseline, workspaceOf)) problems.push('课堂打开工具')
  } catch (error) {
    failed('课堂打开工具', error)
  }

  // 教学根：学习者指定「把这里当工作区」时，档案跟着课程走，而不是散在会话根。
  try {
    if (!registerWorkspaceTool(ctx, baseline, workspaceOf, getConfig)) problems.push('教学根工具')
  } catch (error) {
    failed('教学根工具', error)
  }

  try {
    // D1：动画未配置时不注册这 4 个工具（约 9.1 KB 常驻 schema）。配了工程就与以前完全一致；
    // 注册发生在 apply 时，改设置后需要重启这一行才生效（与提示词段同一语义）。
    if (getConfig().animation?.enabled === true) registerAnimationTools(ctx, getConfig, workspaceOf)
  } catch (error) {
    failed('动画工具', error)
  }

  try {
    if (!registerSkillGate(ctx, getConfig, { witness: skillWitness, available: skillGateAvailable })) {
      if (!skillGateAvailable) {
        ctx.logger?.warn?.('teach-me: teach-animation 技能没注册上，动画技能闸门已放行（fail-open）')
      } else {
        problems.push('技能闸门')
      }
    }
  } catch (error) {
    failed('技能闸门', error)
  }

  try {
    registerReportTool(ctx, getConfig, ledger, stageTool, workspaceOf)
  } catch (error) {
    failed('账本工具', error)
  }

  // 别再无条件报「已就绪」：核心服务缺失或工具没装上都要说出来（审计 R7）。
  let health
  try {
    health = collectHealth(ctx, getConfig)
  } catch {
    health = undefined
  }
  const coreMissing = health?.core.filter((item) => !item.ok).map((item) => item.id) ?? []
  if (problems.length > 0 || coreMissing.length > 0) {
    ctx.logger?.warn?.(
      `teach-me: 部分能力不可用（${[...problems, ...coreMissing].join('、')}）；运行 teach_status 看逐项诊断，核心缺口修好前不要开始教学`
    )
  } else {
    const animation = health?.animation?.state ?? 'unconfigured'
    ctx.logger?.info?.(
      `teach-me: 已就绪（${promptInfo.sections.length} 段提示词、${skillInfo.registered.length} 个随包技能、动画 ${animation}）`
    )
  }
}
