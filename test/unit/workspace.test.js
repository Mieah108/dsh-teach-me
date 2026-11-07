import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceError, resolveWorkspace, tryResolveWorkspace } from '../../lib/workspace.js'

function ctxWith(services) {
  return { get: (name) => services[name] }
}

test('resolveWorkspace 用执行时 agent 的会话目录', () => {
  const session = { id: 's1' }
  const ctx = ctxWith({ workingDirectory: { get: (value) => (value === session ? '/work/learn' : undefined), defaultDirectory: '/elsewhere' } })
  assert.equal(resolveWorkspace(ctx, { session }), '/work/learn')
})

test('resolveWorkspace 从 agents.get 取会话', () => {
  const session = { id: 's2' }
  const ctx = ctxWith({
    workingDirectory: { get: () => '/work/two' },
    agents: { get: (id) => (id === 'a1' ? { session } : undefined) }
  })
  assert.equal(resolveWorkspace(ctx, { id: 'a1' }), '/work/two')
})

test('没有目录服务时明确失败', () => {
  assert.throws(() => resolveWorkspace(ctxWith({}), { session: {} }), WorkspaceError)
})

test('会话未就绪时明确失败，不退到 defaultDirectory', () => {
  const ctx = ctxWith({ workingDirectory: { defaultDirectory: '/fallback', get: () => '/never' } })
  assert.throws(() => resolveWorkspace(ctx, {}), /工作区/)
})

test('目录为空时明确失败', () => {
  const ctx = ctxWith({ workingDirectory: { get: () => '' } })
  assert.throws(() => resolveWorkspace(ctx, { session: {} }), WorkspaceError)
})

test('目录服务抛错时转成 WorkspaceError', () => {
  const ctx = ctxWith({
    workingDirectory: {
      get: () => {
        throw new Error('no session cwd')
      }
    }
  })
  assert.throws(() => resolveWorkspace(ctx, { session: {} }), /no session cwd/)
})

test('tryResolveWorkspace 失败时返回 undefined', () => {
  assert.equal(tryResolveWorkspace(ctxWith({}), {}), undefined)
})
