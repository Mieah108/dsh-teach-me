import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  acquireAnimationLock,
  animationLockDir,
  createRenderSlots,
  registerAnimationTools
} from '../../lib/animation.js'
import { LockHeldError, ValidationError } from '../../lib/archive/errors.js'
import { publishLesson } from '../../lib/archive/operations.js'
import { animationJobsOf, applyChange, emptyState } from '../../lib/archive/state.js'
import { tryOpenArchive } from '../../lib/archive/store.js'
import { openProject } from '../../lib/sandbox.js'

/* D4 动画健壮性（upgrade-decision §4.4.4）：
 *   (a) 跨进程互斥 = 复用 archive 的 wx + pid 判活锁，键 = 工程根 realpath；
 *   (b) 作业持久化 = 事件 animation.job（running → 终态），重启后 inspect 能读出未完成作业；
 * 全部用临时工作区/临时工程 + 假 jobs/subprocess，绝不碰真实动画工程与真实课程。 */

/* ———————————————————————— 假件 ———————————————————————— */

function fakeStream() {
  const stream = new EventEmitter()
  stream.closed = false
  return stream
}

/** 手动结算的子进程假件：测试自己决定这一单什么时候完成/被杀。 */
function controlledChild() {
  const stdout = fakeStream()
  const stderr = fakeStream()
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })
  const child = {
    stdout,
    stderr,
    done,
    waitForExit: async () => true,
    terminate() {
      stdout.closed = true
      stderr.closed = true
      resolveDone({ exitCode: null, signal: 'SIGTERM' })
    }
  }
  return {
    child,
    finish(exit = { exitCode: 0, signal: null }) {
      stdout.closed = true
      stderr.closed = true
      resolveDone(exit)
    }
  }
}

function fakeJobs() {
  const started = []
  let calls = 0
  return {
    started,
    start(spec) {
      calls += 1
      const chunks = []
      const id = 'job-' + calls
      const handle = { id, append: (chunk) => chunks.push(String(chunk)), updateProgress: () => {} }
      const runResult = spec.run(handle)
      started.push({ spec, handle, runResult, text: () => chunks.join('') })
      return id
    }
  }
}

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

async function waitFor(check, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

const AGENT = { session: { id: 'session-1' }, id: 'agent-1' }

function makeProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-d4-project-'))
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
  const lessons = path.join(root, '.dsh-teach', 'managed', 'lessons', 'LLM')
  fs.mkdirSync(lessons, { recursive: true })
  fs.writeFileSync(
    path.join(lessons, 'ropim-dataflow.json'),
    JSON.stringify({
      category: 'LLM',
      slug: 'ropim-dataflow',
      composition: 'RopimDataflow',
      revision: 'r1',
      entry: { registrable: true, durationInFrames: 90, fps: 30 }
    })
  )
  return {
    root,
    realRoot: openProject(root).root,
    write(rel, body) {
      const absolute = path.join(root, rel)
      fs.mkdirSync(path.dirname(absolute), { recursive: true })
      fs.writeFileSync(absolute, body)
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true })
    }
  }
}

function makeWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-d4-workspace-'))
  return { workspace, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }) }
}

function makeConfig(fixture) {
  return {
    animation: { enabled: true, root: fixture.root, softLimitSeconds: 120, frameTimeoutMs: 30000 },
    tools: { animation: true }
  }
}

function fakeCtx({ workspace, jobs, subprocess }) {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          register: (tool) => {
            registered.push(tool)
            return () => {}
          }
        }
      }
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

/** 注册四个动画工具，返回指定名字的那一个（每次注册都是一份新的工具实例）。 */
function register(fixture, { workspace, jobs, subprocess, renderSlots = createRenderSlots() }, name) {
  const { ctx, registered } = fakeCtx({ workspace, jobs, subprocess })
  registerAnimationTools(ctx, () => makeConfig(fixture), () => workspace, { render: { renderSlots } })
  const tool = registered.find((item) => item.name === name)
  assert.ok(tool !== undefined, '没注册出 ' + name)
  return tool
}

