import assert from 'node:assert/strict'
import test from 'node:test'

import * as entry from '../../lib/index.js'
import * as settingsEntry from '../../lib/settings.js'

function fakeContext({ config = {}, services = {} } = {}) {
  const calls = { inject: [], provides: [], warns: [], infos: [] }
  const provided = new Map()
  const ctx = {
    fiber: { config },
    logger: {
      warn: (message) => calls.warns.push(String(message)),
      info: (message) => calls.infos.push(String(message))
    },
    get(name) {
      if (provided.has(name)) return provided.get(name)
      return services[name]
    },
    provide(name, value) {
      if (provided.has(name)) throw new Error('service already provided: ' + name)
      provided.set(name, value)
      calls.provides.push(name)
    },
    inject(deps, callback) {
      calls.inject.push(deps)
      return callback(ctx)
    }
  }
  return { ctx, calls, provided }
}

test('包根入口把 entryRole:host 当作宿主行，且不注册任何工具', () => {
  const { ctx, calls, provided } = fakeContext({ config: { entryRole: 'host' } })
  entry.apply(ctx, { entryRole: 'host' })
  // 宿主行不得注入 tools；只允许等待课堂后端所需的宿主服务（webServer / connection）。
  assert.ok(calls.inject.every((deps) => !deps.includes('tools')), '宿主行不得注入 tools')
  assert.ok(provided.has('teachSettings'), '宿主行必须提供设置服务')
  assert.deepEqual(provided.get('teachSettings').get(), { entryRole: 'host' })
})

test('包根入口把 entryRole:runtime 当作教学运行期，并显式注入 tools', () => {
  const { ctx, calls } = fakeContext({ config: { entryRole: 'runtime' } })
  entry.apply(ctx, { entryRole: 'runtime' })
  assert.deepEqual(calls.inject, [['tools']])
})

test('未知 entryRole 直接失败，不静默降级', () => {
  const { ctx } = fakeContext({ config: { entryRole: 'anything-else' } })
  assert.throws(() => entry.apply(ctx, { entryRole: 'anything-else' }), /entryRole/)
})

test('旧包根配置（没有 entryRole）仍按运行期处理', () => {
  const { ctx, calls } = fakeContext({ config: {} })
  entry.apply(ctx, {})
  assert.deepEqual(calls.inject, [['tools']])
})

test('旧 /settings 入口没有 entryRole 时按宿主处理', () => {
  const { ctx, calls, provided } = fakeContext({ config: {} })
  settingsEntry.apply(ctx, {})
  assert.ok(calls.inject.every((deps) => !deps.includes('tools')), '宿主行不得注入 tools')
  assert.ok(provided.has('teachSettings'))
})

test('两个入口导出的 Config 允许声明 entryRole', () => {
  assert.ok(entry.Config)
  assert.ok(settingsEntry.Config)
  const resolved = entry.Config({ entryRole: 'host' })
  assert.equal(resolved.entryRole, 'host')
  assert.equal(entry.Config().entryRole, undefined)
})
