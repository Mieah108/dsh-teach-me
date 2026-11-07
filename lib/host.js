import { createTeachingPreferences } from './teaching-preferences.js'
/* 宿主半边：profile 全局设置行。
 *
 * 不注入 tools，不注册提示词/技能/教学工具；只在宿主树里提供：
 *  - teachSettings：给设置页表单和教学运行期读的、已解包的最新配置；
 *  - 后续阶段：工作区状态、课堂资源/回传、诊断。
 */

import { registerClassroom } from './classroom/service.js'
import { liveRowConfig, unwrapVolatile } from './shared/volatile.js'

export const name = 'teach-me-host'

/**
 * @param {object} ctx profile 级上下文
 * @param {object} [config] 这一行的配置（全局行只应有 entryRole:host）
 */
export function applyHost(ctx, config) {
  const current = () => unwrapVolatile(liveRowConfig(ctx, config))

  const existingPreferences = typeof ctx.get === 'function' ? ctx.get('teachPreferences') : undefined
  const preferences = existingPreferences ?? createTeachingPreferences(() => {
    try { return ctx.get?.('storageDomain') ?? ctx.storage?.domain } catch { return undefined }
  }, current)
  if (!existingPreferences) ctx.provide('teachPreferences', preferences)
  if (!existingPreferences) ctx.effect?.(() => () => { return preferences.close().catch((error) => ctx.logger?.warn?.('teach-me: 偏好存储关闭失败：' + error.message)) }, 'teach-me: session preferences')

  // 迁移期可能同时存在旧 /settings 行；不重复 provide，谁先提供谁生效。
  const existing = typeof ctx.get === 'function' ? ctx.get('teachSettings') : undefined
  if (existing === undefined || existing === null) {
    ctx.provide('teachSettings', {
      get: current,
      /** 这份配置来自 profile 的宿主行，而不是包内默认。 */
      source: 'host'
    })
  }

  // 课堂后端依赖 webServer 与 connection，而 profile 行的 apply 早于这两个服务就绪：
  // 2026-10-26 真实 web 启动验证里，apply 那一刻两者都是 undefined，直接 get 会让
  // /teach-classroom 路由与 /teach RPC 永远挂不上（单元测试用假上下文，看不出这个次序问题）。
  // 所以这里等它们出现再注册；重复触发只注册一次。
  let started = false
  const startClassroom = (classroomCtx) => {
    if (started) return
    try {
      const classroom = registerClassroom(classroomCtx, { getConfig: current })
      if (classroom.enabled) {
        started = true
        // inject 的依赖重载会销毁本次上下文及路由；下次回调必须能重新挂载。
        classroomCtx.effect(() => () => { started = false }, 'teach-me: reset classroom lifecycle')
        classroomCtx.logger?.info?.('teach-me: 课堂后端已就绪（' + classroom.service.route + '）')
      }
      else classroomCtx.logger?.warn?.('teach-me: 课堂后端未启用：' + classroom.reason)
    } catch (error) {
      classroomCtx.logger?.warn?.('teach-me: 课堂后端注册失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer', 'connection'], startClassroom)
    } catch (error) {
      ctx.logger?.warn?.('teach-me: 课堂后端没能等到宿主服务：' + (error instanceof Error ? error.message : String(error)))
    }
  } else {
    // 没有 inject 的旧上下文：尽力而为，不因为缺服务就炸掉设置半边。
    startClassroom(ctx)
  }

  ctx.logger?.info?.('teach-me: 宿主半边已就绪（设置与诊断；教学工具只在教学预设内）')
}