/** 读日志里所有 animation.job 事件。 */
function journalJobEvents(workspace) {
  const dir = path.join(workspace, '.dsh-teach-me', 'archive', 'journal')
  if (!fs.existsSync(dir)) return []
  const events = []
  for (const file of fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      const entry = JSON.parse(line)
      for (const change of entry.changes ?? []) {
        if (change.type === 'animation.job') events.push({ entry, change })
      }
    }
  }
  return events
}

function jobsNow(workspace, root) {
  const archive = tryOpenArchive(workspace, { repairIndex: false })
  return archive === null ? [] : animationJobsOf(archive.state, { root })
}

/* ———————————————————————— 子进程小工具（真跨进程） ———————————————————————— */

const ANIMATION_MODULE_URL = new URL('../../lib/animation.js', import.meta.url).href

/** 写一个一次性脚本到临时目录（测试自己删）。 */
function writeScript(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-d4-script-'))
  const file = path.join(dir, 'run.mjs')
  fs.writeFileSync(file, body)
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** 起一个子进程，等它输出第一行 JSON（超时就杀掉并失败）。 */
function spawnJsonChild(script, args, { timeoutMs = 15000 } = {}) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('子进程超时没输出；stderr：' + stderr.join('')))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const index = buffer.indexOf('\n')
      if (index < 0) return
      clearTimeout(timer)
      let value
      try {
        value = JSON.parse(buffer.slice(0, index))
      } catch (error) {
        child.kill('SIGKILL')
        reject(error)
        return
      }
      resolve({ child, value, stderr })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('子进程提前退出（code ' + code + '）；stderr：' + stderr.join('')))
    })
  })
}

/* ———————————————————————— (b) 作业持久化 + 重启后 inspect ———————————————————————— */

