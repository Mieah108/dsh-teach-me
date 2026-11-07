import assert from 'node:assert/strict'
import test from 'node:test'

import { isVolatile, unwrapVolatile } from '../../lib/shared/volatile.js'
import { resolveConfig } from '../../lib/config.js'

const WRITE = Symbol.for('cosmokit.volatile.write')

function ref(value) {
  return Object.freeze({
    get: () => value,
    [WRITE]: (next) => {
      value = next
    }
  })
}

test('识别并使用宿主同一个 Symbol.for 引用协议', () => {
  const value = ref('x')
  assert.equal(isVolatile(value), true)
  assert.equal(isVolatile({ get: () => 'x' }), false, '普通 get 对象不是 volatile')
})

test('递归解包设置行里每一层 volatile 字段', () => {
  const wrapped = {
    animation: { root: ref('/tmp/project'), softLimitSeconds: ref(120), staging: ref(true) },
    ask: { gateWhileWaiting: ref(false) },
    list: [ref('a'), { nested: ref('b') }]
  }
  assert.deepEqual(unwrapVolatile(wrapped), {
    animation: { root: '/tmp/project', softLimitSeconds: 120, staging: true },
    ask: { gateWhileWaiting: false },
    list: ['a', { nested: 'b' }]
  })
})

test('设置页值覆盖预设行且类型是普通值', () => {
  const resolved = resolveConfig(
    { entryRole: 'runtime', animation: { root: 'preset-root', softLimitSeconds: 60 } },
    {
      animation: { root: ref('/live/project'), softLimitSeconds: ref(180), missing: ref('warn'), staging: ref(false) },
      ask: { gateWhileWaiting: ref(true) }
    }
  )
  assert.equal(resolved.animation.root, '/live/project')
  assert.equal(resolved.animation.softLimitSeconds, 180)
  assert.equal(resolved.animation.missing, 'warn')
  assert.equal(resolved.animation.staging, false)
  assert.equal(resolved.ask.gateWhileWaiting, true)
  assert.equal(resolved.entryRole, 'runtime')
})
