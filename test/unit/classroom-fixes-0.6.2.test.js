import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { parseHTML } from 'linkedom'
import { publishLesson, readArchiveState, registerQuestion, voidAssessment } from '../../lib/archive/operations.js'
import { buildOffline, progressOf } from '../../lib/classroom/offline.js'
import { registerClassroom } from '../../lib/classroom/service.js'
import { callRpc } from '../helpers/classroom-rpc.js'

/* 0.6.2 课堂侧的四条闭环：
 *   #2 最近结论按评估 createdAt 取（作废后回退更早结论）；
 *   #3 失效成绩不再报 passed（verdictViewOf 口径）；
 *   #9 开放题提交后有 pending / classroom/pending 接续；
 *   #10 离线记录、下载、导入（含 workspaceId 校验）；
 *   #8 CSS 内部引用在离线导出时也内联。 */

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')
const tick = () => new Promise((resolve) => setTimeout(resolve, 12))

class Response {
  constructor() {
    this.status = 0
    this.headers = {}
    this.body = undefined
  }
  writeHead(status, headers) {
    this.status = status
    this.headers = { ...this.headers, ...(headers ?? {}) }
  }
  setHeader(name, value) {
    this.headers[name] = value
  }
  end(body) {
    this.body = body
  }
}

function mount(root) {
  const captured = { route: undefined }
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (route) => { captured.route = route; return () => {} } }
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'sessions') return { get: (id) => (id === 's1' ? { header: { cwd: root } } : undefined) }
      return undefined
    },
    effect: (factory) => { factory() },
    logger: { warn() {} }
  }
  registerClassroom(ctx, { getConfig: () => ({}) })
  const call = async (endpoint, payload) => (await callRpc(captured.route, endpoint, payload)).result
  return { call, captured }
}

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-fixes-062-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'assets', 'course.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(ws, 'assets', 'course.css'), 'body{}\n')
  fs.writeFileSync(
    path.join(ws, 'lessons', 'one.html'),
    '<html><head><link rel="stylesheet" href="../assets/course.css"></head><body><script src="../assets/course.js"></script>课</body></html>'
  )
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'choice', prompt: '选一个', options: [{ id: 'a' }, { id: 'b' }], answer: 'b' })
  // 开放题：提交后没有任何确定性判分，保持 pending，用来验证 #9 的接续。
  registerQuestion(ws, { questionId: 'q2', lessonId: 'l1', type: 'explanation', prompt: '解释一下' })
  return ws
}

async function submit(call, questionId, rawAnswer, questionRevision = 1) {
  return call('classroom/submit', { sessionId: 's1', lessonId: 'l1', revision: 1, questionId, questionRevision, rawAnswer })
}

