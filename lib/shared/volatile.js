/* 解包 schemastery 的 volatile 引用。
 *
 * 宿主的 Schema.resolve() 不会把 .volatile() 字段变成普通值，而是留成
 * { get(), [Symbol.for('cosmokit.volatile.write')] } 引用；设置页写值时
 * 改的是引用内部的快照。插件每次读配置都必须重新 get()，否则永远看到
 * 第一次 apply 时的值（S2 的根因）。
 *
 * 这里不依赖 @deepseek-ai/cosmokit：协议是 Symbol.for 的全局键，跨 ESM/CJS
 * 副本也一致，用同一个 Symbol 判断即可。
 */

export const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

export function isVolatile(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** 递归解包，普通对象/数组保持结构；遇到引用就取当前快照继续解包。 */
export function unwrapVolatile(value, seen = new WeakSet()) {
  if (isVolatile(value)) return unwrapVolatile(value.get(), seen)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) {
    const list = value.map((item) => unwrapVolatile(item, seen))
    seen.delete(value)
    return list
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    seen.delete(value)
    return value
  }
  const plain = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, unwrapVolatile(child, seen)])
  )
  seen.delete(value)
  return plain
}

/** 当前行的原始配置：volatile 更新可能替换 fiber.config，所以每次现读。 */
export function liveRowConfig(ctx, fallback) {
  const live = ctx?.fiber?.config
  if (live !== undefined && live !== null && typeof live === 'object' && !Array.isArray(live)) return live
  return fallback !== undefined && fallback !== null && typeof fallback === 'object' && !Array.isArray(fallback)
    ? fallback
    : {}
}

/** 读设置页服务；旧版设置行可能返回未解包对象，这里统一解包。 */
export function readSettingsService(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('teachSettings') : undefined
    const value = typeof service?.get === 'function' ? service.get() : undefined
    return value === undefined ? undefined : unwrapVolatile(value)
  } catch {
    return undefined
  }
}
