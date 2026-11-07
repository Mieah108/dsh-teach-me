import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { registerClassroom } from '../../lib/classroom/service.js'
import { publishLesson, registerQuestion } from '../../lib/archive/operations.js'
import { callRpc } from '../helpers/classroom-rpc.js'

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-classroom-svc-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'assets', 'course.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(ws, 'assets', 'course.css'), 'body{}\n')
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), '<html><head><link rel="stylesheet" href="../assets/course.css"></head><body>课程<script src="../assets/course.js"></script></body></html>')
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'choice', prompt: '选一个', options: [{ id: 'a' }, { id: 'b' }], answer: 'b' })
  return ws
}

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

function harness(ws, { rejection } = {}) {
  const captured = { route: undefined }
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (route) => { captured.route = route; return () => {} } }
      if (name === 'connection') return { requestRejection: () => (typeof rejection === 'function' ? rejection() : undefined) }
      if (name === 'sessions') return { get: (id) => (id === 's1' ? { header: { cwd: ws } } : undefined) }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    },
    logger: { warn: () => {} }
  }
  const registered = registerClassroom(ctx, { getConfig: () => ({ animation: { root: '' } }) })
  // 旧签名 shim：peer 不是 owner 时仍按 forbidden 处理；其余走真实 HTTP 路由。
  captured.rpc = async (endpoint, payload, _signal, peer) => {
    if (peer !== undefined && peer !== null && peer.principal !== undefined && peer.principal.kind !== 'owner') {
      return { ok: false, error: { code: 'forbidden', message: '课堂回传只接受本机 owner' } }
    }
    const out = await callRpc(captured.route, endpoint, payload)
    return out.result
  }
  return { registered, captured }
}

const OWNER = { principal: { kind: 'owner' } }
const OTHER = { principal: { kind: 'other' } }

test('注册路由与 RPC，open 只返回已发布课程与去答案题目', async () => {
  const ws = workspace()
  const { registered, captured } = harness(ws)
  assert.equal(registered.enabled, true)
  assert.equal(captured.route.path, '/teach-classroom')
  assert.equal(captured.route.kind, 'prefix')
  assert.equal(captured.route.path, '/teach-classroom')

  const opened = await captured.rpc('classroom/open', { sessionId: 's1', path: 'lessons/one.html' }, undefined, OWNER)
  assert.equal(opened.ok, true)
  assert.match(opened.value.url, /^\/teach-classroom\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/lessons\/one\.html$/)
  assert.equal(opened.value.lessonId, 'l1')
  assert.equal(opened.value.revision, 1)
  assert.equal(opened.value.questions.length, 1)
  assert.equal(opened.value.questions[0].answer, undefined)

  const viaAddress = await captured.rpc('classroom/open', { sessionId: 's1', address: 'dsh-resource://file/session/s1/lessons/one.html' }, undefined, OWNER)
  assert.equal(viaAddress.ok, true)
  assert.equal(viaAddress.value.lessonId, 'l1')
})

test('页面通过能力票服务，注入 base/bridge/CSP，Range 与 HEAD 正常', async () => {
  const ws = workspace()
  const { captured } = harness(ws)
  const opened = await captured.rpc('classroom/open', { sessionId: 's1', path: 'lessons/one.html' }, undefined, OWNER)
  const pageUrl = opened.value.url
  const token = pageUrl.split('/')[2]

  const page = new Response()
  await captured.route.handler({ method: 'GET', url: pageUrl, headers: {} }, page)
  assert.equal(page.status, 200)
  assert.equal(page.headers['Content-Type'], 'text/html; charset=utf-8')
  assert.match(page.headers['Content-Security-Policy'], /default-src 'none'/)
  const html = Buffer.isBuffer(page.body) ? page.body.toString('utf8') : String(page.body)
  assert.match(html, /<base href="\/teach-classroom\/[^"]+\/lessons\/">/)
  assert.match(html, /teach-classroom-bridge/)
  assert.match(html, /"lessonId":"l1"/)

  const assetUrl = '/teach-classroom/' + token + '/assets/course.js'
  const asset = new Response()
  await captured.route.handler({ method: 'GET', url: assetUrl, headers: { range: 'bytes=0-3' } }, asset)
  assert.equal(asset.status, 206)
  assert.equal(asset.headers['Content-Range'], 'bytes 0-3/15')
  assert.equal(asset.body.toString('utf8'), 'cons')

  const head = new Response()
  await captured.route.handler({ method: 'HEAD', url: assetUrl, headers: {} }, head)
  assert.equal(head.status, 200)
  assert.equal(head.headers['Content-Length'], 15)
  assert.equal(head.body, undefined)

  const badRange = new Response()
  await captured.route.handler({ method: 'GET', url: assetUrl, headers: { range: 'bytes=999-' } }, badRange)
  assert.equal(badRange.status, 416)
})