test('#9 开放题提交：needsGrading=true，status 与 classroom/pending 都给待批改清单', async () => {
  const ws = workspace()
  const { call } = mount(ws)
  const submitted = await submit(call, 'q2', '我的解释')
  assert.equal(submitted.ok, true)
  assert.equal(submitted.value.needsGrading, true)
  assert.equal(submitted.value.verdict, null)

  const status = await call('classroom/status', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(status.ok, true)
  assert.equal(status.value.pendingCount, 1)
  assert.deepEqual(Object.keys(status.value.pending[0]).sort(), ['questionId', 'questionRevision', 'submissionId', 'submittedAt'])
  assert.equal(status.value.pending[0].questionId, 'q2')
  assert.equal(status.value.pending[0].questionRevision, 1)

  const pending = await call('classroom/pending', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(pending.ok, true)
  assert.equal(pending.value.lessonId, 'l1')
  assert.equal(pending.value.revision, 1)
  assert.equal(pending.value.pendingCount, 1)
  assert.deepEqual(pending.value.pending, status.value.pending)

  // 确定性题提交后不该出现在待批改里，且 needsGrading=false。
  const graded = await submit(call, 'q1', 'b')
  assert.equal(graded.value.verdict, 'passed')
  assert.equal(graded.value.needsGrading, false)
  const after = await call('classroom/pending', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(after.value.pendingCount, 1)
  assert.equal(after.value.pending[0].questionId, 'q2')
})

test('#5/#9 幂等返回也带 verdict/stale/needsGrading，前端不用猜', async () => {
  const ws = workspace()
  const { call } = mount(ws)
  const first = await submit(call, 'q1', 'b')
  assert.equal(first.value.verdict, 'passed')
  assert.equal(first.value.needsGrading, false)
  const again = await submit(call, 'q1', 'b')
  assert.equal(again.value.idempotent, true)
  assert.equal(again.value.verdict, 'passed')
  assert.equal(again.value.stale, false)
  assert.equal(again.value.needsGrading, false)

  await submit(call, 'q2', '解释')
  const openAgain = await submit(call, 'q2', '解释')
  assert.equal(openAgain.value.idempotent, true)
  assert.equal(openAgain.value.verdict, null)
  assert.equal(openAgain.value.stale, false)
  assert.equal(openAgain.value.needsGrading, true)
})

test('#2 catalog 最近结论按评估 createdAt 取，不用不存在的 at', async () => {
  const ws = workspace()
  const { call } = mount(ws)
  await submit(call, 'q1', 'b')
  assert.equal((await call('classroom/catalog', { sessionId: 's1' })).value.lessons[0].lastVerdict, 'passed')
  await tick()
  await submit(call, 'q2', '先写一句')
  await tick()
  registerQuestion(ws, { questionId: 'q3', lessonId: 'l1', type: 'choice', prompt: '再选一个', options: [{ id: 'a' }, { id: 'b' }], answer: 'a' })
  await submit(call, 'q3', 'b')
  const catalog = await call('classroom/catalog', { sessionId: 's1' })
  const lesson = catalog.value.lessons[0]
  assert.equal(lesson.lastVerdict, 'needs_practice')
  assert.equal(typeof lesson.lastVerdictAt, 'string')
  assert.equal(lesson.lastVerdictStale, false)
  assert.equal(lesson.lastVerdictStaleReason, undefined)
  assert.equal(typeof lesson.lastSubmittedAt, 'string')
})

test('#3/#2 题目改版后：status 标失效，catalog 报 stale 但保留历史结论', async () => {
  const ws = workspace()
  const { call } = mount(ws)
  await submit(call, 'q1', 'b')
  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'choice', prompt: '新题面', options: [{ id: 'a' }, { id: 'b' }], answer: 'b' })

  const status = await call('classroom/status', { sessionId: 's1', lessonId: 'l1' })
  const view = status.value.submissions.find((item) => item.questionId === 'q1')
  assert.equal(view.verdict, 'passed')
  assert.equal(view.stale, true)
  assert.match(view.staleReason, /题目已改版/)
  assert.equal(view.effectiveVerdict, null)
  assert.equal(typeof view.verdictAt, 'string')

  const catalog = await call('classroom/catalog', { sessionId: 's1' })
  const lesson = catalog.value.lessons[0]
  assert.equal(lesson.lastVerdict, 'passed')
  assert.equal(lesson.lastVerdictStale, true)
  assert.match(lesson.lastVerdictStaleReason, /题目已改版/)
})

test('#2 作废最新评估后回退到更早结论', async () => {
  const ws = workspace()
  const { call } = mount(ws)
  await submit(call, 'q1', 'b')
  await tick()
  await submit(call, 'q1', 'a')
  const before = await call('classroom/catalog', { sessionId: 's1' })
  assert.equal(before.value.lessons[0].lastVerdict, 'needs_practice')
  const state = readArchiveState(ws)
  const latest = Object.values(state.assessments).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))[0]
  voidAssessment(ws, { assessmentId: latest.id, reason: '测试作废' })
  const after = await call('classroom/catalog', { sessionId: 's1' })
  assert.equal(after.value.lessons[0].lastVerdict, 'passed')
  assert.equal(after.value.lessons[0].lastVerdictStale, false)
})

