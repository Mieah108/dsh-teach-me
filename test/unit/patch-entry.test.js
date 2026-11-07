import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')

function rowBlock(id) {
  const index = patch.indexOf('- id: ' + id)
  assert.ok(index >= 0, 'patch 里找不到行 ' + id)
  const rest = patch.slice(index)
  const next = rest.indexOf('\n          - id: ', 1)
  const nextTop = rest.indexOf('\n    - id: ', 1)
  const end = [next, nextTop].filter((value) => value > 0).sort((a, b) => a - b)[0]
  return end === undefined ? rest : rest.slice(0, end)
}

test('全局设置行使用精确包根并显式声明 host', () => {
  const block = rowBlock('teach-settings')
  assert.match(block, /name: 'dsh-teach-me'\s*$/m)
  assert.doesNotMatch(block, /name: 'dsh-teach-me\/settings'/)
  assert.match(block, /entryRole: host/)
})

test('教学预设行显式声明 runtime', () => {
  const block = rowBlock('teach-me')
  assert.match(block, /entryRole: runtime/)
})

test('包导出仍保留精确包根与旧 /settings 入口', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./settings'], './lib/settings.js')
  assert.equal(pkg.exports['./client'], './client.js')
})
