/* 流程协议：prompt/*.md 按文件名排序，一条一段注入系统提示。
   规则住在包里，跟着插件走；persona 只留立场与一句话摘要（ADR-0002）。
   段内的 {{teach_*}} 由 variable() 解析成绝对路径，模型不用去猜模板在哪。

   动画工程路径不是常量：它来自设置页（或预设行 config），而且可能是空的。
   所以每个变量都在「取用那一刻」读配置，模块加载时不留任何路径。 */

import fs from 'node:fs'
import path from 'node:path'
import { readIfExists } from './util.js'
import { tryResolveWorkspace } from './workspace.js'

/** 列出 prompt/ 下的 .md，按文件名排序（10-、20- 的顺序就是段的顺序）。 */
function listPromptFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 注册提示词段与变量。
 * @param {object} ctx 预设作用域上下文
 * @param {() => object} getConfig 现取配置（设置页的值已叠加）
 * @param {string} packageRoot 包根
 * @returns {{sections: string[], variables: string[], dir: string}}
 */
export function registerPrompt(ctx, getConfig, packageRoot, { stageOf } = {}) {
  const promptService = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : ctx.systemPrompt
  if (promptService === undefined || promptService === null) return { sections: [], variables: [], dir: '' }

  const config = getConfig()
  const dir = config.prompt.dir.length > 0 ? path.resolve(config.prompt.dir) : path.join(packageRoot, 'prompt')
  const files = listPromptFiles(dir)
  const sections = []
  // 自定义目录可能没有分层标记；保留作者的完整协议。
  const layered = config.prompt.stageLayering === true && config.prompt.dir.length === 0
  const tails = []
  const family = (assembly) => {
    const agent = assembly?.agent ?? assembly?.scope
    if (agent === null || typeof agent !== 'object' || agent.id === undefined) return null
    try { return stageFamilyOf(stageOf?.(agent)?.stage) } catch { return null }
  }

  for (const [index, name] of files.entries()) {
    // D1：动画未配置时，动画篇（60-animation.md）整篇不注入常驻——它的每条规则都依赖
    // 一个不存在的工程，留着只会让模型反复确认「要不要做动画」。
    // 必须在循环内 continue：order 以原始索引为准（100 + index*10），先过滤数组会让
    // 后面的段整体前移、提示词前缀随配置漂移，缓存命中反而下降（Q-D3）。
    if (name === '60-animation.md' && config.animation?.enabled !== true) continue
    const file = path.join(dir, name)
    const source = readIfExists(file)
    if (source === undefined || source.trim().length === 0) continue
    const blocks = []
    const common = source.replace(/<!-- teach:(diagnose|production|review) -->\n?([\s\S]*?)<!-- teach:end -->\n?/g, (_all, stageFamily, text) => {
      blocks.push({ family: stageFamily, text: text.trim() })
      return ''
    }).trim()
    const text = layered ? common : source.replace(/<!-- teach:(?:diagnose|production|review|end) -->\n?/g, '').trim()
    if (layered && blocks.length > 0) tails.push({ name, blocks })
    const sectionName = `teach:${name.replace(/\.md$/, '')}`
    try {
      ctx.effect(
        () =>
          promptService.section({
            name: sectionName,
            order: 100 + index * 10,
            text: text.trim(),
            // 段内允许 {{teach_templates}} 这类变量；不写就是普通文本
            interpolate: text.includes('{{')
          }),
        `teach-me.prompt(${sectionName})`
      )
      sections.push(sectionName)
    } catch (error) {
      // 同名段被别处占用时不要炸掉整个插件，留一条诊断即可
      ctx.logger?.warn?.(`teach-me: 提示词段 ${sectionName} 注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  for (const [index, tail] of tails.entries()) {
    const name = `teach:phase-${tail.name.replace(/\.md$/, '')}`
    ctx.effect(() => promptService.section({
      name, order: 300 + index * 10,
      text: (assembly) => {
        const selected = family(assembly)
        return tail.blocks.filter((block) => selected === null || block.family === selected).map((block) => block.text).join('\n\n')
      },
      interpolate: true
    }), `teach-me.prompt(${name})`)
    sections.push(name)
  }

  /** 某个 agent 的工作区；拿不到返回 undefined（只用于提示词占位，不用于写盘）。 */
  const workspaceOf = (agent) => {
    const config = typeof getConfig === 'function' ? getConfig() : undefined
    return tryResolveWorkspace(ctx, agent, { teachingRoot: config?.workspace?.teachingRoot })
  }

  /** 包内路径变量：只依赖包根。 */
  const packageVariables = {
    teach_package: () => packageRoot,
    teach_templates: () => path.join(packageRoot, 'templates'),
    teach_skills: () => path.join(packageRoot, 'skills'),
    teach_prompts: () => path.join(packageRoot, 'prompt')
  }

  /** 运行期变量：每次插值都现取配置。 */
  const liveVariables = {
    // 动画工程根；没有配置时给空串
    teach_animation_root: () => {
      const live = getConfig()
      return live.animation?.enabled === true ? live.animation.root : ''
    },
    // off | ready —— 让提示词能「没配置就跳过动画」
    teach_animation_state: () => (getConfig().animation?.enabled === true ? 'ready' : 'off'),
    // 软性时长上限（秒）；判据仍是「讲完」
    teach_animation_soft_limit: () => String(getConfig().animation?.softLimitSeconds ?? 120),
    // 工作区里的中间目录；工作区未知时给占位说明
    teach_staging_dir: (assembleCtx) => {
      const agent = assembleCtx?.agent ?? assembleCtx?.scope
      const workspace = workspaceOf(agent)
      return workspace === undefined ? '<workspace>/.dsh-teach-me' : path.join(workspace, '.dsh-teach-me')
    }
  }

  const variables = []
  const register = (name, provider) => {
    try {
      ctx.effect(
        () => promptService.variable(name, (assembleCtx) => String(provider(assembleCtx) ?? '')),
        `teach-me.variable(${name})`
      )
      variables.push(name)
    } catch {
      // 变量服务不可用不影响主流程
    }
  }
  for (const [name, provider] of Object.entries(packageVariables)) register(name, provider)
  for (const [name, provider] of Object.entries(liveVariables)) register(name, provider)

  return { sections, variables, dir }
}

/** 阶段未知时返回null，让动态尾部完整保留。 */
export function stageFamilyOf(stage) {
  if (['intake', 'diagnose', 'plan'].includes(stage)) return 'diagnose'
  if (['build', 'check', 'video-pitch', 'video-build', 'video-render'].includes(stage)) return 'production'
  if (['accept', 'record'].includes(stage)) return 'review'
  return null
}
