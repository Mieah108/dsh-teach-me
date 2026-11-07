/* dsh-teach-me —— 包根入口，按 entryRole 分派两种身份。
 *
 * host    ：profile 全局设置行。提供设置服务与后续的课堂/档案后端，
 *           不注册任何教学工具，因此不需要教学会话也能被客户端发现。
 * runtime ：教学预设里的行。只有这一支会注入 tools 并注册教学能力。
 *
 * 旧配置没有 entryRole 时按 runtime 兼容（包根本来就是预设行）；
 * /settings 子路径入口按 host 兼容。未知值 fail closed。
 */

import { Config } from './config-schema.js'
import { applyHost } from './host.js'
import { applyRuntime } from './runtime.js'
import { pickEntryRole } from './shared/role.js'

/** Cordis 插件名（行 id 在 cordis.patch.yml 里另取）。 */
export const name = 'teach-me'

export { Config }

/**
 * @param {object} ctx 插件上下文（可能是 profile 宿主树，也可能是预设作用域）
 * @param {object} [config] 这一行的配置
 */
export function apply(ctx, config) {
  const role = pickEntryRole(config, 'runtime')
  if (role === 'host') {
    applyHost(ctx, config)
    return
  }
  // 运行期才等待 tools；宿主行不因缺少工具服务而挂起。
  ctx.inject(['tools'], (toolsCtx) => applyRuntime(toolsCtx, config))
}
