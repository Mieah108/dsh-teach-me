import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  buildRenderArgs,
  createRenderSlots,
  recordRenderArtifact,
  renderConcurrency,
  startRenderHooks,
  stillRelOut
} from '../../lib/animation.js'
import { registerAnimationTools } from '../../lib/animation.js'
import { openProject } from '../../lib/sandbox.js'
import { tryOpenArchive } from '../../lib/archive/store.js'
import { artifactsOf } from '../../lib/archive/state.js'

/* ———————————————————————— 假件 ———————————————————————— */

function fakeStream() {
  const stream = new EventEmitter()
  stream.closed = false
  return stream
}

/** 一个手动结算的子进程假件：测试自己决定什么时候成功/失败/被杀。 */
function controlledChild() {
  const stdout = fakeStream()
  const stderr = fakeStream()
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  let terminations = 0
  const child = {
    stdout,
    stderr,
    done,
    waitForExit: async () => true,
    terminate() {
      terminations += 1
      stdout.closed = true
      stderr.closed = true
      resolveDone({ exitCode: null, signal: 'SIGTERM' })
    }
  }
  return {
    child,
    terminations: () => terminations,
    finish(exit = { exitCode: 0, signal: null }) {
      stdout.closed = true
      stderr.closed = true
      resolveDone(exit)
    }
  }
}

function fakeHandle() {
  const chunks = []
  return { handle: { id: 'job-x', append: (chunk) => chunks.push(String(chunk)) }, text: () => chunks.join('') }
}

