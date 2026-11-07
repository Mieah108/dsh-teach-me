import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveTeachingRoot, resolveWorkspace, teachingRootSource } from '../../lib/workspace.js'
import { registerWorkspaceTool } from '../../lib/workspace-tool.js'

/* 教学根：默认是会话工作区；学习者指定子目录时能绑过去；设置里的 teachingRoot 优先级最高。
 * 这条链是 2026-10 真实会话里"一个会话三个根"的对策，必须能一眼看出当前根在哪、为什么。 */

const AGENT = { session: { id: 'session-1' }, id: 'agent-1' }

function sessionRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-root-'))
  fs.mkdirSync(path.join(dir, 'teach-test', 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'teach-test', 'lessons', 'one.html'), '<html>课</html>')
  return dir
}

function mount(cwd, { teachingRoot = '' } = {}) {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (tool) => { registered.push(tool); return () => {} } }
      if (name === 'workingDirectory') return { get: () => cwd }
      return undefined
    },
    effect: (factory) => {
      factory()
      return () => {}
    }
  }
  const getConfig = () => ({ workspace: { teachingRoot }, tools: { archive: true } })
  const workspaceOf = (agent) => resolveWorkspace(ctx, agent, { teachingRoot })
  registerWorkspaceTool(ctx, { tools: { archive: true } }, workspaceOf, getConfig)
  const tool = registered.find((entry) => entry.name === 'teach_workspace')
  return { tool, ctx, getConfig }
}

test('默认：教学根 = 会话工作区，状态里说明来源', async () => {
  const cwd = sessionRoot()
  const { tool } = mount(cwd)
  const value = await tool.execute({ action: 'status' }, { agent: AGENT })
  assert.equal(value.ok, true)
  assert.equal(value.root, cwd)
  assert.equal(value.source, 'session')
  assert.equal(value.archive, 'missing')
  assert.match(value.text, /会话工作区/)
})

test('bind 到子目录后，教学根与后面的解析都跟着走', async () => {
  const cwd = sessionRoot()
  const { tool, ctx, getConfig } = mount(cwd)
  const bound = await tool.execute({ action: 'bind', path: 'teach-test' }, { agent: AGENT })
  assert.equal(bound.ok, true)
  assert.equal(bound.root, path.join(cwd, 'teach-test'))
  assert.equal(bound.source, 'binding')
  assert.equal(resolveWorkspace(ctx, AGENT, { teachingRoot: getConfig().workspace.teachingRoot }), path.join(cwd, 'teach-test'))
  assert.equal(teachingRootSource(cwd), 'binding')

  const status = await tool.execute({ action: 'status' }, { agent: AGENT })
  assert.equal(status.root, path.join(cwd, 'teach-test'))
  assert.match(status.text, /绑定/)

  const cleared = await tool.execute({ action: 'unbind' }, { agent: AGENT })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.root, cwd)
  assert.equal(teachingRootSource(cwd), 'session')
})

test('bind 失败要说清楚：目录不存在 / 不是目录 / 设置优先', async () => {
  const cwd = sessionRoot()
  const { tool } = mount(cwd)
  const missing = await tool.execute({ action: 'bind', path: 'nope' }, { agent: AGENT })
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'path-missing')

  const notDir = await tool.execute({ action: 'bind', path: 'teach-test/lessons/one.html' }, { agent: AGENT })
  assert.equal(notDir.ok, false)
  assert.equal(notDir.error, 'path-not-directory')

  const pinned = mount(cwd, { teachingRoot: 'teach-test' }).tool
  const refused = await pinned.execute({ action: 'bind', path: 'teach-test' }, { agent: AGENT })
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'config-wins')
  assert.match(refused.text, /teachingRoot/)

  const empty = await tool.execute({ action: 'bind' }, { agent: AGENT })
  assert.equal(empty.ok, false)
  assert.equal(empty.error, 'path-required')
})

test('配置的教学根优先于绑定，且指向不存在的目录时明确失败', async () => {
  const cwd = sessionRoot()
  const { tool } = mount(cwd, { teachingRoot: 'teach-test' })
  const status = await tool.execute({ action: 'status' }, { agent: AGENT })
  assert.equal(status.root, path.join(cwd, 'teach-test'))
  assert.equal(status.source, 'config')

  assert.throws(
    () => resolveTeachingRoot(cwd, { teachingRoot: 'missing-dir' }),
    /配置的教学根不存在/
  )
})

test('旧版 workspace.json 绑定也能解除；新旧指针并存时不会回退到旧绑定', async () => {
  const cwd = sessionRoot()
  const hidden = path.join(cwd, '.dsh-teach-me')
  fs.mkdirSync(hidden)
  fs.writeFileSync(path.join(hidden, 'workspace.json'), JSON.stringify({ root: 'teach-test' }))
  const { tool } = mount(cwd)
  assert.equal((await tool.execute({ action: 'unbind' }, { agent: AGENT })).root, cwd)
  fs.writeFileSync(path.join(hidden, 'workspace.json'), JSON.stringify({ root: 'teach-test' }))
  await tool.execute({ action: 'bind', path: 'teach-test' }, { agent: AGENT })
  assert.equal((await tool.execute({ action: 'unbind' }, { agent: AGENT })).root, cwd)
})

test('绑定目录丢失后停止解析，仍可重新绑定或解除', async () => {
  const cwd = sessionRoot()
  const { tool } = mount(cwd)
  await tool.execute({ action: 'bind', path: 'teach-test' }, { agent: AGENT })
  fs.renameSync(path.join(cwd, 'teach-test'), path.join(cwd, 'moved'))
  assert.throws(() => resolveTeachingRoot(cwd), /绑定的教学根不存在/)
  assert.equal((await tool.execute({ action: 'status' }, { agent: AGENT })).ok, false)
  assert.equal((await tool.execute({ action: 'bind', path: 'moved' }, { agent: AGENT })).ok, true)
  fs.renameSync(path.join(cwd, 'moved'), path.join(cwd, 'teach-test'))
  assert.equal((await tool.execute({ action: 'unbind' }, { agent: AGENT })).ok, true)
})

test('绑定和解除均拒绝隐藏目录符号链接，不改外部指针', async () => {
  const cwd = sessionRoot()
  const outside = sessionRoot()
  const file = path.join(outside, 'teaching-root.json')
  fs.writeFileSync(file, JSON.stringify({ root: cwd }))
  fs.symlinkSync(outside, path.join(cwd, '.dsh-teach-me'))
  const { tool } = mount(cwd)
  assert.equal((await tool.execute({ action: 'bind', path: 'teach-test' }, { agent: AGENT })).ok, false)
  assert.equal((await tool.execute({ action: 'unbind' }, { agent: AGENT })).ok, false)
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { root: cwd })
})

test('坏绑定文件不能静默回退，bind/unbind 仍可恢复', async () => {
  const cwd = sessionRoot()
  const hidden = path.join(cwd, '.dsh-teach-me')
  fs.mkdirSync(hidden)
  const file = path.join(hidden, 'teaching-root.json')
  fs.writeFileSync(file, '{broken')
  const { tool } = mount(cwd)
  assert.throws(() => resolveTeachingRoot(cwd), /绑定/)
  assert.equal((await tool.execute({ action: 'status' }, { agent: AGENT })).ok, false)
  assert.equal((await tool.execute({ action: 'bind', path: 'teach-test' }, { agent: AGENT })).ok, true)
  fs.writeFileSync(file, '{broken')
  assert.equal((await tool.execute({ action: 'unbind' }, { agent: AGENT })).ok, true)
})
