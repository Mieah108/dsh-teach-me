import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishLesson, registerQuestion } from '../../lib/archive/operations.js'
import { registerClassroom } from '../../lib/classroom/service.js'
import { callRpc } from '../helpers/classroom-rpc.js'

/* 课堂 RPC 的课程清单（classroom/catalog）与按 lessonId 打开。
 * 侧栏的选课列表完全靠它，所以它的形状要钉住：没有档案时给空态而不是报错，
 * 有档案时带上 revision / 题目数 / 挂点差异 / 是否具备自动打开能力。 */

const SID = 'session-1'

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-catalog-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), '<!DOCTYPE html><html><body>课</body></html>')
  return ws
}

function mount(root, { sidebarOpen = true, sessionCwd = root } = {}) {
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'sessions') return { get: (id) => (id === SID ? { header: { cwd: sessionCwd } } : undefined) }
      if (name === 'tools') return { get: (toolName) => (toolName === 'sidebar_open' ? (sidebarOpen ? { name: 'sidebar_open' } : undefined) : undefined) }
      return undefined
    },
    effect: (factory) => factory(),
    logger: { info() {}, warn() {} }
  }
  const registered = registerClassroom(ctx, { getConfig: () => ({}) })
  assert.equal(registered.enabled, true)
  const route = routes[0]
  const call = async (endpoint, payload) => (await callRpc(route, endpoint, payload)).result
  return { route, routes, call }
}

test('没有档案时返回空态，而不是报错', async () => {
  const root = workspace()
  const { call } = mount(root)
  const result = await call('classroom/catalog', { sessionId: SID })
  assert.equal(result.ok, true)
  assert.equal(result.value.initialized, false)
  assert.deepEqual(result.value.lessons, [])
  assert.equal(result.value.openable, true)
})

test('有档案时列出课程、题目数与挂点差异，并汇报 sidebar_open 是否可用', async () => {
  const root = workspace()
  publishLesson(root, { path: 'lessons/one.html', lessonId: 'lesson-1', title: '第一课' })
  registerQuestion(root, { questionId: 'q-1', lessonId: 'lesson-1', type: 'choice', prompt: '题', answer: 'A' })

  const withSidebar = await mount(root).call('classroom/catalog', { sessionId: SID })
  assert.equal(withSidebar.ok, true)
  assert.equal(withSidebar.value.initialized, true)
  assert.equal(withSidebar.value.openable, true)
  const lesson = withSidebar.value.lessons[0]
  assert.equal(lesson.id, 'lesson-1')
  assert.equal(lesson.title, '第一课')
  assert.equal(lesson.revision, 1)
  assert.equal(lesson.questionCount, 1)
  assert.deepEqual(lesson.pageQuestionIds, [])
  assert.deepEqual(lesson.unmappedQuestionIds, ['q-1'])

  // 没装 better-sidebar 时 openable=false：自动打开要退化成"不弹"。
  const withoutSidebar = await mount(root, { sidebarOpen: false }).call('classroom/catalog', { sessionId: SID })
  assert.equal(withoutSidebar.value.openable, false)
})

test('按 lessonId 打开课程：拿得到能力票 URL；未知 id 明确失败', async () => {
  const root = workspace()
  publishLesson(root, { path: 'lessons/one.html', lessonId: 'lesson-1', title: '第一课' })
  const { call } = mount(root)

  const opened = await call('classroom/open', { sessionId: SID, lessonId: 'lesson-1' })
  assert.equal(opened.ok, true)
  assert.match(opened.value.url, /^\/teach-classroom\//)
  assert.equal(opened.value.title, '第一课')
  assert.equal(opened.value.revision, 1)

  const missing = await call('classroom/open', { sessionId: SID, lessonId: 'nope' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'lesson-not-found')
})

test('课程页可从 URL 取回（能力票 + 相对路径），并注入课堂桥', async () => {
  const root = workspace()
  publishLesson(root, { path: 'lessons/one.html', lessonId: 'lesson-1', title: '第一课' })
  const { call, routes } = mount(root)
  const opened = await call('classroom/open', { sessionId: SID, lessonId: 'lesson-1' })
  const route = routes[0]
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader(key, value) { this.headers[key] = value },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}) },
    end(body) { if (body !== undefined) this.chunks.push(String(body)); this.body = this.chunks.join('') }
  }
  await route.handler({ method: 'GET', url: opened.value.url, headers: { host: '127.0.0.1' } }, res)
  assert.equal(res.statusCode, 200)
  assert.match(String(res.headers['Content-Type'] ?? ''), /text\/html/)
  assert.match(res.body, /teach-classroom-bridge/)
})

test('绑定教学根后，课堂读的是同一个根（否则工具写新根、课堂读旧根）', async () => {
  const sessionRoot = workspace()
  const teachingRoot = path.join(sessionRoot, 'teach-test')
  fs.mkdirSync(path.join(teachingRoot, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(teachingRoot, 'lessons', 'one.html'), '<!DOCTYPE html><html><body>课</body></html>')
  publishLesson(teachingRoot, { path: 'lessons/one.html', lessonId: 'lesson-1', title: '第一课' })
  // 学习者说「把 teach-test 当工作区」：绑定文件落在会话根，教学根指向子目录。
  fs.mkdirSync(path.join(sessionRoot, '.dsh-teach-me'), { recursive: true })
  fs.writeFileSync(path.join(sessionRoot, '.dsh-teach-me', 'teaching-root.json'), JSON.stringify({ root: teachingRoot }))

  const bound = mount(sessionRoot)
  const catalog = await bound.call('classroom/catalog', { sessionId: SID })
  assert.equal(catalog.ok, true)
  assert.equal(catalog.value.initialized, true, '课堂应当读到教学根下的 .dsh-teach-me')
  assert.equal(fs.realpathSync.native(catalog.value.root), fs.realpathSync.native(teachingRoot))
  assert.equal(catalog.value.lessons[0].id, 'lesson-1')

  const opened = await bound.call('classroom/open', { sessionId: SID, lessonId: 'lesson-1' })
  assert.equal(opened.ok, true)
  assert.equal(opened.ok && opened.value.title, '第一课')

  // 反向对照：解绑后会话根下没有 .dsh-teach-me，课堂应当给空态而不是报错。
  fs.rmSync(path.join(sessionRoot, '.dsh-teach-me', 'teaching-root.json'), { force: true })
  const plain = await mount(sessionRoot).call('classroom/catalog', { sessionId: SID })
  assert.equal(plain.ok, true)
  assert.equal(plain.value.initialized, false)
})