test('#5 桥：幂等/待批改/失效结论与错误 message 的四种反馈（真 DOM 实跑）', async () => {
  const boot = { nonce: 'n1', lessonId: 'l1', revision: 1, questions: [{ id: 'q1', revision: 1 }] }
  const html = '<!doctype html><html><body><div class="quiz" data-question-id="q1"><label><input type="radio" name="a" value="b"></label><button type="button">判卷</button><p class="verdict"></p></div></body></html>'
  const { injectClassroomHtml } = await import('../../lib/classroom/assets.js')
  const injected = injectClassroomHtml(html, { baseHref: '/', bootstrap: boot })
  const { window, document } = parseHTML(injected)
  Object.defineProperty(document, 'readyState', { value: 'complete' })
  const posted = []
  const context = vm.createContext({ window, document, parent: { postMessage: (message) => posted.push(message) }, console, Map, Promise, Date, setTimeout: () => 1 })
  vm.runInContext(document.getElementById('teach-classroom-bridge').textContent, context)
  const quiz = document.querySelector('.quiz')
  quiz.querySelector('input[value="b"]').setAttribute('checked', '')
  const button = quiz.querySelector('[data-teach-submit]')
  const click = () => button.dispatchEvent(new window.Event('click', { bubbles: true }))
  const feedback = () => quiz.querySelector('.teach-classroom-result').textContent
  const flush = () => new Promise((resolve) => setImmediate(resolve))
  assert.ok(button, '桥应当给页面里的 quiz 补提交按钮')

  window.teachClassroom.submit = () => Promise.resolve({ verdict: null, needsGrading: true })
  click()
  await flush()
  assert.match(feedback(), /已保存，等待导师批改/)

  window.teachClassroom.submit = () => Promise.resolve({ verdict: 'passed', stale: true, staleReason: '题目已改版（评估 v1，现在 v2）' })
  click()
  await flush()
  assert.match(feedback(), /评估通过/)
  assert.match(feedback(), /旧结论已失效：题目已改版/)

  window.teachClassroom.submit = () => Promise.reject({ code: 'question-revision-stale', message: '题目已改版，刷新课堂后再提交' })
  click()
  await flush()
  assert.match(feedback(), /题目已改版，刷新课堂后再提交/)
  assert.equal(button.disabled, false)

  window.teachClassroom.submit = () => Promise.resolve({ verdict: null })
  click()
  await flush()
  assert.match(feedback(), /已提交，等待评估/)
})

test('#10 离线进度带 items 与结论口径；导出页含本机记录与下载按钮', async () => {
  const ws = workspace()
  const { call } = mount(ws)
  await submit(call, 'q1', 'b')
  await submit(call, 'q2', '开放题作答')
  const exported = await call('classroom/export', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(exported.ok, true)
  const progress = exported.value.progress
  assert.equal(Array.isArray(progress.items), true)
  assert.equal(progress.items.length, 2)
  assert.deepEqual(Object.keys(progress.items[0]).sort(), ['questionId', 'rawAnswer', 'submittedAt'])
  const passed = progress.submissions.find((item) => item.questionId === 'q1')
  assert.equal(passed.verdict, 'passed')
  assert.equal(passed.effectiveVerdict, 'passed')
  assert.equal(passed.stale, false)
  const open = progress.submissions.find((item) => item.questionId === 'q2')
  assert.equal(open.verdict, null)
  assert.equal(open.effectiveVerdict, null)

  const html = exported.value.html
  assert.match(html, /teach-offline:/)
  assert.match(html, /记下这次作答/)
  assert.match(html, /下载学习进度 JSON/)
  assert.match(html, /data-teach-offline-download/)
  assert.match(html, /localStorage/)
  assert.match(html, /通过 " \+ passed \+ " 次/)
})

test('#10 离线摘要：失效的旧通过不进「通过 N 次」，单独写「已失效 M」', async () => {
  const ws = workspace()
  const { call } = mount(ws)
  await submit(call, 'q1', 'b')
  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'choice', prompt: '新题面', options: [{ id: 'a' }, { id: 'b' }], answer: 'b' })
  const exported = await call('classroom/export', { sessionId: 's1', lessonId: 'l1' })
  const progress = exported.value.progress
  assert.equal(progress.submissions[0].verdict, 'passed')
  assert.equal(progress.submissions[0].stale, true)
  assert.equal(progress.submissions[0].effectiveVerdict, null)
  assert.match(exported.value.html, /通过 " \+ passed \+ " 次/)
  assert.match(exported.value.html, /已失效 " \+ expired/)
})