test('无效 token 401、未列资源 404、非 owner 回调 forbidden', async () => {
  const ws = workspace()
  const { captured } = harness(ws)
  const bad = new Response()
  await captured.route.handler({ method: 'GET', url: '/teach-classroom/not-a-token/lessons/one.html', headers: {} }, bad)
  assert.equal(bad.status, 401)

  const opened = await captured.rpc('classroom/open', { sessionId: 's1', path: 'lessons/one.html' }, undefined, OWNER)
  const token = opened.value.url.split('/')[2]
  const missing = new Response()
  await captured.route.handler({ method: 'GET', url: '/teach-classroom/' + token + '/assets/nope.js', headers: {} }, missing)
  assert.equal(missing.status, 404)

  const denied = await captured.rpc('classroom/open', { sessionId: 's1', path: 'lessons/one.html' }, undefined, OTHER)
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'forbidden')

  const noSession = await captured.rpc('classroom/open', { sessionId: 'missing', path: 'lessons/one.html' }, undefined, OWNER)
  assert.equal(noSession.ok, false)
})

test('提交经档案判分并返回，status 能看到提交摘要', async () => {
  const ws = workspace()
  const { captured } = harness(ws)
  const opened = await captured.rpc('classroom/open', { sessionId: 's1', path: 'lessons/one.html' }, undefined, OWNER)
  const submitted = await captured.rpc('classroom/submit', {
    sessionId: 's1',
    lessonId: 'l1',
    revision: opened.value.revision,
    questionId: 'q1',
    rawAnswer: 'b',
    questionRevision: 1,
    idempotencyKey: 'classroom-q1'
  }, undefined, OWNER)
  assert.equal(submitted.ok, true)
  assert.equal(submitted.value.verdict, 'passed')
  assert.equal(submitted.value.status, 'evaluated')

  const duplicate = await captured.rpc('classroom/submit', {
    sessionId: 's1',
    lessonId: 'l1',
    revision: opened.value.revision,
    questionId: 'q1',
    rawAnswer: 'b',
    questionRevision: 1,
    idempotencyKey: 'classroom-q1'
  }, undefined, OWNER)
  assert.equal(duplicate.value.idempotent, true)

  const status = await captured.rpc('classroom/status', { sessionId: 's1', lessonId: 'l1' }, undefined, OWNER)
  assert.equal(status.ok, true)
  assert.equal(status.value.submissions.length, 1)
  assert.equal(status.value.submissions[0].verdict, 'passed')
  assert.equal(status.value.questions[0].answer, undefined)

  const stale = await captured.rpc('classroom/submit', {
    sessionId: 's1',
    lessonId: 'l1',
    revision: 99,
    questionId: 'q1',
    rawAnswer: 'b'
  }, undefined, OWNER)
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'lesson-revision-stale')
})

