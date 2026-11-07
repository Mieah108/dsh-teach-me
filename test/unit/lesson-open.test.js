import { withLearningScope } from '../../lib/archive/learning-scope.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishLesson } from '../../lib/archive/operations.js'
import { registerLessonOpenTool } from '../../lib/lesson-open.js'

const AGENT = { session: { id: 'session-1' }, id: 'agent-1' }

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-open-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), '<html>课</html>')
  publishLesson(ws, { path: 'lessons/one.html', lessonId: 'lesson-1', title: '第一课' })
  return ws
}

function mount(ws, { sidebar = true, permission, preferences } = {}) {
  const registered = []
  const lookups = []
  const tools = {
    register: (tool) => {
      registered.push(tool)
      return () => {}
    },
    get(name, agent, toolSet) {
      lookups.push({ name, agent, toolSet })
      return sidebar && name === 'sidebar_open' ? { name } : undefined
    },
    execute: () => assert.fail('由模型发起原生调用，插件不代发')
  }
  const ctx = {
    get(name) {
      if (name === 'tools') return tools
      if (name === 'teachPreferences') return preferences
      if (name === 'permissionPresets') return permission === undefined ? undefined : { current: () => permission }
      return undefined
    },
    effect: (factory) => factory()
  }
  registerLessonOpenTool(ctx, { tools: { archive: true } }, () => ws)
  const tool = registered.find((entry) => entry.name === 'teach_lesson_open')
  const exec = { agent: AGENT, toolSet: {} }
  return { tool, lookups, exec }
}

test('会话可见 sidebar_open：给模型原生调用计划，并据实返回未打开', async () => {
  const ws = workspace()
  const { tool, lookups, exec } = mount(ws)
  const value = await tool.execute({}, exec)
  assert.equal(value.ok, true)
  assert.equal(value.opened, false)
  assert.equal(value.via, 'plan')
  assert.equal(value.reason, 'sidebar-open-ready')
  assert.equal(value.lessonId, 'lesson-1')
  assert.deepEqual(lookups, [{ name: 'sidebar_open', agent: AGENT, toolSet: exec.toolSet }])
  assert.deepEqual(value.plan, { name: 'sidebar_open', target: path.join(ws, 'lessons', 'one.html'), title: '第一课' })
  assert.match(value.text, /直接调用原生 sidebar_open/)
  assert.doesNotMatch(value.text, /run_code/)
})

test('没装：不弹、不报错、给出去处', async () => {
  const ws = workspace()
  const { tool, exec } = mount(ws, { sidebar: false })
  const value = await tool.execute({}, exec)
  assert.equal(value.ok, true)
  assert.equal(value.opened, false)
  assert.equal(value.via, 'none')
  assert.equal(value.reason, 'sidebar-open-unavailable')
  assert.match(value.text, /教学模式 · 选课/)
})

test('auto 权限预设：不伪造派发，直接给可执行计划', async () => {
  const ws = workspace()
  const { tool, exec } = mount(ws, { permission: 'auto' })
  const value = await tool.execute({}, exec)
  assert.equal(value.ok, true)
  assert.equal(value.opened, false)
  assert.equal(value.via, 'plan')
  assert.equal(value.reason, 'auto-review')
  assert.deepEqual(value.plan, {
    name: 'sidebar_open',
    target: path.join(ws, 'lessons', 'one.html'),
    title: '第一课'
  })
  assert.match(value.text, /直接调用原生 sidebar_open/)
  assert.match(value.text, /教学模式 · 选课/)
  assert.equal(value.lessonId, 'lesson-1')
})

test('auto 但宿主没有 sidebar_open：仍按「缺工具」处理，不给空计划', async () => {
  const ws = workspace()
  const { tool, exec } = mount(ws, { permission: 'auto', sidebar: false })
  const value = await tool.execute({}, exec)
  assert.equal(value.opened, false)
  assert.equal(value.via, 'none')
  assert.equal(value.reason, 'sidebar-open-unavailable')
  assert.equal(value.plan, undefined)
})

test('课程不存在或档案缺失：明确失败，不猜', async () => {
  const ws = workspace()
  const { tool, exec } = mount(ws)
  const missing = await tool.execute({ lessonId: 'nope' }, exec)
  assert.equal(missing.ok, false)
  assert.equal(missing.error, 'lesson-not-found')

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-open-empty-'))
  const noArchive = mount(empty)
  const value = await noArchive.tool.execute({}, noArchive.exec)
  assert.equal(value.ok, false)
  assert.equal(value.error, 'archive-missing')
})

test('省略 lessonId 时打开最近发布的一课', async () => {
  const ws = workspace()
  publishLesson(ws, { path: 'lessons/one.html', lessonId: 'lesson-1', title: '第一课' })
  fs.writeFileSync(path.join(ws, 'lessons', 'two.html'), '<html>第二课</html>')
  publishLesson(ws, { path: 'lessons/two.html', lessonId: 'lesson-2', title: '第二课' })
  const { tool, exec } = mount(ws)
  const value = await tool.execute({}, exec)
  assert.equal(value.lessonId, 'lesson-2')
})

test('请求开始后切换集合，不通过通用文件路径误开另一集合', async (t) => {
  const ws = workspace()
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
  const { tool, exec } = mount(ws, { preferences: { ensure: async () => ({ collections: { [fs.realpathSync(ws)]: 'second' } }) } })
  const value = await withLearningScope({ collectionId: 'default' }, () => tool.execute({}, exec))
  assert.equal(value.opened, false)
  assert.equal(value.reason, 'collection-changed')
  assert.equal(value.plan, undefined)
})