async function waitFor(check, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

/**
 * 收尾一个「手动结算」的渲染作业：让子进程成功退出并等作业结算。
 * 必须做 —— 作业不结算，startRenderHooks 里的整段预算计时器就不会清，测试进程会挂着。
 */
async function settle(children, jobs, index = 0) {
  children[index].fake.finish({ exitCode: 0, signal: null })
  await jobs.started[index].runResult.done
}

/* ———————————————————————— 参数拼装 ———————————————————————— */

test('buildRenderArgs：现有参数顺序不变，追加 --overwrite / --concurrency / --timeout，永不传 --port', () => {
  const renderArgs = buildRenderArgs({
    mode: 'render',
    composition: 'RopimDataflow',
    relOut: 'out/LLM/ropim-dataflow.mp4',
    frameTimeoutMs: 30000,
    concurrency: 2
  })
  assert.deepEqual(renderArgs, [
    'render',
    'src/index.ts',
    'RopimDataflow',
    'out/LLM/ropim-dataflow.mp4',
    '--overwrite',
    '--concurrency',
    '2',
    '--timeout',
    '30000'
  ])

  const stillArgs = buildRenderArgs({
    mode: 'still',
    composition: 'Demo',
    relOut: 'out/LLM/demo-f7.png',
    frame: 7,
    frameTimeoutMs: 30000,
    concurrency: 1
  })
  assert.deepEqual(stillArgs, [
    'still',
    'src/index.ts',
    'Demo',
    'out/LLM/demo-f7.png',
    '--frame',
    '7',
    '--overwrite',
    '--concurrency',
    '1',
    '--timeout',
    '30000'
  ])

  // --timeout 是单帧 delayRender 上限，不是整段预算：非法值回落到 30 秒，负值夹到 1
  assert.equal(renderArgs.includes('--port'), false)
  assert.equal(buildRenderArgs({ mode: 'render', composition: 'D', relOut: 'out/a.mp4', frameTimeoutMs: Number.NaN })[8], '30000')
  assert.equal(buildRenderArgs({ mode: 'render', composition: 'D', relOut: 'out/a.mp4', frameTimeoutMs: -5 })[8], '1')
  assert.equal(buildRenderArgs({ mode: 'render', composition: 'D', relOut: 'out/a.mp4', frameTimeoutMs: 1234.9 })[8], '1234')
  // 不传 frameTimeoutMs 时用默认 30 秒（不再把 900 秒整段预算塞进 --timeout）
  assert.equal(buildRenderArgs({ mode: 'render', composition: 'D', relOut: 'out/a.mp4' })[8], '30000')
})

test('renderConcurrency：上限 2、下限 1，不跟着 5 个并发跑', () => {
  assert.equal(renderConcurrency(1), 1)
  assert.equal(renderConcurrency(2), 2)
  assert.equal(renderConcurrency(4), 2)
  assert.equal(renderConcurrency(16), 2)
  assert.equal(renderConcurrency(0), 1)
  assert.equal(renderConcurrency(Number.NaN), 1)
  const fallback = renderConcurrency()
  assert.ok(fallback === 1 || fallback === 2)
})

/* ———————————————————————— still 命名 ———————————————————————— */

test('stillRelOut：带帧号、平铺在 out/<类别>/ 下；poster 用 -poster.png', () => {
  assert.equal(stillRelOut({ category: 'LLM', slug: 'ropim-dataflow', frame: 0 }), 'out/LLM/ropim-dataflow-f0.png')
  assert.equal(stillRelOut({ category: 'LLM', slug: 'ropim-dataflow', frame: 1064 }), 'out/LLM/ropim-dataflow-f1064.png')
  assert.equal(stillRelOut({ category: 'DSP', slug: 'hilbert-phasor', poster: true }), 'out/DSP/hilbert-phasor-poster.png')
  // poster 只换名字，不吃帧号
  assert.equal(stillRelOut({ category: 'DSP', slug: 'hilbert-phasor', frame: 42, poster: true }), 'out/DSP/hilbert-phasor-poster.png')
  // 坏帧号不制造怪路径（不出现 fNaN / f-3）
  assert.equal(stillRelOut({ category: 'LLM', slug: 'x', frame: Number.NaN }), 'out/LLM/x-f0.png')
  assert.equal(stillRelOut({ category: 'LLM', slug: 'x', frame: -3 }), 'out/LLM/x-f0.png')

  // 这组命名满足写入围栏（平铺两层），所以不需要放宽 sandbox 白名单
  const flatPattern = /^out\/[^/]+\/[^/]+\.(mp4|png|json|txt)$/
  for (const rel of [
    stillRelOut({ category: 'LLM', slug: 'ropim-dataflow', frame: 7 }),
    stillRelOut({ category: 'LLM', slug: 'ropim-dataflow', poster: true }),
    'out/LLM/ropim-dataflow.mp4'
  ]) {
    assert.match(rel, flatPattern)
  }

  // 核心性质：不同帧不互相覆盖
  const frames = [0, 40, 240].map((frame) => stillRelOut({ category: 'LLM', slug: 'x', frame }))
  assert.equal(new Set(frames).size, 3)
})

/* ———————————————————————— 进程内互斥 ———————————————————————— */

test('createRenderSlots：同键第二次占用失败，释放后可再占用，迟到的释放抢不走别人的槽', () => {
  const slots = createRenderSlots()
  const root = '/tmp/project-a'
  assert.equal(slots.size(), 0)
  assert.equal(slots.peek(root), undefined)

  const first = slots.acquire(root, { mode: 'render', relOut: 'out/LLM/x.mp4' })
  assert.notEqual(first, null)
  assert.equal(first.mode, 'render')
  assert.equal(first.jobId, '')
  assert.equal(slots.size(), 1)

  // 同工程第二次被挡
  assert.equal(slots.acquire(root, { mode: 'still' }), null)
  assert.equal(slots.size(), 1)
  // 另一个工程互不影响
  assert.notEqual(slots.acquire('/tmp/project-b', { mode: 'still' }), null)
  assert.equal(slots.size(), 2)

  // 回填 jobId 之后的迟到释放：jobId 不匹配就不放
  first.jobId = 'job-1'
  assert.equal(slots.release(root, 'job-2'), false)
  assert.equal(slots.size(), 2)
  assert.equal(slots.release(root, 'job-1'), true)
  assert.equal(slots.size(), 1)
  // 已经释放过再释放：no-op
  assert.equal(slots.release(root, 'job-1'), false)
  // 释放时没拿到 jobId（起进程就失败的那条路）：按 root 放行
  assert.equal(slots.release('/tmp/project-b'), true)
  assert.equal(slots.size(), 0)

  // 后来者刚占槽、jobId 还没回填的窗口里，前一个作业的迟到 finally 不能把它放开
  const next = slots.acquire(root, { mode: 'still' })
  assert.equal(slots.release(root, 'job-old'), false)
  assert.equal(slots.size(), 1)
  assert.equal(slots.peek(root), next)
})

/* ———————————————————————— 失败重试 ———————————————————————— */

test('startRenderHooks：失败重试 1 次，日志写明第几次尝试，每次 spawn 参数都带并发/超时/覆盖', async () => {
  const argv = buildRenderArgs({
    mode: 'render',
    composition: 'Demo',
    relOut: 'out/LLM/demo.mp4',
    frameTimeoutMs: 30000,
    concurrency: 2
  })
  const spec = { argv: ['/fake/remotion', ...argv], cwd: '/fake/project' }
  const children = []
  const specs = []
  const subprocess = {
    spawn: (value) => {
      specs.push(value)
      const fake = controlledChild()
      children.push(fake)
      return fake.child
    }
  }
  const sink = fakeHandle()
  const hooks = startRenderHooks({
    subprocess,
    jobHandle: sink.handle,
    spec,
    command: '/fake/remotion ' + argv.join(' '),
    timeoutMs: 60000,
    retries: 1,
    retryDelayMs: 0
  })

  assert.equal(children.length, 1)
  children[0].finish({ exitCode: 3, signal: null })
  const second = await waitFor(() => (children.length === 2 ? children[1] : undefined))
  second.finish({ exitCode: 0, signal: null })

  assert.deepEqual(await hooks.done, { status: 'completed' })
  assert.equal(specs.length, 2)
  for (const value of specs) {
    assert.ok(value.argv.includes('--concurrency'))
    assert.equal(value.argv[value.argv.indexOf('--concurrency') + 1], '2')
    assert.ok(value.argv.includes('--timeout'))
    assert.equal(value.argv[value.argv.indexOf('--timeout') + 1], '30000')
    assert.ok(value.argv.includes('--overwrite'))
  }
  const log = sink.text()
  assert.match(log, /第 1\/2 次尝试/)
  assert.match(log, /第 2\/2 次尝试/)
  assert.match(log, /第 1 次尝试失败（exit code: 3）/)
  assert.match(log, /0 秒后重试/)
})

test('startRenderHooks：启动失败（spawn 抛错）也重试，第 2 次成功', async () => {
  let calls = 0
  const children = []
  const subprocess = {
    spawn: () => {
      calls += 1
      if (calls === 1) throw new Error('exec format error')
      const fake = controlledChild()
      children.push(fake)
      return fake.child
    }
  }
  const sink = fakeHandle()
  const hooks = startRenderHooks({
    subprocess,
    jobHandle: sink.handle,
    spec: { argv: ['/fake/remotion', 'render'] },
    command: '/fake/remotion render',
    timeoutMs: 60000,
    retries: 1,
    retryDelayMs: 0
  })
  const retryChild = await waitFor(() => children[0])
  retryChild.finish({ exitCode: 0, signal: null })
  assert.deepEqual(await hooks.done, { status: 'completed' })
  assert.equal(calls, 2)
  assert.match(sink.text(), /启动失败：exec format error/)
  assert.match(sink.text(), /第 1 次尝试失败（startup failed）/)
})

test('startRenderHooks：取消不重试，第二次尝试不会发生', async () => {
  const children = []
  const subprocess = {
    spawn: () => {
      const fake = controlledChild()
      children.push(fake)
      return fake.child
    }
  }
  const hooks = startRenderHooks({
    subprocess,
    jobHandle: fakeHandle().handle,
    spec: { argv: ['/fake/remotion', 'render'] },
    command: '/fake/remotion render',
    timeoutMs: 60000,
    retries: 1,
    retryDelayMs: 0
  })
  hooks.cancel()
  assert.deepEqual(await hooks.done, { status: 'killed', detail: 'cancelled' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(children.length, 1)
})

test('startRenderHooks：在等重试时取消，直接结算 killed，不再起第二次尝试', async () => {
  const children = []
  const subprocess = {
    spawn: () => {
      const fake = controlledChild()
      children.push(fake)
      return fake.child
    }
  }
  const hooks = startRenderHooks({
    subprocess,
    jobHandle: fakeHandle().handle,
    spec: { argv: ['/fake/remotion', 'render'] },
    command: '/fake/remotion render',
    timeoutMs: 60000,
    retries: 1,
    retryDelayMs: 200
  })
  children[0].finish({ exitCode: 3, signal: null })
  // 等第 1 次失败进入重试延迟，再取消
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(children.length, 1)
  hooks.cancel()
  assert.deepEqual(await hooks.done, { status: 'killed', detail: 'cancelled' })
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(children.length, 1)
})

test('startRenderHooks：超时不重试（整体预算已经花完），只终止一次', async () => {
  const children = []
  const subprocess = {
    spawn: () => {
      const fake = controlledChild()
      children.push(fake)
      return fake.child
    }
  }
  const hooks = startRenderHooks({
    subprocess,
    jobHandle: fakeHandle().handle,
    spec: { argv: ['/fake/remotion', 'render'] },
    command: '/fake/remotion render',
    timeoutMs: 20,
    retries: 1,
    retryDelayMs: 0
  })
  const result = await hooks.done
  assert.equal(result.status, 'failed')
  assert.match(result.detail, /timeout/)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(children.length, 1)
  assert.equal(children[0].terminations(), 1)
})

/* ———————————————————————— 归档 ———————————————————————— */

function makeRenderProject({ durationInFrames = 90, fps = 30 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-render-project-'))
  const root = path.join(base, 'project')
  fs.mkdirSync(root)
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo-project', dependencies: { remotion: '4.0.0', '@remotion/cli': '4.0.0' } })
  )
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'src', 'index.ts'),
    "import { registerRoot } from 'remotion'\nimport { RemotionRoot } from './Root'\n\nregisterRoot(RemotionRoot)\n"
  )
  fs.writeFileSync(path.join(root, 'src', 'Root.tsx'), 'export const RemotionRoot = () => (\n  <>\n  </>\n)\n')
  fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'node_modules', '.bin', 'remotion'), '#!/bin/sh\nexit 0\n')
  // 受管清单：render 的 frames/fps 与 still 的帧号范围都从这里派生
  if (durationInFrames !== null) {
    const lessons = path.join(root, '.dsh-teach', 'managed', 'lessons', 'LLM')
    fs.mkdirSync(lessons, { recursive: true })
    fs.writeFileSync(
      path.join(lessons, 'ropim-dataflow.json'),
      JSON.stringify({
        category: 'LLM',
        slug: 'ropim-dataflow',
        composition: 'RopimDataflow',
        revision: 'r1',
        entry: { registrable: true, durationInFrames, fps }
      })
    )
  }
  const write = (rel, body) => {
    const absolute = path.join(root, rel)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, body)
  }
  return {
    root,
    write,
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true })
    }
  }
}

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-render-workspace-'))
  return { workspace, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) }
}

