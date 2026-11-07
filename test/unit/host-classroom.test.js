/* 宿主半边的挂载次序：课堂后端必须等 webServer 与 connection 就绪。
 *
 * 2026-10-26 真实 web 启动发现：profile 行的 apply 早于这两个服务，
 * 直接在 apply 里 get 会让 /teach-classroom 与它承载的接口永远挂不上。
 * 这组测试用假上下文固定「先等、再注册、只注册一次」的行为。
 *
 * 2026-10-27 起课堂回传不再经过 connection.rpc 的自建通道（那个在本宿主版本里
 * 注册不出 HTTP 路由，POST 会落到静态处理器返回 405），改成同一条前缀路由上的
 * POST /teach-classroom/rpc/*，鉴权只用 connection.requestRejection。 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { applyHost } from '../../lib/host.js'

function fakeCtx({ withServices = false } = {}) {
  const calls = { routes: [], rpc: [], injected: [], provided: [] }
  const services = {}
  if (withServices) {
    services.webServer = {
      register: (route) => {
        calls.routes.push(route)
        return () => {}
      }
    }
    services.connection = {
      requestRejection: () => undefined
    }
  }
  const ctx = {
    get: (name) => services[name],
    provide: (name, value) => calls.provided.push({ name, value }),
    effect: (factory) => factory(),
    inject: (deps, callback) => calls.injected.push({ deps, callback }),
    logger: { info: () => {}, warn: () => {} }
  }
  return { ctx, calls, services }
}

test('服务还没就绪时不抛错，也不提前注册路由', () => {
  const { ctx, calls } = fakeCtx()
  applyHost(ctx, { entryRole: 'host' })
  assert.equal(calls.injected.length, 1)
  assert.deepEqual(calls.injected[0].deps, ['webServer', 'connection'])
  assert.equal(calls.routes.length, 0)
  assert.equal(calls.provided.length, 2)
  assert.equal(calls.provided[0].name, 'teachPreferences')
  assert.equal(calls.provided[1].name, 'teachSettings')
  assert.equal(calls.provided[1].value.source, 'host')
})

test('服务就绪后注册 /teach-classroom 前缀路由（资源与回传共用一条）', () => {
  const { ctx, calls } = fakeCtx()
  applyHost(ctx, { entryRole: 'host' })
  const ready = fakeCtx({ withServices: true })
  calls.injected[0].callback(ready.ctx)
  assert.equal(ready.calls.routes.length, 1)
  assert.equal(ready.calls.routes[0].kind, 'prefix')
  assert.equal(ready.calls.routes[0].path, '/teach-classroom')
  assert.equal(typeof ready.calls.routes[0].handler, 'function')
})

test('重复触发只注册一次（服务重载不会重复挂路由）', () => {
  const { ctx, calls } = fakeCtx()
  applyHost(ctx, { entryRole: 'host' })
  const ready = fakeCtx({ withServices: true })
  calls.injected[0].callback(ready.ctx)
  calls.injected[0].callback(ready.ctx)
  assert.equal(ready.calls.routes.length, 1)
})

test('connection 没有 requestRejection 时明确降级，不挂没有鉴权的接口', () => {
  const { ctx, calls } = fakeCtx()
  applyHost(ctx, { entryRole: 'host' })
  const ready = fakeCtx({ withServices: true })
  ready.ctx.get = (name) => (name === 'connection' ? {} : ready.services[name])
  calls.injected[0].callback(ready.ctx)
  assert.equal(ready.calls.routes.length, 0)
})

test('没有 inject 的旧上下文：缺服务时只降级，不抛错', () => {
  const { ctx, calls } = fakeCtx()
  delete ctx.inject
  applyHost(ctx, { entryRole: 'host' })
  assert.equal(calls.provided.length, 2)
  assert.equal(calls.routes.length, 0)
})

test('服务卸载后可重新挂路由，注册失败后也能重试', () => {
  const { ctx, calls } = fakeCtx()
  applyHost(ctx, { entryRole: 'host' })
  const start = calls.injected[0].callback
  const ready = fakeCtx({ withServices: true })
  const cleanup = []
  ready.ctx.effect = (factory) => { const value = factory(); if (typeof value === 'function') cleanup.push(value) }
  start(ready.ctx)
  for (const dispose of cleanup.reverse()) dispose()
  const reloaded = fakeCtx({ withServices: true })
  start(reloaded.ctx)
  assert.equal(reloaded.calls.routes.length, 1)

  const another = fakeCtx()
  applyHost(another.ctx, { entryRole: 'host' })
  another.calls.injected[0].callback(fakeCtx().ctx)
  const recovered = fakeCtx({ withServices: true })
  another.calls.injected[0].callback(recovered.ctx)
  assert.equal(recovered.calls.routes.length, 1)
})
