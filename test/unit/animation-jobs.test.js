import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { startRenderHooks } from '../../lib/animation.js'

function fakeStream() {
  const stream = new EventEmitter()
  stream.closed = false
  return stream
}

function fakeChild({ exit = { exitCode: 0, signal: null }, waitForExit = async () => true } = {}) {
  const stdout = fakeStream()
  const stderr = fakeStream()
  let resolveDone
  let rejectDone
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  let terminated = false
  const child = {
    stdout,
    stderr,
    done,
    terminate() {
      terminated = true
      // 真实 provider 的 terminate 会推动进程范围退出，done 随之结算，管道关闭
      stdout.closed = true
      stderr.closed = true
      resolveDone(exit)
    },
    waitForExit
  }
  return {
    child,
    terminated: () => terminated,
    finish() {
      resolveDone(exit)
      stdout.closed = true
      stderr.closed = true
    },
    fail(error) {
      rejectDone(error)
    }
  }
}

function fakeHandle() {
  const text = []
  return {
    handle: { append: (chunk) => text.push(String(chunk)) },
    text: () => text.join('')
  }
}

const baseOptions = {
  command: 'remotion still src/index.ts Comp out/Cat/x.png',
  timeoutMs: 5000
}

test('exit 0 结算为 completed', async () => {
  const fake = fakeChild()
  const sink = fakeHandle()
  const hooks = startRenderHooks({
    ...baseOptions,
    subprocess: { spawn: () => fake.child },
    jobHandle: sink.handle
  })
  fake.finish()
  assert.deepEqual(await hooks.done, { status: 'completed' })
  assert.match(sink.text(), /\$ remotion/)
})

test('非零退出结算为 failed 并带退出码', async () => {
  const fake = fakeChild({ exit: { exitCode: 3, signal: null } })
  const hooks = startRenderHooks({
    ...baseOptions,
    subprocess: { spawn: () => fake.child },
    jobHandle: fakeHandle().handle
  })
  fake.finish()
  assert.deepEqual(await hooks.done, { status: 'failed', detail: 'exit code: 3' })
})

test('超时 terminate 后结算为 failed', async () => {
  const fake = fakeChild({ exit: { exitCode: null, signal: 'SIGTERM' } })
  const hooks = startRenderHooks({
    ...baseOptions,
    timeoutMs: 20,
    subprocess: { spawn: () => fake.child },
    jobHandle: fakeHandle().handle
  })
  const result = await hooks.done
  assert.equal(result.status, 'failed')
  assert.match(result.detail, /timeout/)
  assert.equal(fake.terminated(), true)
})

test('cancel 结算为 killed', async () => {
  const fake = fakeChild({ exit: { exitCode: null, signal: 'SIGTERM' } })
  const hooks = startRenderHooks({
    ...baseOptions,
    subprocess: { spawn: () => fake.child },
    jobHandle: fakeHandle().handle
  })
  hooks.cancel()
  assert.deepEqual(await hooks.done, { status: 'killed', detail: 'cancelled' })
  assert.equal(fake.terminated(), true)
})

test('spawn 同步抛错时 done 结算 failed，不 reject', async () => {
  const hooks = startRenderHooks({
    ...baseOptions,
    subprocess: {
      spawn: () => {
        throw new Error('exec format error')
      }
    },
    jobHandle: fakeHandle().handle
  })
  assert.deepEqual(await hooks.done, { status: 'failed', detail: 'startup failed' })
})

test('子进程 done 拒绝时也结算 failed，不 reject', async () => {
  const fake = fakeChild()
  const hooks = startRenderHooks({
    ...baseOptions,
    subprocess: { spawn: () => fake.child },
    jobHandle: fakeHandle().handle
  })
  fake.fail(new Error('provider failed'))
  assert.deepEqual(await hooks.done, { status: 'failed', detail: 'startup failed' })
})

test('done 永不 reject', async () => {
  const fake = fakeChild()
  const hooks = startRenderHooks({
    ...baseOptions,
    timeoutMs: 10,
    subprocess: { spawn: () => fake.child },
    jobHandle: fakeHandle().handle
  })
  fake.finish()
  await hooks.done
  assert.equal(typeof hooks.cancel, 'function')
})