test('recordRenderArtifact：render 记 path/sha256/帧数/fps/时长，frame 为 null', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  try {
    const project = openProject(fixture.root)
    const calls = []
    fixture.write('out/LLM/ropim-dataflow.mp4', 'fake-mp4-bytes')
    const logs = []
    const recorded = await recordRenderArtifact({
      workspace,
      lessonId: null,
      project,
      category: 'LLM',
      slug: 'ropim-dataflow',
      mode: 'render',
      relOut: 'out/LLM/ropim-dataflow.mp4',
      log: (text) => logs.push(text),
      record: (root, payload) => {
        calls.push({ root, payload })
        return { ...payload, committed: true }
      }
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].root, workspace)
    assert.equal(calls[0].payload.lessonId, null)
    assert.equal(calls[0].payload.path, 'out/LLM/ropim-dataflow.mp4')
    assert.equal(calls[0].payload.sha256, createHash('sha256').update('fake-mp4-bytes').digest('hex'))
    assert.equal(calls[0].payload.frames, 90)
    assert.equal(calls[0].payload.fps, 30)
    assert.equal(calls[0].payload.durationMs, 3000)
    assert.equal(calls[0].payload.frame, null)
    assert.equal(calls[0].payload.poster, false)
    assert.equal(recorded.path, 'out/LLM/ropim-dataflow.mp4')
    assert.match(logs.join(''), /产物已记入教学档案/)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('recordRenderArtifact：still 记帧号与 poster，frames=1、durationMs 为 null', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  try {
    const project = openProject(fixture.root)
    fixture.write('out/LLM/ropim-dataflow-f89.png', 'fake-png-bytes')
    const calls = []
    const recorded = await recordRenderArtifact({
      workspace,
      project,
      category: 'LLM',
      slug: 'ropim-dataflow',
      mode: 'still',
      relOut: 'out/LLM/ropim-dataflow-f89.png',
      frame: 89,
      poster: true,
      record: (root, payload) => {
        calls.push(payload)
        return { ...payload, committed: true }
      },
      log: () => {}
    })
    assert.equal(calls[0].frames, 1)
    assert.equal(calls[0].durationMs, null)
    assert.equal(calls[0].fps, 30)
    assert.equal(calls[0].frame, 89)
    assert.equal(calls[0].poster, true)
    assert.equal(recorded.frame, 89)

    // render 模式下就算传了 frame/poster 也不记（成片没有帧号）
    const renderCalls = []
    fixture.write('out/LLM/ropim-dataflow.mp4', 'fake-mp4-bytes')
    await recordRenderArtifact({
      workspace,
      project,
      category: 'LLM',
      slug: 'ropim-dataflow',
      mode: 'render',
      relOut: 'out/LLM/ropim-dataflow.mp4',
      frame: 12,
      poster: true,
      record: (root, payload) => {
        renderCalls.push(payload)
        return { ...payload, committed: true }
      },
      log: () => {}
    })
    assert.equal(renderCalls[0].frame, null)
    assert.equal(renderCalls[0].poster, false)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('recordRenderArtifact：真档案里 still 的帧号进了投影，旧字段照旧', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  try {
    const project = openProject(fixture.root)
    fixture.write('out/LLM/ropim-dataflow-f7.png', 'fake-png-7')
    const recorded = await recordRenderArtifact({
      workspace,
      project,
      category: 'LLM',
      slug: 'ropim-dataflow',
      mode: 'still',
      relOut: 'out/LLM/ropim-dataflow-f7.png',
      frame: 7,
      log: () => {}
    })
    assert.equal(recorded.path, 'out/LLM/ropim-dataflow-f7.png')
    const artifacts = artifactsOf(tryOpenArchive(workspace, { repairIndex: false }).state)
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].path, 'out/LLM/ropim-dataflow-f7.png')
    assert.equal(artifacts[0].frames, 1)
    assert.equal(artifacts[0].durationMs, null)
    assert.equal(artifacts[0].frame, 7)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('recordRenderArtifact：没有工作区或产物缺失时只写日志、返回 null，不建档案', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  try {
    const project = openProject(fixture.root)
    const logs = []
    const noWorkspace = await recordRenderArtifact({
      workspace: undefined,
      project,
      category: 'LLM',
      slug: 'ropim-dataflow',
      mode: 'render',
      relOut: 'out/LLM/ropim-dataflow.mp4',
      log: (text) => logs.push(text)
    })
    assert.equal(noWorkspace, null)
    assert.equal(fs.existsSync(path.join(workspace, '.dsh-teach-me', 'archive')), false)

    const missing = await recordRenderArtifact({
      workspace,
      project,
      category: 'LLM',
      slug: 'ropim-dataflow',
      mode: 'still',
      relOut: 'out/LLM/ropim-dataflow-f404.png',
      frame: 404,
      log: (text) => logs.push(text)
    })
    assert.equal(missing, null)
    assert.match(logs.join(''), /产物读不出来/)
    assert.equal(tryOpenArchive(workspace, { repairIndex: false }), null)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

/* ———————————————————————— 工具接线 ———————————————————————— */

function fakeCtx({ workspace, jobs, subprocess }) {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (tool) => { registered.push(tool); return () => {} } }
      if (name === 'jobs') return jobs
      if (name === 'subprocess') return subprocess
      if (name === 'workingDirectory') return { get: () => workspace }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    }
  }
  return { ctx, registered }
}

function fakeJobs({ failFirst = false } = {}) {
  const started = []
  let calls = 0
  return {
    started,
    start(spec) {
      calls += 1
      if (failFirst === true && calls === 1) throw new Error('registry unavailable')
      const chunks = []
      const id = 'job-' + calls
      const handle = { id, append: (chunk) => chunks.push(String(chunk)), updateProgress: () => {} }
      const runResult = spec.run(handle)
      started.push({ spec, handle, runResult, text: () => chunks.join('') })
      return id
    }
  }
}

/** 起进程后立刻成功的 subprocess 假件（归档路径用）。 */
function fakeSubprocess(children) {
  return {
    async resolveExecutable(binary) {
      return binary
    },
    spawn(spec) {
      const fake = controlledChild()
      children.push({ spec, fake })
      setTimeout(() => fake.finish({ exitCode: 0, signal: null }), 0)
      return fake.child
    }
  }
}

/** 不自动结束：测试自己决定这次渲染什么时候完成（互斥测试用）。 */
function fakeSubprocessManual(children) {
  return {
    async resolveExecutable(binary) {
      return binary
    },
    spawn(spec) {
      const fake = controlledChild()
      children.push({ spec, fake })
      return fake.child
    }
  }
}

const AGENT = { session: { id: 'session-1' }, id: 'agent-1' }

function makeConfig(fixture, extra = {}) {
  return {
    animation: { enabled: true, root: fixture.root, softLimitSeconds: 120, frameTimeoutMs: 30000, ...extra },
    tools: { animation: true }
  }
}

function registerRender(tools, { config, workspace, deps }) {
  const { ctx, registered } = fakeCtx({ workspace, jobs: tools.jobs, subprocess: tools.subprocess })
  registerAnimationTools(ctx, () => config, () => workspace, deps === undefined ? undefined : { render: deps })
  return registered.find((item) => item.name === 'teach_animation_render')
}

function makeSlots() {
  return createRenderSlots()
}

/** 宿主校验器的最小镜像：additionalProperties:false + required + 单值 type。 */
function schemaViolations(schema, value, at = 'value', found = []) {
  if (schema === null || typeof schema !== 'object') return found
  if (value === null) {
    found.push(at + ' 是 null（宿主校验器不支持可空类型）')
    return found
  }
  if (schema.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return found.concat(at + ' 不是对象')
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) found.push('缺必填字段 ' + at + '.' + key)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) found.push(at + '.' + key + ' 没在 schema 里声明')
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (value[key] !== undefined) schemaViolations(child, value[key], at + '.' + key, found)
    }
    return found
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return found.concat(at + ' 不是数组')
    return found
  }
  if (schema.type === 'string' && typeof value !== 'string') found.push(at + ' 不是字符串')
  if (schema.type === 'number' && typeof value !== 'number') found.push(at + ' 不是数字')
  if (schema.type === 'boolean' && typeof value !== 'boolean') found.push(at + ' 不是布尔')
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) found.push(at + ' 不在 enum 里')
  return found
}

