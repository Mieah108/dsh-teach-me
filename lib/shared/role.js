/* 入口角色。
 *
 * 同一个包根入口同时承担两种身份：
 *  - host：profile 全局设置行。只提供设置/诊断/课堂后端，不注册教学工具；
 *  - runtime：教学预设里的行。注册提示词、技能、工具。
 *
 * 新配置必须显式写 entryRole；旧配置没有该字段时按模块默认值兼容
 * （包根 = runtime，/settings = host）。未知值 fail closed，不猜。
 */

export const ENTRY_ROLES = ['host', 'runtime']

export function pickEntryRole(config, fallback) {
  const declared = config?.entryRole
  if (declared === undefined || declared === null || declared === '') return fallback
  if (declared === 'host' || declared === 'runtime') return declared
  throw new Error(
    'teach-me: 未知 entryRole ' + JSON.stringify(declared) + '，只支持 host / runtime'
  )
}