test('waitForExit 观察不到进程范围时仍按退出码结算，并记诊断', async () => {
  const fake = fakeChild({
    waitForExit: async () => {
      throw new Error('pid scope unavailable')
    }
  })
  const sink = fakeHandle()
  const hooks = startRenderHooks({
    ...baseOptions,
    subprocess: { spawn: () => fake.child },
    jobHandle: sink.handle
  })
  fake.finish()
  assert.deepEqual(await hooks.done, { status: 'completed' })
  assert.match(sink.text(), /进程范围退出确认失败/)
})

test('spawn 抛错后 cancel 不抛异常（child 没建立）', async () => {
  const hooks = startRenderHooks({
    ...baseOptions,
    subprocess: {
      spawn: () => {
        throw new Error('boom')
      }
    },
    jobHandle: fakeHandle().handle
  })
  assert.deepEqual(await hooks.done, { status: 'failed', detail: 'startup failed' })
  hooks.cancel()
  hooks.cancel()
  assert.deepEqual(await hooks.done, { status: 'failed', detail: 'startup failed' })
})

test('重复 cancel 只终止一次，终态仍是 killed', async () => {
  const fake = fakeChild({ exit: { exitCode: null, signal: 'SIGTERM' } })
  let terminations = 0
  const child = {
    ...fake.child,
    terminate() {
      terminations += 1
      fake.child.terminate()
    }
  }
  const sink = fakeHandle()
  const hooks = startRenderHooks({
    ...baseOptions,
    subprocess: { spawn: () => child },
    jobHandle: sink.handle
  })
  hooks.cancel()
  hooks.cancel()
  assert.deepEqual(await hooks.done, { status: 'killed', detail: 'cancelled' })
  assert.equal(terminations, 1)
  assert.match(sink.text(), /收到取消请求/)
})

test('首次启动抛错后的重试等待仍受整体 timeout 约束', async () => {
  let count = 0
  const hooks = startRenderHooks({ ...baseOptions, timeoutMs: 20, retries: 1, retryDelayMs: 100, subprocess: { spawn: () => { count += 1; throw new Error('spawn') } }, jobHandle: fakeHandle().handle })
  const result = await hooks.done
  assert.match(result.detail, /timeout/)
  assert.equal(count, 1)
})

test('超时后 provider 不结算 done，也会给出退出未确认的失败终态', async () => {
  const hooks = startRenderHooks({ ...baseOptions, timeoutMs: 15, cleanupTimeoutMs: 20, subprocess: { spawn: () => ({ done: new Promise(() => {}), terminate() {} }) }, jobHandle: fakeHandle().handle })
  const result = await Promise.race([hooks.done, new Promise((_, reject) => setTimeout(() => reject(new Error('job stuck')), 150))])
  assert.equal(result.status, 'failed')
  assert.match(result.detail, /unconfirmed/)
})

test('provider 返回畸形退出结果或日志句柄抛错时，不产生未处理拒绝', async () => {
  const hooks = startRenderHooks({ ...baseOptions, cleanupTimeoutMs: 20, subprocess: { spawn: () => ({ done: Promise.resolve(null), terminate() {}, waitForExit: async () => true }) }, jobHandle: { append() { throw new Error('disposed') } } })
  const result = await hooks.done
  assert.equal(result.status, 'failed')
})

test('已完成作业再取消，不终止已完成子进程', async () => {
  const fake = fakeChild()
  const hooks = startRenderHooks({ ...baseOptions, subprocess: { spawn: () => fake.child }, jobHandle: fakeHandle().handle })
  fake.finish()
  await hooks.done
  hooks.cancel()
  assert.equal(fake.terminated(), false)
})

test('provider done 拒绝时先终止旧进程，不盲目重试', async () => {
  const fake = fakeChild()
  let spawns = 0
  const hooks = startRenderHooks({ ...baseOptions, retries: 1, retryDelayMs: 0, subprocess: { spawn: () => { spawns += 1; return fake.child } }, jobHandle: fakeHandle().handle })
  fake.fail(new Error('lost provider'))
  assert.equal((await hooks.done).status, 'failed')
  assert.equal(fake.terminated(), true)
  assert.equal(spawns, 1)
})
