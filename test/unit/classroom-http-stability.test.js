import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { registerClassroom } from '../../lib/classroom/service.js'
import { parseRange } from '../../lib/classroom/assets.js'
import { fakeResponse } from '../helpers/classroom-rpc.js'

function harness() {
  let route
  const connection = { requestRejection: () => undefined }
  registerClassroom({
    get: (key) => ({ connection, webServer: { register: (item) => { route = item; return () => {} } } })[key],
    effect: (factory) => factory()
  })
  return { route, connection }
}
function request() {
  const req = new EventEmitter()
  Object.assign(req, { method: 'POST', url: '/teach-classroom/rpc/diagnostics/get', headers: {} })
  return req
}

test('请求中途断开时 handler 结算，不无限等 end', async () => {
  const { route } = harness()
  const req = request()
  const res = fakeResponse()
  const done = route.handler(req, res)
  req.emit('aborted')
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('request stuck')), 100))])
  assert.equal(res.statusCode, 400)
})

test('请求体超限是 413，非法 JSON 和错误 payload 是 400', async () => {
  for (const [body, status] of [[Buffer.alloc(4 * 1024 * 1024 + 1), 413], [Buffer.from('{bad'), 400], [Buffer.from('{"payload":[]}'), 400]]) {
    const { route } = harness()
    const req = request()
    const res = fakeResponse()
    const done = route.handler(req, res)
    req.emit('data', body)
    req.emit('end')
    await done
    assert.equal(res.statusCode, status)
  }
})

test('鉴权服务失效时不回退到无登录检查', async () => {
  const { route, connection } = harness()
  delete connection.requestRejection
  const req = request()
  const res = fakeResponse()
  const done = route.handler(req, res)
  req.emit('end')
  await done
  assert.equal(res.statusCode, 403)
})

test('畸形 URL 返回 400，不向宿主抛异常', async () => {
  const { route } = harness()
  const req = request()
  req.url = 'http://['
  const res = fakeResponse()
  await route.handler(req, res)
  assert.equal(res.statusCode, 400)
})

test('空文件 Range 无法满足，超出安全整数的区间被忽略', () => {
  assert.equal(parseRange('bytes=-2', 0).unsatisfiable, true)
  assert.equal(parseRange('bytes=9007199254740993-', 10), null)
})
