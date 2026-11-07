import assert from 'node:assert/strict'
import test from 'node:test'

import { Config } from '../../lib/config-schema.js'
import { DEFAULTS, normalizeConfig, resolveConfig } from '../../lib/config.js'
import { isVolatile, unwrapVolatile } from '../../lib/shared/volatile.js'

/* 欢迎页的「只出现一次」靠一个配置字段撑着：welcome.seen。它必须同时满足两件事，
 * 否则浏览器里根本写不进去、也就谈不上「不再出现」：
 *   1) 在 schema 里是 volatile —— 宿主 dsh-settings 的 write() 只接受 volatile 路径，
 *      非 volatile 字段连投影都到不了浏览器（isVolatilePath / volatileForm）；
 *   2) 有默认值 false —— 设置行里没写过这个字段时，判定要能读到「还没看过」，而不是 undefined。
 * 这里把这两条和「运行期配置仍然照旧」钉成断言。 */

test('schema：welcome.seen 是固定路径上的 volatile 布尔，默认 false', () => {
  const seen = Config.dict.welcome.dict.seen
  assert.equal(seen.type, 'boolean')
  assert.equal(seen.meta.volatile, true, 'volatile 才能被设置服务写入（写回 true 不重启插件行）')
  assert.equal(seen.meta.default, false, '没写过时按「还没看过」处理')
})

test('schema 解析：缺省配置解出 false，写过 true 就解出 true', () => {
  assert.equal(unwrapVolatile(Config({})).welcome.seen, false)
  assert.equal(unwrapVolatile(Config({ welcome: { seen: true } })).welcome.seen, true)
  // 解出来的仍然是 volatile 引用：宿主靠这个协议把设置页的值与运行期配置接起来。
  assert.equal(isVolatile(Config({}).welcome.seen), true)
})

test('运行期配置：默认带 welcome.seen=false，设置行的 true 覆盖上来', () => {
  assert.equal(DEFAULTS.welcome.seen, false)
  assert.equal(normalizeConfig(undefined).welcome.seen, false)
  assert.equal(normalizeConfig({}).welcome.seen, false)
  assert.equal(normalizeConfig({ welcome: { seen: true } }).welcome.seen, true)
  // 设置页那一行（live）优先于预设行，和别的字段同一套合并规则。
  assert.equal(resolveConfig({ entryRole: 'runtime' }, { welcome: { seen: true } }).welcome.seen, true)
  assert.equal(resolveConfig({ entryRole: 'runtime' }, undefined).welcome.seen, false)
  // 空对象不会把预设行的 true 冲掉（merge 跳过 undefined，不是整组替换）。
  assert.equal(resolveConfig({ welcome: { seen: true } }, {}).welcome.seen, true)
})