test('#10 导出的进度文件能导入（含 submissions 形状）；workspaceId 不符被拒', async () => {
  const ws = workspace()
  const { call } = mount(ws)
  await submit(call, 'q2', '开放题作答')
  const exported = await call('classroom/export', { sessionId: 's1', lessonId: 'l1' })
  const progress = exported.value.progress
  const payload = {
    version: 1,
    workspaceId: progress.workspaceId,
    lessonId: 'l1',
    revision: progress.revision,
    items: progress.items.concat([{ questionId: 'q1', rawAnswer: 'b', submittedAt: '2026-01-01T00:00:00.000Z' }])
  }
  const imported = await call('classroom/import', { sessionId: 's1', lessonId: 'l1', data: payload })
  assert.equal(imported.ok, true)
  assert.equal(imported.value.imported, 2)
  const again = await call('classroom/import', { sessionId: 's1', lessonId: 'l1', data: payload })
  assert.equal(again.value.imported, 0)
  assert.equal(again.value.skipped, 2)

  // submissions 形状（旧文件/直接给 submission 列表）也认，用 rawAnswer 当自报内容。
  const fromSubmissions = await call('classroom/import', {
    sessionId: 's1',
    lessonId: 'l1',
    data: { version: 1, lessonId: 'l1', submissions: [{ questionId: 'q1', rawAnswer: 'b', submittedAt: '2026-01-02T00:00:00.000Z' }] }
  })
  assert.equal(fromSubmissions.ok, true)
  assert.equal(fromSubmissions.value.imported, 1)

  const wrongWorkspace = await call('classroom/import', {
    sessionId: 's1',
    lessonId: 'l1',
    data: { version: 1, workspaceId: 'another-workspace', lessonId: 'l1', items: [] }
  })
  assert.equal(wrongWorkspace.ok, false)
  assert.equal(wrongWorkspace.error.code, 'import-workspace')
  assert.match(wrongWorkspace.error.message, /不是这个工作区的/)
})

test('#8 离线导出内联 CSS 内部引用（url()/@import/<style>），无裸相对路径', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-offline-css-'))
  fs.mkdirSync(path.join(root, 'lessons'))
  fs.mkdirSync(path.join(root, 'assets'))
  const css = '.hero{background:url(bg.svg)} url(missing.png);@import "theme.css";'
  const theme = '@font-face{src:url(font.woff2)}'
  const html = '<!doctype html><html><head><link rel="stylesheet" href="../assets/course.css">' +
    '<style>.inline{background:url("../assets/inline.png")}</style></head><body>课</body></html>'
  const files = {
    'assets/course.css': css,
    'assets/theme.css': theme,
    'assets/bg.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'assets/font.woff2': 'font-bytes',
    'assets/inline.png': 'png-bytes',
    'lessons/one.html': html
  }
  for (const [relative, body] of Object.entries(files)) fs.writeFileSync(path.join(root, relative), body)
  const lesson = {
    id: 'l1',
    path: 'lessons/one.html',
    revision: 1,
    fingerprint: sha256(Buffer.from(html)),
    assets: Object.entries(files)
      .filter(([relative]) => relative !== 'lessons/one.html')
      .map(([relative, body]) => ({ path: relative, sha256: sha256(Buffer.from(body)), size: Buffer.byteLength(body) }))
  }
  const state = { workspaceId: 'w1', lessons: { l1: lesson }, questions: {}, submissions: {}, selfReports: {} }
  const offline = buildOffline(root, state, lesson)
  assert.match(offline.html, /href="data:text\/css;base64,[^"]+"/)
  assert.doesNotMatch(offline.html, /href="\.\.\/assets\/course\.css"/)
  assert.match(offline.html, /data:image\/png;base64,/)

  const outer = /href="data:text\/css;base64,([^"]+)"/.exec(offline.html)[1]
  const decoded = Buffer.from(outer, 'base64').toString('utf8')
  assert.match(decoded, /url\("data:image\/svg\+xml;base64,/)
  assert.match(decoded, /@import "data:text\/css;base64,/)
  // 清单里没有的引用原样保留，占位符不会被静默吞掉。
  assert.match(decoded, /url\(missing\.png\)/)
  assert.doesNotMatch(decoded, /url\(bg\.svg\)|url\("theme\.css"\)/)

  const nested = /@import "data:text\/css;base64,([^"]+)"/.exec(decoded)[1]
  const themeDecoded = Buffer.from(nested, 'base64').toString('utf8')
  assert.match(themeDecoded, /data:font\/woff2;base64,/)
  assert.doesNotMatch(themeDecoded, /font\.woff2/)
})

