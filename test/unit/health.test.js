import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishLesson, recordSubmission, registerQuestion } from '../../lib/archive/operations.js'
import { collectHealth, formatHealth, registerStatusTool } from '../../lib/health.js'

const coreServices = {
  teachSettings: { get: () => ({}), source: 'test' },
  tools: { register: () => () => {} },
  workingDirectory: { get: () => '/tmp' }
}

const ctxOf = (services) => ({ get: (name) => services[name] })
const config = (root) => () => ({ animation: { root } })

test('核心服务都在时 healthy，可选缺失只降级', () => {
  const health = collectHealth(ctxOf(coreServices), config(''))
  assert.equal(health.healthy, true)
  assert.equal(health.animation.state, 'unconfigured')
  assert.equal(health.optional.find((item) => item.id === 'user-questions').ok, false)
  assert.equal(health.optional.find((item) => item.id === 'agents').ok, false)
})

test('核心服务缺失时 unhealthy 并指出是谁', () => {
  const health = collectHealth(ctxOf({ tools: coreServices.tools }), config(''))
  assert.equal(health.healthy, false)
  const missing = health.core.filter((item) => !item.ok).map((item) => item.id)
  assert.deepEqual(missing, ['settings', 'working-directory'])
})

test('动画工程目录不存在时是 broken，不是 ready', () => {
  const health = collectHealth(ctxOf(coreServices), config('/nonexistent/teach-animation-project'))
  assert.equal(health.animation.state, 'broken')
})

test('工程在但宿主没有执行器时是 degraded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-health-'))
  fs.writeFileSync(path.join(root, 'package.json'), '{}')
  fs.mkdirSync(path.join(root, 'node_modules'))
  const noExecutor = collectHealth(ctxOf(coreServices), config(root))
  assert.equal(noExecutor.animation.state, 'degraded')
  const ready = collectHealth(
    ctxOf({ ...coreServices, subprocess: { spawn: () => {}, resolveExecutable: () => '/bin/true' }, jobs: { start: () => 'job-1' } }),
    config(root)
  )
  assert.equal(ready.animation.state, 'ready')
})

test('报告按核心/可选/动画分区', () => {
  const text = formatHealth(collectHealth(ctxOf(coreServices), config('')))
  assert.match(text, /核心能力/)
  assert.match(text, /可选能力/)
  assert.match(text, /动画/)
  assert.match(text, /核心能力都在/)
})

/** 建一个有档案的工作区：发布一课，再按需要登记一题并交一份答案。 */
function archiveWorkspace({ submit = true } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-health-archive-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), '<html>lesson</html>')
  publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  if (submit) {
    registerQuestion(ws, { id: 'q-open', lessonId: 'l1', type: 'explanation', prompt: '说说你的判断。' })
    recordSubmission(ws, { questionId: 'q-open', rawAnswer: '我的判断是：先看约束。' })
  }
  return ws
}

function statusHarness({ preset = 'auto', workspace, stageOf } = {}) {
  let tool
  const services = {
    ...coreServices,
    tools: {
      register(definition) {
        tool = definition
        return () => {}
      }
    }
  }
  if (preset !== null) {
    services.permissionPresets = {
      current: (session) => {
        assert.equal(session?.id, 's1')
        return preset
      }
    }
  }
  const ctx = { get: (name) => services[name], effect: (factory) => factory() }
  const options = {}
  if (workspace !== undefined) options.workspaceOf = () => workspace
  if (stageOf !== undefined) options.stageOf = stageOf
  registerStatusTool(ctx, () => ({ animation: { root: '' } }), options)
  return { tool }
}

test('teach_status 在 auto 权限下说清「写入可能被整段丢弃」，并返回 permission 字段', async () => {
  const { tool } = statusHarness({ preset: 'auto' })
  const value = await tool.execute({}, { agent: { session: { id: 's1' } } })
  assert.equal(value.permission, 'auto')
  assert.match(value.text, /自动审查/)
  assert.match(value.text, /不自动重试/)
  assert.match(value.text, /换回 ask/)
})

test('非 auto 权限只报预设名，不吓唬人', async () => {
  const { tool } = statusHarness({ preset: 'workspace-write' })
  const value = await tool.execute({}, { agent: { session: { id: 's1' } } })
  assert.equal(value.permission, 'workspace-write')
  assert.match(value.text, /权限：workspace-write/)
  assert.doesNotMatch(value.text, /不自动重试/)
})

