import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  applyAllowlist,
  diffPatches,
  hostPresetCandidates,
  loadAllowlist,
  parsePatch,
  run
} from '../../scripts/check-preset-drift.mjs'

const FIXTURES = new URL('../fixtures/preset-drift/', import.meta.url)
const HOST = fileURLToPath(new URL('host.patch.yml', FIXTURES))
const LOCAL = fileURLToPath(new URL('local.patch.yml', FIXTURES))
const ALLOW_GOOD = fileURLToPath(new URL('allowlist.good.json', FIXTURES))
const ALLOW_STALE = fileURLToPath(new URL('allowlist.stale.json', FIXTURES))
const ALLOW_SHORT = fileURLToPath(new URL('allowlist.short-reason.json', FIXTURES))
const SCRIPT = fileURLToPath(new URL('../../scripts/check-preset-drift.mjs', import.meta.url))
const REPO_ALLOWLIST = fileURLToPath(new URL('../../scripts/preset-drift.allowlist.json', import.meta.url))

function readHost() {
  return readFileSync(HOST, 'utf8')
}

function readLocal() {
  return readFileSync(LOCAL, 'utf8')
}

test('解析：行 id、嵌套组、预设子行统一映射成 preset/<id>', () => {
  const parsed = parsePatch(readHost())
  assert.deepEqual([...parsed.byPath.keys()].sort(), [
    'preset-ptc',
    'preset/delegation',
    'preset/delegation/tool-subagent',
    'preset/persona',
    'preset/tool-a',
    'preset/tool-schedule'
  ])
  assert.equal(parsed.byPath.get('preset/delegation/tool-subagent').fields.provider, 'spawn')
})

test('解析：块标量保留内容并去掉尾部空白（比较时不因排版抖动报漂移）', () => {
  const parsed = parsePatch(readLocal())
  const persona = parsed.byPath.get('preset/persona')
  assert.equal(persona.fields.prefix, '你是教学模式导师。\n第二行。')
})

test('三分类：missing / extra / key drift 各一例（含行序 #order）', () => {
  const diff = diffPatches(readHost(), readLocal())
  assert.deepEqual(diff.missing.map((item) => item.id).sort(), ['preset-ptc', 'preset/tool-schedule'])
  assert.deepEqual(diff.extra.map((item) => item.id).sort(), ['preset-teach', 'preset/delegation/tool-only'])
  const keys = diff.keyDrift.map((item) => item.id + '::' + item.key).sort()
  assert.deepEqual(keys, ['preset/persona::prefix'])
})

test('行序漂移单独记成 key drift #order（不会被静默漏掉）', () => {
  const host = "- insert:\n    - id: p\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        plugins:\n          - id: a\n            name: '@deepseek-ai/dsh-a'\n          - id: b\n            name: '@deepseek-ai/dsh-b'\n"
  const local = "- insert:\n    - id: p\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        plugins:\n          - id: b\n            name: '@deepseek-ai/dsh-b'\n          - id: a\n            name: '@deepseek-ai/dsh-a'\n"
  const diff = diffPatches(host, local)
  assert.equal(diff.missing.length, 0)
  assert.equal(diff.extra.length, 0)
  assert.ok(diff.keyDrift.some((item) => item.key === '#order'))
})

test('allowlist 命中：全部登记后没有未解释差异，也没有腐烂项', () => {
  const diff = diffPatches(readHost(), readLocal())
  const result = applyAllowlist(diff, loadAllowlist(ALLOW_GOOD))
  assert.equal(result.unallowed.length, 0)
  assert.equal(result.rot.length, 0)
  assert.deepEqual(result.allowed.map((item) => item.kind).sort(), ['key', 'row', 'row', 'row', 'row'])
})

test('allowlist 腐烂：登记了不存在的行必须报错（不是静默忽略）', () => {
  const diff = diffPatches(readHost(), readLocal())
  const result = applyAllowlist(diff, loadAllowlist(ALLOW_STALE))
  assert.equal(result.unallowed.length, 0)
  assert.deepEqual(result.rot.map((entry) => entry.id), ['preset/ghost'])
})