/** 当前档案里的产物；档案还没建出来（渲染刚结束那一瞬）就是空数组。 */
function artifactsNow(workspace) {
  const archive = tryOpenArchive(workspace, { repairIndex: false })
  return archive === null ? [] : artifactsOf(archive.state)
}

test('teach_animation_render：still 产物带帧号，spawn 显式带参数且不传 --port，成功后写 lesson.artifact', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    const slots = makeSlots()
    fixture.write('out/LLM/ropim-dataflow-f7.png', 'fake-png')
    const render = registerRender(
      { jobs, subprocess: fakeSubprocess(children) },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: slots } }
    )
    const result = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 7, lessonId: 'l1' },
      { agent: AGENT, callId: 'call-1' }
    )
    assert.equal(result.jobId, 'job-1')
    assert.equal(result.mode, 'still')
    assert.equal(result.frame, 7)
    assert.equal(result.poster, false)
    assert.equal(result.output, 'out/LLM/ropim-dataflow-f7.png')
    assert.match(result.hint, /lesson\.artifact/)
    assert.match(result.command, /--frame 7/)
    assert.match(result.command, /--timeout 30000/)
    assert.match(result.command, /--overwrite/)
    assert.equal(result.command.includes('--port'), false)

    assert.equal(children.length, 1)
    const spawned = children[0].spec
    assert.equal(spawned.cwd, openProject(fixture.root).root)
    assert.match(spawned.argv[0], /node_modules\/\.bin\/remotion$/)
    assert.equal(spawned.argv[1], 'still')
    assert.deepEqual(spawned.argv.slice(2, 5), ['src/index.ts', 'RopimDataflow', 'out/LLM/ropim-dataflow-f7.png'])
    assert.equal(spawned.argv[spawned.argv.indexOf('--frame') + 1], '7')
    assert.equal(spawned.argv.includes('--port'), false)
    assert.equal(spawned.argv[spawned.argv.indexOf('--timeout') + 1], '30000')

    assert.deepEqual(await jobs.started[0].runResult.done, { status: 'completed' })
    const artifacts = await waitFor(() => {
      const archive = tryOpenArchive(workspace, { repairIndex: false })
      const list = archive === null ? [] : artifactsOf(archive.state)
      return list.length > 0 ? list : undefined
    })
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].lessonId, 'l1')
    assert.equal(artifacts[0].path, 'out/LLM/ropim-dataflow-f7.png')
    assert.equal(artifacts[0].frames, 1)
    assert.equal(artifacts[0].frame, 7)
    assert.match(jobs.started[0].text(), /产物已记入教学档案/)
    // 作业结算后互斥槽必须已经放掉
    await waitFor(() => (slots.size() === 0 ? true : undefined))
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：连抽两帧各写一条档案，互不覆盖', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const jobs = fakeJobs()
  try {
    const slots = makeSlots()
    fixture.write('out/LLM/ropim-dataflow-f10.png', 'fake-png-10')
    fixture.write('out/LLM/ropim-dataflow-f20.png', 'fake-png-20')
    const render = registerRender(
      { jobs, subprocess: fakeSubprocess([]) },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: slots } }
    )
    await render.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 10 }, { agent: AGENT })
    await jobs.started[0].runResult.done
    await waitFor(() => (slots.size() === 0 ? true : undefined))
    await render.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 20 }, { agent: AGENT })
    await jobs.started[1].runResult.done

    const artifacts = await waitFor(() => {
      const list = artifactsNow(workspace)
      return list.length === 2 ? list : undefined
    })
    assert.deepEqual(artifacts.map((item) => item.path).sort(), [
      'out/LLM/ropim-dataflow-f10.png',
      'out/LLM/ropim-dataflow-f20.png'
    ])
    assert.deepEqual(artifacts.map((item) => item.frame).sort((a, b) => a - b), [10, 20])
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：poster:true 不给帧就取清单末帧，产物是 -poster.png', async () => {
  const fixture = makeRenderProject({ durationInFrames: 90, fps: 30 })
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    fixture.write('out/LLM/ropim-dataflow-poster.png', 'fake-poster')
    const render = registerRender(
      { jobs, subprocess: fakeSubprocess(children) },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: makeSlots() } }
    )
    const result = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', poster: true },
      { agent: AGENT }
    )
    assert.equal(result.frame, 89) // 90 帧的最后一帧
    assert.equal(result.poster, true)
    assert.equal(result.output, 'out/LLM/ropim-dataflow-poster.png')
    assert.equal(children[0].spec.argv[children[0].spec.argv.indexOf('--frame') + 1], '89')
    await settle(children, jobs)
    const artifacts = await waitFor(() => {
      const list = artifactsNow(workspace)
      return list.length > 0 ? list : undefined
    })
    assert.equal(artifacts[0].path, 'out/LLM/ropim-dataflow-poster.png')
    assert.equal(artifacts[0].frame, 89)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：poster:true 显式给帧就用给的帧', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    const render = registerRender(
      { jobs, subprocess: fakeSubprocess(children) },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: makeSlots() } }
    )
    const result = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', poster: true, frame: 12 },
      { agent: AGENT }
    )
    assert.equal(result.frame, 12)
    assert.equal(result.output, 'out/LLM/ropim-dataflow-poster.png')
    assert.equal(children[0].spec.argv[children[0].spec.argv.indexOf('--frame') + 1], '12')
    await settle(children, jobs)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：poster 只允许 still；帧号越界与查不到时长都明确失败且不起作业', async () => {
  const fixture = makeRenderProject({ durationInFrames: 90 })
  const { workspace, cleanup } = makeWorkspace()
  const jobs = fakeJobs()
  const bareChildren = []
  try {
    const render = registerRender(
      { jobs, subprocess: fakeSubprocessManual([]) },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: makeSlots() } }
    )
    await assert.rejects(
      () => render.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render', poster: true }, { agent: AGENT }),
      (error) => error.code === 'poster-needs-still'
    )
    await assert.rejects(
      () => render.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 90 }, { agent: AGENT }),
      (error) => error.code === 'frame-out-of-range' && /0–89/.test(error.message)
    )
    await assert.rejects(
      () => render.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: -1 }, { agent: AGENT }),
      (error) => error.code === 'frame-out-of-range'
    )
    assert.equal(jobs.started.length, 0)

    // 没有受管清单：不带 frame 的 poster 说不清抽哪一帧，明确失败
    const bare = makeRenderProject({ durationInFrames: null })
    try {
      const bareRender = registerRender(
        { jobs, subprocess: fakeSubprocessManual(bareChildren) },
        { config: makeConfig(bare), workspace, deps: { renderSlots: makeSlots() } }
      )
      await assert.rejects(
        () => bareRender.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', poster: true }, { agent: AGENT }),
        (error) => error.code === 'unknown-duration' && /frame/.test(error.message)
      )
      // 但显式给帧仍然允许（清单只是校验来源，不是必需品）
      const ok = await bareRender.execute(
        { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', poster: true, frame: 5 },
        { agent: AGENT }
      )
      assert.equal(ok.output, 'out/LLM/ropim-dataflow-poster.png')
      await settle(bareChildren, jobs, 0)
    } finally {
      bare.cleanup()
    }
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：render 模式仍写 out/<类别>/<slug>.mp4，返回里不带 frame', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    fixture.write('out/LLM/ropim-dataflow.mp4', 'fake-mp4')
    const render = registerRender(
      { jobs, subprocess: fakeSubprocess(children) },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: makeSlots() } }
    )
    const result = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render', lessonId: 'l1' },
      { agent: AGENT, callId: 'call-r' }
    )
    assert.equal(result.output, 'out/LLM/ropim-dataflow.mp4')
    assert.equal(result.poster, false)
    assert.equal('frame' in result, false)
    assert.equal(children[0].spec.argv[1], 'render')
    assert.equal(children[0].spec.argv.includes('--frame'), false)
    await settle(children, jobs)
    const artifacts = await waitFor(() => {
      const list = artifactsNow(workspace)
      return list.length > 0 ? list : undefined
    })
    assert.equal(artifacts[0].frames, 90)
    assert.equal(artifacts[0].durationMs, 3000)
    assert.equal(artifacts[0].frame, null)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：--timeout 用 config.animation.frameTimeoutMs，不吃整段预算', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    const render = registerRender(
      { jobs, subprocess: fakeSubprocess(children) },
      { config: makeConfig(fixture, { frameTimeoutMs: 45000 }), workspace, deps: { renderSlots: makeSlots() } }
    )
    const result = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render', timeoutSeconds: 60 },
      { agent: AGENT }
    )
    const argv = children[0].spec.argv
    assert.equal(argv[argv.indexOf('--timeout') + 1], '45000')
    assert.match(result.command, /--timeout 45000/)
    assert.equal(result.jobId, 'job-1')
    await settle(children, jobs)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：同工程第二个作业被 render-busy 挡下，带正在跑的 jobId，不启新作业', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    const slots = makeSlots()
    const render = registerRender(
      { jobs, subprocess: fakeSubprocessManual(children) },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: slots } }
    )
    const first = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render' },
      { agent: AGENT }
    )
    assert.equal(first.jobId, 'job-1')
    assert.equal(children.length, 1)
    assert.equal(slots.size(), 1)

    await assert.rejects(
      () =>
        render.execute(
          { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 3 },
          { agent: AGENT }
        ),
      (error) => {
        assert.equal(error.code, 'render-busy')
        assert.match(error.message, /job-1/)
        assert.match(error.message, /job_output/)
        assert.match(error.message, /job_kill/)
        // 不能再建议「杀掉占用端口的进程」
        assert.match(error.message, /不要去杀端口/)
        assert.equal(/lsof|结束占用它的进程/.test(error.message), false)
        return true
      }
    )
    assert.equal(jobs.started.length, 1)
    assert.equal(children.length, 1)

    // 第一个作业跑完 → 槽释放 → 下一个能起
    await settle(children, jobs, 0)
    await waitFor(() => (slots.size() === 0 ? true : undefined))
    const second = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 3 },
      { agent: AGENT }
    )
    assert.equal(second.jobId, 'job-2')
    assert.equal(children.length, 2)
    await settle(children, jobs, 1)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：取消结算后也释放互斥槽', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    const slots = makeSlots()
    const render = registerRender(
      { jobs, subprocess: fakeSubprocessManual(children) },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: slots } }
    )
    await render.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render' }, { agent: AGENT })
    assert.equal(slots.size(), 1)
    jobs.started[0].runResult.cancel()
    assert.deepEqual(await jobs.started[0].runResult.done, { status: 'killed', detail: 'cancelled' })
    await waitFor(() => (slots.size() === 0 ? true : undefined))
    await render.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 1 }, { agent: AGENT })
    assert.equal(jobs.started.length, 2)
    await settle(children, jobs, 1)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：jobs.start 抛错时释放互斥槽，工程不会被锁死', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const jobs = fakeJobs({ failFirst: true })
  const children = []
  try {
    const slots = makeSlots()
    const render = registerRender(
      { jobs, subprocess: fakeSubprocessManual(children) },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: slots } }
    )
    await assert.rejects(
      () => render.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render' }, { agent: AGENT }),
      /registry unavailable/
    )
    assert.equal(slots.size(), 0)
    const ok = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 2 },
      { agent: AGENT }
    )
    // 第一次 jobs.start 抛错，所以这次成功的是第 2 个 job id
    assert.equal(ok.jobId, 'job-2')
    await settle(children, jobs, 0)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：找不到可执行文件时释放互斥槽', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  try {
    const slots = makeSlots()
    const subprocess = {
      async resolveExecutable() {
        throw new Error('ENOENT')
      },
      spawn() {
        throw new Error('不该被调用')
      }
    }
    const render = registerRender(
      { jobs: fakeJobs(), subprocess },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: slots } }
    )
    await assert.rejects(
      () => render.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render' }, { agent: AGENT }),
      (error) => error.code === 'deps-missing'
    )
    assert.equal(slots.size(), 0)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：互斥按工程根算，跨会话也挡得住', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    // 两个会话共用同一张槽位表（运行期是模块级的）
    const slots = makeSlots()
    const config = makeConfig(fixture)
    const sessionA = registerRender(
      { jobs, subprocess: fakeSubprocessManual(children) },
      { config, workspace, deps: { renderSlots: slots } }
    )
    const sessionB = registerRender(
      { jobs, subprocess: fakeSubprocessManual(children) },
      { config, workspace, deps: { renderSlots: slots } }
    )
    await sessionA.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render' },
      { agent: { session: { id: 'session-a' } } }
    )
    await assert.rejects(
      () =>
        sessionB.execute(
          { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 4 },
          { agent: { session: { id: 'session-b' } } }
        ),
      (error) => error.code === 'render-busy'
    )
    assert.equal(jobs.started.length, 1)
    await settle(children, jobs, 0)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：不注入槽位时走模块级表（同一工程第二次仍被挡）', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    const render = registerRender({ jobs, subprocess: fakeSubprocessManual(children) }, { config: makeConfig(fixture), workspace })
    const first = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render' },
      { agent: AGENT }
    )
    await assert.rejects(
      () => render.execute({ category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 1 }, { agent: AGENT }),
      (error) => error.code === 'render-busy'
    )
    assert.equal(first.jobId, 'job-1')
    // 收尾：让作业结算，把模块级槽位腾出来给同进程后面的测试
    await settle(children, jobs, 0)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_render：两种模式的返回值都满足自己声明的 output.schema', async () => {
  const fixture = makeRenderProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    const render = registerRender(
      { jobs, subprocess: fakeSubprocess(children) },
      { config: makeConfig(fixture), workspace, deps: { renderSlots: makeSlots() } }
    )
    const still = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 3, poster: true },
      { agent: AGENT }
    )
    assert.deepEqual(schemaViolations(render.output.schema, still), [])
    assert.equal(still.frame, 3)
    assert.equal(still.poster, true)
    await settle(children, jobs, 0)

    const video = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render' },
      { agent: AGENT }
    )
    assert.deepEqual(schemaViolations(render.output.schema, video), [])
    assert.equal('frame' in video, false)
    await settle(children, jobs, 1)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})