test('读不到权限服务时不返回 permission 字段（契约保持窄）', async () => {
  const { tool } = statusHarness({ preset: null })
  const value = await tool.execute({}, { agent: { session: { id: 's1' } } })
  assert.equal(Object.hasOwn(value, 'permission'), false)
})

test('导师侧待批改：有开放题提交时点出条数与 submissionId，并指向 teach_grade_open', async () => {
  const workspace = archiveWorkspace()
  const { tool } = statusHarness({ preset: 'ask', workspace })
  const value = await tool.execute({}, { agent: { session: { id: 's1' } } })
  const lines = value.text.split('\n').filter((line) => line.includes('待批改'))
  assert.equal(lines.length, 1, value.text)
  assert.match(lines[0], /^待批改 1 条：sub_/)
  assert.match(lines[0], /teach_grade_open/)
  assert.match(lines[0], /开放题不会自动批改/)
  // 既有档案行保持原样
  assert.match(value.text, /档案：workspace ws_/)
  assert.match(value.text, /待复核/)
})

test('teach_status 报阶段来源：档案（run vN）与内存兜底都如实说', async () => {
  const archiveStage = {
    stage: 'build',
    runId: 'agent-1',
    runRevision: 3,
    source: 'archive',
    persisted: true,
    pending: [{ id: 'p1', kind: 'approval', label: '等点头' }]
  }
  const fromArchive = statusHarness({ preset: 'ask', stageOf: () => archiveStage })
  const value = await fromArchive.tool.execute({}, { agent: { session: { id: 's1' } } })
  assert.match(value.text, /阶段：build（来源：档案（run agent-1 v3））/)
  assert.match(value.text, /待确认 1 条/)
  assert.equal(value.stageSource, 'archive')
  assert.equal(value.stagePersisted, true)

  const memoryStage = { stage: 'intake', runId: 'agent-1', runRevision: 0, source: 'memory', persisted: false, reason: '还没有学习档案' }
  const fromMemory = statusHarness({ preset: 'ask', stageOf: () => memoryStage })
  const fallback = await fromMemory.tool.execute({}, { agent: { session: { id: 's1' } } })
  assert.match(fallback.text, /阶段：intake（来源：内存（还没有学习档案））/)
  assert.equal(fallback.stageSource, 'memory')
  assert.equal(fallback.stagePersisted, false)

  // 没装阶段工具时不返回这两个字段（契约保持窄，也不加空行）。
  const bare = statusHarness({ preset: 'ask' })
  const none = await bare.tool.execute({}, { agent: { session: { id: 's1' } } })
  assert.equal(Object.hasOwn(none, 'stageSource'), false)
  assert.equal(Object.hasOwn(none, 'stagePersisted'), false)
  assert.doesNotMatch(none.text, /阶段：/)
})

test('没有待批改时不加这一行（不改既有行）', async () => {
  const workspace = archiveWorkspace({ submit: false })
  const { tool } = statusHarness({ preset: 'ask', workspace })
  const value = await tool.execute({}, { agent: { session: { id: 's1' } } })
  assert.match(value.text, /档案：workspace ws_/)
  assert.doesNotMatch(value.text, /待批改/)
})

test('F4 status有待批改也仅重放一次journal（阶段、上下文、drift共用快照）', async (t) => {
  const workspace = archiveWorkspace()
  const { registerStageTool } = await import('../../lib/stages.js')
  const { openArchive } = await import('../../lib/archive/store.js')
  const journal = path.join(openArchive(workspace).path, 'journal', 'events.jsonl')
  let reads = 0
  const original = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (String(file).includes('/journal/') && String(file).endsWith('.jsonl')) reads++
    return original(file, ...args)
  })
  const ctx = { get: () => undefined, effect: f => f() }
  const api = registerStageTool(ctx, () => ({ stages: {start:'intake'}, tools: {stage:false} }), os.tmpdir(), () => workspace)
  const { tool } = statusHarness({ workspace, preset: 'ask', stageOf: (agent, snapshot) => api.stageOf(agent, snapshot) })
  const value = await tool.execute({}, { agent: { id: 'a1', session: { id: 's1' } } })
  assert.match(value.text, /学习上下文/)
  assert.match(value.text, /评估待处理 1/)
  assert.equal(reads, 1, journal)
})