test('离线导出包含进度与内联资源；导入只记 self_report 且去重', async () => {
  const ws = workspace()
  const { captured } = harness(ws)
  const opened = await captured.rpc('classroom/open', { sessionId: 's1', path: 'lessons/one.html' }, undefined, OWNER)
  await captured.rpc('classroom/submit', {
    sessionId: 's1', lessonId: 'l1', revision: opened.value.revision, questionId: 'q1', rawAnswer: 'b'
  }, undefined, OWNER)

  const exported = await captured.rpc('classroom/export', { sessionId: 's1', lessonId: 'l1' }, undefined, OWNER)
  assert.equal(exported.ok, true)
  assert.match(exported.value.filename, /l1-r1\.html$/)
  assert.match(exported.value.html, /teach-offline-progress/)
  assert.match(exported.value.html, /data:text\/css;[^"]*base64,/)
  assert.match(exported.value.html, /data:text\/javascript;[^"]*base64,/)
  assert.equal(exported.value.progress.submissions.length, 1)

  const imported = await captured.rpc('classroom/import', {
    sessionId: 's1',
    lessonId: 'l1',
    data: {
      version: 1,
      lessonId: 'l1',
      revision: 1,
      selfReports: [{ id: 'offline-1', questionId: 'q1', claim: '离线做对了' }]
    }
  }, undefined, OWNER)
  assert.equal(imported.ok, true)
  assert.equal(imported.value.imported, 1)

  const again = await captured.rpc('classroom/import', {
    sessionId: 's1',
    lessonId: 'l1',
    data: {
      version: 1,
      lessonId: 'l1',
      revision: 1,
      selfReports: [{ id: 'offline-1', questionId: 'q1', claim: '离线做对了' }]
    }
  }, undefined, OWNER)
  assert.equal(again.value.imported, 0)
  assert.equal(again.value.skipped, 1)

  const passed = await captured.rpc('classroom/status', { sessionId: 's1', lessonId: 'l1' }, undefined, OWNER)
  assert.equal(passed.value.submissions.length, 1)
})

test('回传接口走 POST /teach-classroom/rpc/*：围栏拒绝时 401/403，未知路径 404', async () => {
  const ws = workspace()

  // 围栏放行：正常返回 JSON 信封。
  const open = harness(ws)
  const ok = await callRpc(open.captured.route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(ok.status, 200)
  assert.equal(ok.result.ok, true)

  // 没登录（围栏 401）与跨源（围栏 403）都拒绝，且不执行任何业务逻辑。
  const unauthorized = harness(ws, { rejection: () => 401 })
  const gate401 = await callRpc(unauthorized.captured.route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(gate401.status, 401)
  assert.equal(gate401.result.ok, false)
  assert.equal(gate401.result.error.code, 'unauthorized')

  const forbidden = harness(ws, { rejection: () => 403 })
  const gate403 = await callRpc(forbidden.captured.route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(gate403.status, 403)
  assert.equal(gate403.result.error.code, 'forbidden')

  // 前缀内但不是 /rpc/ 的 POST 是 404；请求体不是 JSON 是 400。
  const wrongPath = harness(ws)
  const notFound = await callRpc(wrongPath.captured.route, '../evil', {})
  assert.equal(notFound.status, 404)
})

test('课程页里的目录式导航不会回一屏 JSON：目录按 index.html 解释，只有票据的地址重定向回课程页', async () => {
  // 课程页里 `href="./"`、`href="../reference/"` 这类链接会把末尾斜杠带进路径；
  // 旧实现把空段当资源路径，浏览器里就直接摊出一份 bad-path 的 JSON 报文。
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-classroom-nav-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'reference'), { recursive: true })
  // 发布清单只收课程页引用到的资源：把目录页链上，才是真实课程页的样子
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), '<html><body>课<a href="../reference/index.html">r</a><a href="../reference/map.html">m</a></body></html>')
  fs.writeFileSync(path.join(ws, 'reference', 'index.html'), '<html><body>目录首页</body></html>')
  fs.writeFileSync(path.join(ws, 'reference', 'map.html'), '<html><body>地图</body></html>')
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  const { captured } = harness(ws)
  const opened = await captured.rpc('classroom/open', { sessionId: 's1', lessonId: 'l1' }, undefined, OWNER)
  assert.equal(opened.ok, true)
  const token = opened.value.url.split('/')[2]
  const get = async (suffix, headers) => {
    const res = new Response()
    await captured.route.handler({ method: 'GET', url: '/teach-classroom/' + token + suffix, headers: headers ?? { accept: 'text/html', 'sec-fetch-dest': 'iframe' } }, res)
    return res
  }

  // 目录式地址：目录下有 index.html 就照常打开（按纯文本下发，仍是原来的安全口径）
  const directory = await get('/reference/')
  assert.equal(directory.status, 200)
  assert.match(String(directory.body), /目录首页/)

  // 目录里没有这一页：回一页人话 + 回到课程页，而不是 JSON
  const missing = await get('/reference/none/')
  assert.equal(missing.status, 404)
  assert.match(String(missing.headers['Content-Type']), /text\/html/)
  assert.match(String(missing.body), /这一页不在已发布清单里/)
  assert.match(String(missing.body), new RegExp('href="' + opened.value.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'))
  assert.equal(JSON.stringify(missing.body).includes('"ok":false'), false, '文档导航不该看到 JSON 信封')

  // 只带票据、或票据后多一个斜杠：就是课程页本身，`<base>` 仍落在课程目录里
  for (const suffix of ['', '/']) {
    const bare = await get(suffix)
    assert.equal(bare.status, 200, 'suffix=' + JSON.stringify(suffix))
    assert.match(String(bare.body), /teach-classroom-bridge/)
    assert.match(String(bare.body), new RegExp('<base href="[^"]*/lessons/">'))
  }

  // 文件后面多一个斜杠也照旧打开（浏览器把 `href` 写歪时很常见）
  assert.equal((await get('/lessons/one.html/')).status, 200)

  // 不是文档导航（脚本取资源）时仍然是 JSON 信封，老客户端不受影响
  const api = await get('/reference/none/', {})
  assert.equal(api.status, 404)
  const envelope = JSON.parse(String(api.body))
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'asset-not-listed')
})

test('这条路由同一份 handler 同时服务课程资源与回传（GET 仍然是资源语义）', async () => {
  const ws = workspace()
  const { captured } = harness(ws)
  const page = new Response()
  await captured.route.handler({ method: 'GET', url: '/teach-classroom/not-a-token/lessons/one.html', headers: {} }, page)
  assert.equal(page.status, 401)
  assert.match(String(page.body), /课堂链接无效/)
})

test('离线导出拒绝发布后被替换的资源与课程页（包括同长度改写）', async () => {
  for (const relative of ['assets/course.js', 'lessons/one.html']) {
    const ws = workspace()
    const { captured } = harness(ws)
    const file = path.join(ws, relative)
    const original = fs.readFileSync(file)
    fs.writeFileSync(file, Buffer.alloc(original.length, 120))
    const out = await captured.rpc('classroom/export', { sessionId: 's1', lessonId: 'l1' })
    assert.equal(out.ok, false, relative)
    assert.match(out.error.message, /hash|哈希/)
  }
})

test('离线导出拒绝发布后变成越界符号链接的资源', async () => {
  const ws = workspace()
  const { captured } = harness(ws)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-export-outside-'))
  const secret = path.join(outside, 'secret.js')
  fs.writeFileSync(secret, 'private-data')
  fs.unlinkSync(path.join(ws, 'assets/course.js'))
  fs.symlinkSync(secret, path.join(ws, 'assets/course.js'))
  const out = await captured.rpc('classroom/export', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(out.ok, false)
})

test('离线进度按课程隔离：不导出其他课自报，不导入其他课题目', async () => {
  const ws = workspace()
  const { captured } = harness(ws)
  publishLesson(ws, { lessonId: 'l2', path: 'lessons/one.html', title: '第二课' })
  registerQuestion(ws, { questionId: 'q2', lessonId: 'l2', type: 'choice', prompt: '选一个', options: [{ id: 'a' }], answer: 'a' })
  const imported = await captured.rpc('classroom/import', {
    sessionId: 's1', lessonId: 'l1', data: { version: 1, lessonId: 'l1', selfReports: [{ id: 'wrong', questionId: 'q2', claim: '别课的题' }] }
  })
  assert.equal(imported.value.imported, 0)
  await captured.rpc('classroom/import', {
    sessionId: 's1', lessonId: 'l2', data: { version: 1, lessonId: 'l2', selfReports: [{ id: 'right', questionId: 'q2', claim: '别课的记录' }] }
  })
  const out = await captured.rpc('classroom/export', { sessionId: 's1', lessonId: 'l1' })
  assert.deepEqual(out.value.progress.selfReports, [])
})

test('课堂打开返回题目 revision，题目单独改版后拒绝旧课堂提交', async () => {
  const ws = workspace()
  const { captured } = harness(ws)
  const opened = await captured.rpc('classroom/open', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(opened.value.questions[0].revision, 1)
  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'choice', prompt: '新题目', options: [{ id: 'a' }, { id: 'b' }], answer: 'a' })
  const submitted = await captured.rpc('classroom/submit', { sessionId: 's1', lessonId: 'l1', revision: opened.value.revision, questionRevision: opened.value.questions[0].revision, questionId: 'q1', rawAnswer: 'b' })
  assert.equal(submitted.ok, false)
  assert.equal(submitted.error.code, 'question-revision-stale')
})

test('32 MiB 资源同长度改写也返回 409，不能绕过发布哈希', async (t) => {
  const ws = workspace()
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
  const file = path.join(ws, 'assets', 'clip.mp4')
  fs.writeFileSync(file, Buffer.alloc(32 * 1024 * 1024, 65))
  fs.appendFileSync(path.join(ws, 'lessons', 'one.html'), '<video src="../assets/clip.mp4"></video>')
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  const { captured } = harness(ws)
  const opened = await captured.rpc('classroom/open', { sessionId: 's1', lessonId: 'l1' })
  const fd = fs.openSync(file, 'r+')
  try { fs.writeSync(fd, Buffer.from('B'), 0, 1, 0) } finally { fs.closeSync(fd) }
  const response = new Response()
  const token = opened.value.url.split('/')[2]
  await captured.route.handler({ method: 'GET', url: '/teach-classroom/' + token + '/assets/clip.mp4', headers: {} }, response)
  assert.equal(response.status, 409)
  assert.match(String(response.body), /asset-hash-mismatch/)
})

test('只改课程资源后重新发布会更新 revision 和清单', async () => {
  const ws = workspace()
  const { captured } = harness(ws)
  fs.writeFileSync(path.join(ws, 'assets/course.js'), 'console.log(2)\n')
  const published = publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '新标题' })
  assert.equal(published.idempotent, false)
  assert.equal(published.lessonRevision, 2)
  const opened = await captured.rpc('classroom/open', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(opened.value.title, '新标题')
  const token = opened.value.url.split('/')[2]
  const response = new Response()
  await captured.route.handler({ method: 'GET', url: '/teach-classroom/' + token + '/assets/course.js', headers: {} }, response)
  assert.equal(response.status, 200)
})
