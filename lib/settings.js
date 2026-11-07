/* 旧 /settings 子路径入口：保留给已安装的全局设置行。
 *
 * 新安装的全局行改用包根 + entryRole:host；这一支继续可用，默认 host，
 * 不注册工具、不注入提示词。两条行同时存在时由先提供 teachSettings 的
 * 一方生效，不会重复 provide。
 */

import { Config } from './config-schema.js'
import { applyHost } from './host.js'
import { applyRuntime } from './runtime.js'
import { pickEntryRole } from './shared/role.js'

/** Cordis 插件名（行 id 在 cordis.patch.yml 里另取）。 */
export const name = 'teach-settings'

export { Config }

export function apply(ctx, config) {
  const role = pickEntryRole(config, 'host')
  if (role === 'runtime') {
    ctx.inject(['tools'], (toolsCtx) => applyRuntime(toolsCtx, config))
    return
  }
  applyHost(ctx, config)
}
