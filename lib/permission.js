/* 权限预设（只读）：教学会话是不是跑在 /permission auto 下。
 *
 * 为什么插件要读它：
 *  - auto 下每次写操作都要先过一次模型审查，审查通道出错（TLS/传输）时宿主 fail-closed，
 *    这次调用整段丢弃且不自动重试 —— 症状是「同样的写入，一次成功一次凭空失败」。
 *  - 课堂打开回执标识 auto 权限，由模型发起真实的原生调用，宿主据此审查。
 *
 * 只读、不缓存、读不到就返回 undefined：权限服务缺失时所有调用方都按旧行为走。
 */

export const AUTO_PRESET = 'auto'

/**
 * 读这条会话当前的权限预设名。
 * @param {object} ctx 预设作用域上下文
 * @param {object} session 会话（execution.agent.session）
 * @returns {string|undefined} 预设名；读不到时 undefined
 */
export function readPermissionPreset(ctx, session) {
  if (session === undefined || session === null) return undefined
  const get = (name) => {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }

  const presets = get('permissionPresets')
  if (presets !== undefined && presets !== null && typeof presets.current === 'function') {
    try {
      const name = presets.current(session)
      if (typeof name === 'string' && name.length > 0) return name
    } catch {
      // 落到投影那条路
    }
  }

  // 退回投影：permissions 投影的状态里保有这次会话选过的 preset（可能为 null）。
  const projections = get('sessionProjections')
  if (projections !== undefined && projections !== null && typeof projections.stateOf === 'function') {
    try {
      const state = projections.stateOf(session, 'permissions')
      const name = state?.preset
      if (typeof name === 'string' && name.length > 0) return name
    } catch {
      // 读不到就是读不到
    }
  }
  return undefined
}

/** 这条会话是不是跑在自动审查下。 */
export function isAutoReview(ctx, session) {
  return readPermissionPreset(ctx, session) === AUTO_PRESET
}