test('animation.job：起手 running、结算终态，投影按 jobId 覆盖；重启后新进程能读出未完成作业', async () => {
  const fixture = makeProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    // 发布一节课，产物与作业事件都要绑到它的 revision
    fs.mkdirSync(path.join(workspace, 'lessons'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'lessons', 'one.html'), '<html><body>v1</body></html>')
    const published = publishLesson(workspace, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
    assert.equal(published.lessonRevision, 1)

    fixture.write('out/LLM/ropim-dataflow.mp4', 'fake-mp4-bytes')
    const render = register(fixture, { workspace, jobs, subprocess: fakeSubprocessManual(children) }, 'teach_animation_render')
    const started = await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render', lessonId: 'l1' },
      { agent: AGENT }
    )
    assert.equal(started.jobId, 'job-1')

    // 起手事件：投影里立刻是一条 running，带工程根 realpath / 产物 / 课程版本
    const running = jobsNow(workspace, fixture.realRoot)
    assert.equal(running.length, 1)
    assert.equal(running[0].jobId, 'job-1')
    assert.equal(running[0].state, 'running')
    assert.equal(running[0].mode, 'render')
    assert.equal(running[0].composition, 'RopimDataflow')
    assert.equal(running[0].output, 'out/LLM/ropim-dataflow.mp4')
    assert.equal(running[0].lessonRevision, 1)
    assert.equal(running[0].root, fixture.realRoot)
    assert.match(running[0].startedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(
      Object.keys(journalJobEvents(workspace)[0].change.data).sort(),
      ['at', 'composition', 'jobId', 'lessonRevision', 'mode', 'output', 'root', 'state']
    )

    // 重启后：一个全新的进程（新的模块实例、空的进程内表）只读档案就能报出这个未完成作业
    const script = writeScript(
      "import { inspectRenderJobs } from '" + ANIMATION_MODULE_URL + "'\n" +
        'const [workspace, root] = process.argv.slice(2)\n' +
        'process.stdout.write(JSON.stringify(inspectRenderJobs(workspace, root)) + "\\n")\n'
    )
    try {
      const restarted = await spawnJsonChild(script.file, [workspace, fixture.realRoot])
      assert.equal(restarted.value.total, 1)
      assert.equal(restarted.value.unfinished.length, 1)
      assert.equal(restarted.value.unfinished[0].jobId, 'job-1')
      assert.equal(restarted.value.unfinished[0].state, 'running')
      assert.equal(restarted.value.unfinished[0].lessonRevision, 1)
      assert.match(restarted.value.hint, /未收尾/)
    } finally {
      script.cleanup()
      // 子进程是「一次性读」脚本，读到第一行就退出；等它真的退出，别留僵尸
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    // 让作业成功结算：终态同 jobId 覆盖投影，产物归档且绑课程 revision
    children[0].fake.finish({ exitCode: 0, signal: null })
    await jobs.started[0].runResult.done
    const terminal = await waitFor(() => {
      const list = jobsNow(workspace, fixture.realRoot)
      return list.length === 1 && list[0].state === 'completed' ? list : undefined
    })
    assert.equal(terminal[0].state, 'completed')
    assert.equal(animationJobsOf(tryOpenArchive(workspace, { repairIndex: false }).state, { root: fixture.realRoot, unfinished: true }).length, 0)
    const artifact = await waitFor(() => {
      const archive = tryOpenArchive(workspace, { repairIndex: false })
      const artifacts = archive === null ? [] : Object.values(archive.state.artifacts ?? {})
      return artifacts.length === 1 ? artifacts[0] : undefined
    })
    assert.equal(artifact.path, 'out/LLM/ropim-dataflow.mp4')
    assert.equal(artifact.lessonRevision, 1)
    assert.match(jobs.started[0].text(), /产物已记入教学档案/)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('animation.job：取消后写 killed 终态，未完成列表清空；inspect 不吃终态作业', async () => {
  const fixture = makeProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  try {
    const render = register(fixture, { workspace, jobs, subprocess: fakeSubprocessManual(children) }, 'teach_animation_render')
    await render.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render' },
      { agent: AGENT }
    )
    assert.equal(jobsNow(workspace, fixture.realRoot)[0].state, 'running')
    jobs.started[0].runResult.cancel()
    assert.deepEqual(await jobs.started[0].runResult.done, { status: 'killed', detail: 'cancelled' })
    const terminal = await waitFor(() => {
      const list = jobsNow(workspace, fixture.realRoot)
      return list.length === 1 && list[0].state === 'killed' ? list : undefined
    })
    assert.equal(terminal[0].lessonRevision, null)

    const inspect = register(fixture, { workspace, jobs, subprocess: fakeSubprocessManual([]) }, 'teach_animation_inspect')
    const inspection = await inspect.execute({}, { agent: AGENT })
    assert.equal(inspection.state, 'not-integrated')
    assert.equal(inspection.jobs.total, 1)
    assert.deepEqual(inspection.jobs.unfinished, [])
    assert.equal(inspection.jobs.last.state, 'killed')
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

test('teach_animation_inspect：没有档案或没有作业时 jobs 汇总为空且不改档案', async () => {
  const fixture = makeProject()
  const { workspace, cleanup } = makeWorkspace()
  try {
    const inspect = register(fixture, { workspace, jobs: fakeJobs(), subprocess: fakeSubprocessManual([]) }, 'teach_animation_inspect')
    // 没有档案：jobs 字段不出现（只读诊断不能把档案目录建出来）
    const noArchive = await inspect.execute({}, { agent: AGENT })
    assert.equal('jobs' in noArchive, false)
    assert.equal(fs.existsSync(path.join(workspace, '.dsh-teach-me', 'archive')), false)

    // 有档案、没有作业：返回空汇总，且 inspect 不写档案
    fs.mkdirSync(path.join(workspace, 'lessons'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'lessons', 'one.html'), '<html><body>v1</body></html>')
    publishLesson(workspace, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
    const archive = tryOpenArchive(workspace, { repairIndex: false })
    const entriesBefore = readJournalLineCount(workspace)
    const withArchive = await inspect.execute({}, { agent: AGENT })
    assert.equal(withArchive.jobs.total, 0)
    assert.deepEqual(withArchive.jobs.unfinished, [])
    assert.equal(withArchive.jobs.last, null)
    // inspect 只读：档案版本与日志条数都没变
    assert.equal(tryOpenArchive(workspace, { repairIndex: false }).state.revision, archive.state.revision)
    assert.equal(readJournalLineCount(workspace), entriesBefore)
  } finally {
    fixture.cleanup()
    cleanup()
  }
})

function readJournalLineCount(workspace) {
  const dir = path.join(workspace, '.dsh-teach-me', 'archive', 'journal')
  if (!fs.existsSync(dir)) return 0
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
    .reduce((sum, name) => sum + fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter((line) => line.trim().length > 0).length, 0)
}

/* ———————————————————————— (a) 跨进程互斥 ———————————————————————— */

test('acquireAnimationLock：锁内记 jobId/pid/时间；第二个锁实例被拒；释放后可再取', () => {
  const fixture = makeProject()
  try {
    const root = fixture.realRoot
    const first = acquireAnimationLock(root, { info: { mode: 'render', composition: 'RopimDataflow', output: 'out/LLM/x.mp4', jobId: '' } })
    assert.equal(first.file, path.join(animationLockDir(root), 'render.lock'))
    assert.equal(first.info.pid, process.pid)
    assert.match(first.info.startedAt, /^\d{4}-\d{2}-\d{2}T/)
    // job id 在拿锁之后才生成：回填进锁文件，别的进程才说得出「谁在跑」
    assert.equal(first.update({ jobId: 'job-7' }), true)
    const onDisk = JSON.parse(fs.readFileSync(first.file, 'utf8'))
    assert.equal(onDisk.jobId, 'job-7')
    assert.equal(onDisk.pid, process.pid)
    assert.equal(onDisk.mode, 'render')
    assert.match(onDisk.startedAt, /^\d{4}-\d{2}-\d{2}T/)

    // 同进程第二个锁实例（模拟另一个进程的另一份模块）：wx 文件挡下，报错带持锁者
    assert.throws(
      () => acquireAnimationLock(root),
      (error) => {
        assert.ok(error instanceof LockHeldError)
        assert.equal(error.code, 'workspace-locked')
        assert.equal(error.detail.holder.pid, process.pid)
        assert.equal(error.detail.holder.jobId, 'job-7')
        assert.match(error.message, /动画工程正被另一个写入者占用/)
        assert.match(error.message, /pid \d+/)
        return true
      }
    )

    first.release()
    assert.equal(fs.existsSync(first.file), false)
    const again = acquireAnimationLock(root)
    again.release()
  } finally {
    fixture.cleanup()
  }
})

test('跨进程互斥：另一个进程持锁时渲染被拒（可读原因带 pid/jobId/时间），持锁进程死后按 pid 判活回收', async () => {
  const fixture = makeProject()
  const { workspace, cleanup } = makeWorkspace()
  const children = []
  const jobs = fakeJobs()
  let holder
  let script
  try {
    // 真子进程：拿同一把锁，打印 pid/锁文件，然后一直活着
    script = writeScript(
      "import { acquireAnimationLock } from '" + ANIMATION_MODULE_URL + "'\n" +
        "const [root, jobId] = process.argv.slice(2)\n" +
        "const lock = acquireAnimationLock(root, { info: { mode: 'render', composition: 'RopimDataflow', output: 'out/LLM/ropim-dataflow.mp4', jobId } })\n" +
        'process.stdout.write(JSON.stringify({ pid: process.pid, file: lock.file }) + "\\n")\n' +
        'setInterval(() => {}, 1000)\n'
    )
    holder = await spawnJsonChild(script.file, [fixture.realRoot, 'job-child'])
    assert.equal(holder.value.file, path.join(animationLockDir(fixture.realRoot), 'render.lock'))
    assert.equal(holder.value.pid, holder.child.pid)

    const slots = createRenderSlots()
    const renderWithSlots = register(
      fixture,
      { workspace, jobs, subprocess: fakeSubprocessManual(children), renderSlots: slots },
      'teach_animation_render'
    )
    await assert.rejects(
      () => renderWithSlots.execute(
        { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'render' },
        { agent: AGENT }
      ),
      (error) => {
        assert.equal(error.code, 'render-busy')
        // 可读原因：另一个进程 + pid + job id + 开始时间
        assert.match(error.message, /另一个进程渲染/)
        assert.match(error.message, new RegExp('pid ' + holder.child.pid))
        assert.match(error.message, /job id：job-child/)
        assert.match(error.message, /自 \d{4}-\d{2}-\d{2}T/)
        assert.match(error.message, /不要去杀端口/)
        return true
      }
    )
    // 没起作业，进程内槽位也没被占住（失败要还回去）
    assert.equal(jobs.started.length, 0)
    assert.equal(children.length, 0)
    assert.equal(slots.size(), 0)
    assert.equal(fs.existsSync(path.join(animationLockDir(fixture.realRoot), 'render.lock')), true)

    // 持锁进程死掉（SIGKILL，锁文件留下）→ 下次拿锁按 pid 判活回收，渲染能起来
    holder.child.kill('SIGKILL')
    await new Promise((resolve) => holder.child.once('exit', resolve))
    const ok = await renderWithSlots.execute(
      { category: 'LLM', slug: 'ropim-dataflow', composition: 'RopimDataflow', mode: 'still', frame: 3 },
      { agent: AGENT }
    )
    assert.equal(ok.jobId, 'job-1')
    assert.equal(children.length, 1)
    // 作业结算后锁文件被删掉，工程不会一直被锁死
    children[0].fake.finish({ exitCode: 0, signal: null })
    await jobs.started[0].runResult.done
    await waitFor(() => (fs.existsSync(path.join(animationLockDir(fixture.realRoot), 'render.lock')) ? undefined : true))
  } finally {
    try {
      holder?.child.kill('SIGKILL')
    } catch {
      // 已经退出
    }
    script?.cleanup()
    fixture.cleanup()
    cleanup()
  }
})

/* ———————————————————————— 事件校验（state.js） ———————————————————————— */

test('animation.job 事件：坏 mode/state/lessonRevision 明确失败，终态不能回到 running，jobId 不能跨工程', () => {
  const at = '2026-11-01T00:00:00.000Z'
  const base = {
    jobId: 'job-1',
    root: '/tmp/project',
    composition: 'RopimDataflow',
    mode: 'render',
    output: 'out/LLM/x.mp4',
    lessonRevision: null,
    state: 'running'
  }
  const apply = (state, data) => applyChange(state, { type: 'animation.job', data }, { at, actor: 'test', seq: 1 })

  const running = apply(emptyState(), base)
  assert.equal(animationJobsOf(running).length, 1)
  assert.equal(running.animationJobs['job-1'].state, 'running')
  assert.equal(running.animationJobs['job-1'].startedAt, at)

  // 终态用同一个 jobId 覆盖，startedAt 保留、updatedAt 前进
  const done = apply(running, { ...base, state: 'completed', at: '2026-11-01T00:05:00.000Z' })
  assert.equal(done.animationJobs['job-1'].state, 'completed')
  assert.equal(done.animationJobs['job-1'].startedAt, at)
  assert.equal(done.animationJobs['job-1'].updatedAt, '2026-11-01T00:05:00.000Z')
  assert.equal(animationJobsOf(done, { unfinished: true }).length, 0)

  assert.throws(() => apply(emptyState(), { ...base, mode: 'video' }), ValidationError)
  assert.throws(() => apply(emptyState(), { ...base, state: 'pending' }), ValidationError)
  assert.throws(() => apply(emptyState(), { ...base, lessonRevision: 0 }), ValidationError)
  assert.throws(() => apply(emptyState(), { ...base, jobId: 'bad id' }), ValidationError)
  assert.throws(() => apply(emptyState(), { ...base, output: '' }), ValidationError)
  // 终态不能改回 running：事件只追加，不能靠后来一条改写历史
  assert.throws(() => apply(done, { ...base, state: 'running' }), ValidationError)
  // 同一个 job id 不能记到另一个工程
  assert.throws(() => apply(running, { ...base, root: '/tmp/other-project' }), ValidationError)
})
