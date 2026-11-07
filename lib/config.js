/* 配置：全部可选，缺省即默认。
   这里不导出 schemastery 的 Config —— 那件事交给 settings.js（设置页那一行）。
   本文件只做三件事：默认值、行配置合并、以及把「设置页的值」叠在「预设行的值」上面。 */

import { unwrapVolatile } from './shared/volatile.js'

const DEFAULTS = {
  teaching: { factCheck: 'moderate', depth: 'moderate' },
  // 追问由宿主官方 ask_user_question 负责（timed 投影 + pending 回执），
  // 这里只剩一个决定：等回答期间要不要拦住写操作。
  ask: {
    gateWhileWaiting: true
  },
  // 随包技能（teach、teach-animation）
  skills: {
    enabled: true,
    // 覆盖技能快照目录（默认 <包根>/skills）
    dir: '',
    // 包内强开模型可调用（上游 teach 头部写着 disable-model-invocation: true）
    modelInvocable: true,
    userInvocable: true
  },
  // 流程协议（prompt/*.md）
  prompt: {
    stageLayering: false,
    enabled: true,
    dir: ''
  },
  // 工具
  tools: {
    stage: true,
    lint: true,
    report: true,
    animation: true,
    // 学习档案工具（发布课程、登记提交、评估、复习、资料索引）
    archive: true,
    // 一次完成发布+登记（C 组）。置 false 即回滚：不再注册 teach_commit，档案里的 commit.recorded 仍可重放。
    commit: true
  },
  // 教学阶段机
  stages: {
    // 允许跳过阶段。true = 清单（只提醒，不拒绝）；false = 强制（set 只能进下一阶或留在当前阶，跨阶拒绝）
    allowSkip: true,
    start: 'intake'
  },
  // 产线账本
  ledger: {
    enabled: true,
    // 单页编辑次数超过它就在报告里点名
    editBudget: 8,
    // 整课步数参考线（步 = 根调用，不含 run_code 里的子调用）
    stepBudget: 120
  },
  // 教学动画：工程根由「设置页」或「预设行 config」给；空 = 关闭动画。
  // 路径永远不写死在包里 —— 别人下载这个包时，工程在哪只有他知道。
  animation: {
    root: '',
    // 软性上限：一节课的动画建议不超过这个秒数。判据是「讲完」，超了说明理由即可，不是门槛。
    softLimitSeconds: 120,
    // 工程没配或不存在时的行为：skip = 安静跳过；warn = 在阶段回执里提醒
    missing: 'skip',
    // 是否启用工作区里的中间目录（.dsh-teach-me）
    staging: true,
    // 写动画源码/同步/渲染前是否必须先在会话里加载 teach-animation 技能。
    // 技能不可用（未注册或被关）时自动放行 —— 闸门不制造死路。
    gateSkill: true,
    // Remotion 的 --timeout 是「单帧 delayRender 等待上限」，不是整段渲染预算。
    // 整段预算仍由 job 计时器管；这里只给单帧一个宽裕值。
    frameTimeoutMs: 30000
  },
  // 教学根：档案（.dsh-teach-me/archive）与课程相对路径都相对它解析。
  // 空 = 用会话工作区本身（旧行为）；也可以由 teach_workspace bind 在会话里临时绑定。
  workspace: {
    teachingRoot: ''
  }
}

function merge(base, patch) {
  if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base
  const out = { ...base }
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    const current = base[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && current !== null && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = merge(current, value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

/** 把行配置与默认值合并；坏配置不抛错，整份落回默认。 */
export function normalizeConfig(config) {
  if (config === undefined || config === null) return DEFAULTS
  if (typeof config !== 'object' || Array.isArray(config)) return DEFAULTS
  const merged = merge(DEFAULTS, config)
  // 允许 `ask: true` / `ask: false` 这种简写
  for (const key of ['skills', 'prompt', 'tools', 'stages', 'ledger', 'animation', 'workspace']) {
    if (typeof merged[key] === 'boolean') {
      merged[key] = merge(DEFAULTS[key], { enabled: merged[key] })
    }
  }
  return merged
}

/**
 * 合成最终配置：设置页的值 > 预设行的值 > 内置默认。
 * 设置页那一行的字段没有默认值：没填就是 undefined，merge 会跳过它，预设行的值保留；
 * 用户手动清空成空串则算显式关闭动画（空串会覆盖）。
 * @param {object} rowConfig 预设行 config
 * @param {object} [liveConfig] 设置页那一行的现值（可能为空）
 */
export function resolveConfig(rowConfig, liveConfig) {
  const row = normalizeConfig(unwrapVolatile(rowConfig))
  const plainLive = unwrapVolatile(liveConfig)
  const live = plainLive !== undefined && plainLive !== null && typeof plainLive === 'object' && !Array.isArray(plainLive) ? plainLive : undefined
  const merged = live === undefined ? row : merge(row, live)
  // 路径是字符串且非空才算「配了工程」；配了但目录不存在由 sandbox 再判一次。
  const rawRoot = typeof merged.animation?.root === 'string' ? merged.animation.root.trim() : ''
  merged.animation = { ...merged.animation, root: rawRoot, enabled: rawRoot.length > 0 }
  // 设置页可能只填了 softLimitSeconds 而没填 root —— 这种「半配置」不构成工程
  if (typeof merged.animation.softLimitSeconds !== 'number' || !Number.isFinite(merged.animation.softLimitSeconds)) {
    merged.animation.softLimitSeconds = DEFAULTS.animation.softLimitSeconds
  }
  // 单帧等待上限：只接受合理正数，坏值落回默认（防止有人填 0 让渲染必死）。
  if (
    typeof merged.animation.frameTimeoutMs !== 'number' ||
    !Number.isFinite(merged.animation.frameTimeoutMs) ||
    merged.animation.frameTimeoutMs < 1000
  ) {
    merged.animation.frameTimeoutMs = DEFAULTS.animation.frameTimeoutMs
  }
  if (typeof merged.animation.gateSkill !== 'boolean') merged.animation.gateSkill = DEFAULTS.animation.gateSkill
  return merged
}

export { DEFAULTS }