test('宿主版本移除整行时报告行差异，不把无法比较的字段登记判为腐烂', () => {
  const mode = { kind: 'key', id: 'preset/tool-presentation', key: 'mode' }
  const row = { kind: 'row', id: mode.id, side: 'local' }
  const result = applyAllowlist({ missing: [], extra: [row], keyDrift: [] }, [mode])
  assert.deepEqual(result.unallowed, [row])
  assert.deepEqual(result.rot, [])
  assert.deepEqual(applyAllowlist({ missing: [], extra: [], keyDrift: [] }, [mode]).rot, [mode])
})

test('allowlist 格式：理由太短 / kind 非法 / key 缺 key 都必须拒绝', () => {
  assert.throws(() => loadAllowlist(ALLOW_SHORT), /理由太短/)
  assert.throws(() => loadAllowlist(new URL('missing.json', FIXTURES).pathname), /ENOENT|no such file/)
})

test('宿主缺失：跳过而不是失败（CI 与别人机器上不该因没装宿主版本而红）', () => {
  const summary = run({ hostPath: '/definitely/not/here/ptc.patch.yml', patchPath: LOCAL, allowlistPath: ALLOW_GOOD, quiet: true })
  assert.equal(summary.skipped, true)
  const cli = spawnSync(process.execPath, [SCRIPT, '--host', '/definitely/not/here/ptc.patch.yml'], { encoding: 'utf8' })
  assert.equal(cli.status, 0)
  assert.match(cli.stdout, /skip \(host preset not found\)/)
})

test('CLI：夹具全登记 → exit 0 且输出 missing 0 / extra 0 / key drift 0', () => {
  const cli = spawnSync(process.execPath, [SCRIPT, '--host', HOST, '--patch', LOCAL, '--allowlist', ALLOW_GOOD], { encoding: 'utf8' })
  assert.equal(cli.status, 0, cli.stdout + cli.stderr)
  assert.match(cli.stdout, /missing 0 \/ extra 0 \/ key drift 0/)
})

test('CLI：allowlist 腐烂 → exit 1 并给出可读原因', () => {
  const cli = spawnSync(process.execPath, [SCRIPT, '--host', HOST, '--patch', LOCAL, '--allowlist', ALLOW_STALE], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.match(cli.stdout, /allowlist 腐烂/)
})

test('CLI：未登记的真实差异 → exit 1（防止把漂移当正常）', () => {
  const cli = spawnSync(process.execPath, [SCRIPT, '--host', HOST, '--patch', LOCAL, '--allowlist', ALLOW_GOOD, '--json'], { encoding: 'utf8' })
  assert.equal(cli.status, 0)
  const empty = spawnSync(process.execPath, [SCRIPT, '--host', HOST, '--patch', LOCAL, '--allowlist', ALLOW_SHORT], { encoding: 'utf8' })
  assert.equal(empty.status, 1)
  assert.match(empty.stdout + empty.stderr, /理由太短|allowlist/)
})

test('宿主候选路径：DSH_PRESET_PTC 覆盖优先，且顺序确定', () => {
  const defaults = hostPresetCandidates({ execPath: '/opt/node/bin/node', env: {}, home: '/home/nobody' })
  assert.ok(defaults.length > 0)
  assert.match(defaults[0], /lib[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh/)
  const overridden = hostPresetCandidates({ execPath: '/opt/node/bin/node', env: { DSH_PRESET_PTC: '/tmp/custom.yml' }, home: '/home/nobody' })
  assert.equal(overridden[0], '/tmp/custom.yml')
  assert.deepEqual(defaults, hostPresetCandidates({ execPath: '/opt/node/bin/node', env: {}, home: '/home/nobody' }))
})

test('仓库自己的 allowlist：格式合法、无重复条目、每条理由非空', () => {
  const entries = loadAllowlist(REPO_ALLOWLIST)
  assert.ok(entries.length > 0)
  const seen = new Set()
  for (const entry of entries) {
    const key = entry.kind + '/' + entry.id + '/' + (entry.key ?? '')
    assert.equal(seen.has(key), false, '重复条目：' + key)
    seen.add(key)
    assert.ok(entry.reason.length >= 8)
  }
})
