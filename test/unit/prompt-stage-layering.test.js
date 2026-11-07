import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { registerPrompt, stageFamilyOf } from '../../lib/prompt.js'
import { registerStageTool } from '../../lib/stages.js'
import { openArchive } from '../../lib/archive/store.js'
import { resolveConfig } from '../../lib/config.js'

const root = fileURLToPath(new URL('../..', import.meta.url))
function harness({ layered = true, animation = false, dir = '', stageOf } = {}) {
  const sections = []
  const ctx = { systemPrompt: { section: (s) => { sections.push(s); return () => {} }, variable: () => () => {} }, effect: (fn) => fn() }
  registerPrompt(ctx, () => resolveConfig({ prompt: { stageLayering: layered, dir }, animation: { root: animation ? '/tmp/project' : '' } }), root, { stageOf })
  const rendered = (scope) => sections.slice().sort((a, b) => a.order - b.order).map((s) => ({ ...s, text: typeof s.text === 'function' ? s.text({ scope }) : s.text })).filter((s) => s.text.length > 0)
  return { sections, rendered, text: (scope) => rendered(scope).map((s) => s.text).join('\n\n') }
}

test('F3：默认关闭，合法阶段映射完整，未知保持全量规则', () => {
  assert.equal(resolveConfig({}).prompt.stageLayering, false)
  for (const id of ['intake', 'diagnose', 'plan']) assert.equal(stageFamilyOf(id), 'diagnose')
  for (const id of ['build', 'check', 'video-pitch', 'video-build', 'video-render']) assert.equal(stageFamilyOf(id), 'production')
  for (const id of ['accept', 'record']) assert.equal(stageFamilyOf(id), 'review')
  assert.equal(stageFamilyOf('new-stage'), null)
  const plain = harness({ layered: false })
  const unknown = harness({ stageOf: () => ({ stage: 'new-stage' }) })
  const agent = { id: 'a' }
  assert.deepEqual(unknown.rendered(agent).flatMap((s) => s.text.split('\n')).filter(Boolean).sort(), plain.rendered(agent).flatMap((s) => s.text.split('\n')).filter(Boolean).sort())
  assert.equal(unknown.text(agent).includes('<!-- teach:'), false)
  assert.equal(unknown.text(undefined), unknown.text(agent))
})

test('F3：逐次按scope求阶段，两个会话隔离，同族内容稳定，共用前缀不变', () => {
  const a = { id: 'a' }, b = { id: 'b' }
  const stages = new Map([[a, 'diagnose'], [b, 'record']])
  const h = harness({ stageOf: (agent) => ({ stage: stages.get(agent) }) })
  const before = h.text(a), other = h.text(b)
  assert.match(before, /地基（第 0 层）/)
  assert.doesNotMatch(other, /地基（第 0 层）/)
  assert.doesNotMatch(before, /### 页面框架/)
  stages.set(a, 'build')
  assert.match(h.text(a), /### 页面框架/)
  assert.equal(h.text(b), other)
  const build = h.text(a)
  stages.set(a, 'check')
  assert.equal(h.text(a), build)
  assert.deepEqual(h.rendered(a).filter((s) => s.order < 300), h.rendered(b).filter((s) => s.order < 300))
  for (const id of ['diagnose', 'build', 'record']) {
    stages.set(a, id)
    for (const rule of ['等他答的时候', '这些必须先问', '先钉材料再开口', '收尾把结论写进学习记录', '### 交付前', '新对话先诊断本次主题', '计划经学习者确认后再产出']) assert.ok(h.text(a).includes(rule), `${id} lacks ${rule}`)
  }
})

test('F3：阶段读取抛错/坏scope保留全量，自定义目录不裁剪', (t) => {
  const full = harness({ stageOf: () => { throw new Error('unavailable') } })
  assert.match(full.text({ id: 'a' }), /### 页面框架/)
  assert.match(full.text('a'), /地基（第 0 层）/)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-layer-custom-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, '10-startup.md'), 'custom rules')
  const h = harness({ dir, stageOf: () => ({ stage: 'build' }) })
  assert.equal(h.text({ id: 'a' }), 'custom rules')
})

test('F3：动画仍只依配置，三族同样持有完整动画段', () => {
  for (const stage of ['diagnose', 'build', 'record', 'future']) {
    const h = harness({ animation: true, stageOf: () => ({ stage }) })
    const s = h.rendered({ id: 'a' }).find((s) => s.name === 'teach:60-animation')
    assert.ok(s)
    assert.equal(s.text, fs.readFileSync(path.join(root, 'prompt/60-animation.md'), 'utf8').trim())
    assert.equal(harness({ stageOf: () => ({ stage }) }).rendered({ id: 'a' }).some((s) => s.name === 'teach:60-animation'), false)
  }
})

test('F3：阶段写档案后新实例恢复，provider读取恢复阶段', async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-layer-restore-'))
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
  openArchive(ws, { create: true })
  const makeStage = () => {
    let tool
    const api = registerStageTool({ tools: { register: (s) => { tool = s; return () => {} } }, effect: (fn) => fn() }, () => resolveConfig({}), root, () => ws)
    return { tool, api }
  }
  const agent = { id: 'a', session: { id: 's' } }
  const first = makeStage()
  await first.tool.execute({ action: 'set', stage: 'build' }, { agent })
  const restored = makeStage()
  const h = harness({ stageOf: (agent) => restored.api.stageOf(agent) })
  assert.match(h.text(agent), /### 页面框架/)
  assert.match(h.text(agent), /新对话先诊断本次主题/)
  assert.match(h.text(agent), /计划经学习者确认后再产出/)
  assert.doesNotMatch(h.text(agent), /地基（第 0 层）/)
  await first.tool.execute({ action: 'set', stage: 'record' }, { agent })
  const review = makeStage()
  const reviewPrompt = harness({ stageOf: (agent) => review.api.stageOf(agent) }).text(agent)
  assert.match(reviewPrompt, /新对话先诊断本次主题/)
  assert.match(reviewPrompt, /计划经学习者确认后再产出/)
  assert.doesNotMatch(reviewPrompt, /### 页面框架/)
})

test('F3：计量矩阵真实求值，未知全量且所有off组合满足收口目标', () => {
  const run = spawnSync(process.execPath, ['scripts/measure-context.mjs', '--stage-matrix', '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const matrix = JSON.parse(run.stdout)
  assert.equal(matrix.consistent, true)
  assert.equal(matrix.profiles.length, 10)
  for (const row of matrix.profiles) assert.match(row.resolvedTextSha256, /^[0-9a-f]{64}$/)
  for (const profile of ['animation-off', 'animation-on']) {
    const rows = matrix.profiles.filter((row) => row.profile === profile)
    const unknown = rows.find((row) => row.stage === 'unknown')
    assert.ok(unknown.constantWithPersonaBytes > rows.find((row) => row.stage === 'diagnose').constantWithPersonaBytes)
    assert.equal(unknown.tools, profile === 'animation-off' ? 19 : 23)
  }
  for (const row of matrix.profiles.filter((row) => row.profile === 'animation-off')) assert.ok(row.constantWithPersonaBytes <= 74 * 1024)
})