test('#10 离线页脚本真跑：记下作答写 localStorage，下载导出 items（快照 + 本机）', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-offline-run-'))
  fs.mkdirSync(path.join(ws, 'lessons'))
  fs.writeFileSync(
    path.join(ws, 'lessons', 'one.html'),
    '<!doctype html><html><head><title>课</title></head><body><div class="quiz" data-question-id="q1">' +
      '<label><input type="radio" name="a" value="b"></label><p class="verdict"></p></div></body></html>'
  )
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'choice', prompt: '选一个', options: [{ id: 'a' }, { id: 'b' }], answer: 'b' })
  const { call } = mount(ws)
  await submit(call, 'q1', 'b')
  const exported = await call('classroom/export', { sessionId: 's1', lessonId: 'l1' })
  const html = exported.value.html
  const { window, document } = parseHTML(html)
  Object.defineProperty(document, 'readyState', { value: 'complete' })
  const stored = new Map()
  Object.defineProperty(window, 'localStorage', {
    value: {
      getItem: (key) => (stored.has(key) ? stored.get(key) : null),
      setItem: (key, value) => { stored.set(key, String(value)) }
    }
  })
  const blobs = []
  const anchors = []
  class BlobStub {
    constructor(parts) { this.text = parts.join(''); blobs.push(this.text) }
  }
  const createElement = document.createElement.bind(document)
  document.createElement = (tag, ...rest) => {
    const node = createElement(tag, ...rest)
    if (String(tag).toLowerCase() === 'a') anchors.push(node)
    return node
  }
  const script = /<script>\n([\s\S]*?)<\/script>/.exec(html.split('</script>').slice(-2).join('</script>'))
  assert.ok(script, '离线页应当带一段本地脚本')
  const context = vm.createContext({
    window, document, Blob: BlobStub, URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    JSON, Array, Object, String, Date, setTimeout: () => 1, console
  })
  vm.runInContext(script[1], context)

  const quiz = document.querySelector('.quiz')
  quiz.querySelector('input[value="b"]').setAttribute('checked', '')
  const record = document.querySelector('[data-teach-offline-record]')
  assert.ok(record, '离线页应当给清单内的 quiz 补「记下这次作答」')
  record.dispatchEvent(new window.Event('click', { bubbles: true }))
  const saved = JSON.parse(stored.get('teach-offline:l1'))
  assert.equal(saved.length, 1)
  assert.equal(saved[0].questionId, 'q1')
  assert.equal(saved[0].rawAnswer, 'b')
  assert.match(quiz.querySelector('.teach-offline-note').textContent, /已记在本机/)
  assert.match(document.querySelector('[data-teach-offline]').textContent, /本地已记录 1 题/)

  document.querySelector('[data-teach-offline-download]').dispatchEvent(new window.Event('click', { bubbles: true }))
  assert.equal(blobs.length, 1)
  const payload = JSON.parse(blobs[0])
  assert.equal(payload.version, 1)
  assert.equal(payload.lessonId, 'l1')
  assert.equal(payload.revision, 1)
  assert.equal(payload.workspaceId, readArchiveState(ws).workspaceId)
  assert.equal(payload.items.length, 2)
  assert.deepEqual(payload.items.map((item) => item.questionId), ['q1', 'q1'])
  assert.equal(anchors.at(-1).download, 'l1-r1-progress.json')
})

test('#10 progressOf 给每条提交展开结论口径，items 与 questions 并存', () => {
  const ws = workspace()
  const { call } = mount(ws)
  return submit(call, 'q1', 'b')
    .then(() => {
      const state = readArchiveState(ws)
      const progress = progressOf(state, 'l1')
      assert.equal(Array.isArray(progress.questions), true)
      assert.equal(progress.items.length, 1)
      const view = progress.submissions[0]
      for (const key of ['verdict', 'verdictAt', 'stale', 'staleReason', 'effectiveVerdict']) {
        assert.equal(Object.prototype.hasOwnProperty.call(view, key), true, key)
      }
      assert.equal(view.effectiveVerdict, 'passed')
    })
})
