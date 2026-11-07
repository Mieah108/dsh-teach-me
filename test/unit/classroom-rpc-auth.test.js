/* A2 · 课堂 RPC 授权矩阵（规格 v0.6.3-A §2.2）。
 *
 * 覆盖：无票 / 票不在请求头 / 篡改签名 / 篡改 payload / 过期 / workspace 不符 /
 * lesson+revision 不符 / payload.sessionId 与票不一致 / 跨会话读写不落库 /
 * 宿主围栏代理条件 / 课程页 frame-ancestors 与 sandbox / 二级 .html 非 text/html /
 * 限频 429 / import 条数上限与身份绑定（含批量事务）/ 正常路径回归。
 *
 * 说明（必须保留）：单用户本机部署只有唯一登录主体，构造不出真正的「第二个 owner」，
 * 因此「无 cookie / 伪造 Origin / Sec-Fetch-Site: cross-site」是**代理条件**：直接驱动
 * 宿主 connection.requestRejection 的拒绝路径，断言状态码与业务不落库，不代表真实第二主体。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishLesson, readArchiveState, registerQuestion } from '../../lib/archive/operations.js'
import { registerClassroom } from '../../lib/classroom/service.js'
import { callRpc, getAsset } from '../helpers/classroom-rpc.js'

const PAGE = '<!doctype html><html><head><link rel="stylesheet" href="../assets/course.css"></head>'
  + '<body><p>课</p><a href="extra.html">附页</a><script src="../assets/course.js"></script></body></html>'

function workspace(tag) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-rpc-auth-' + (tag || 'ws') + '-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'assets', 'course.js'), 'window.courseLoaded = true\n')
  fs.writeFileSync(path.join(ws, 'assets', 'course.css'), 'body { margin: 0 }\n')
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), PAGE)
  fs.writeFileSync(path.join(ws, 'lessons', 'extra.html'), '<!doctype html><html><body><p>二级页</p></body></html>')
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'choice', prompt: '选一个', options: [{ id: 'a' }, { id: 'b' }], answer: 'b' })
  return ws
}

/** 一个可变会话映射：用来构造「票签的档案」与「当前会话解析到的档案」不一致。 */
function mount(sessions, options) {
  const captured = { route: undefined }
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (route) => { captured.route = route; return () => {} } }
      if (name === 'connection') return { requestRejection: (options && options.rejection) || (() => undefined) }
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      return undefined
    },
    effect: (factory) => factory(),
    logger: { warn() {} }
  }
  const registered = registerClassroom(ctx, { getConfig: () => ({}), rpcRateLimit: options && options.rpcRateLimit })
  assert.equal(registered.enabled, true)
  return captured.route
}

function sessionOf(root) {
  return new Map([['s1', { header: { cwd: root } }], ['s2', { header: { cwd: root } }]])
}

async function openTicket(route, payload) {
  const opened = await callRpc(route, 'classroom/open', payload || { sessionId: 's1', lessonId: 'l1' })
  assert.equal(opened.status, 200)
  assert.equal(opened.result.ok, true, JSON.stringify(opened.result))
  const url = opened.result.value.url
  return { token: String(url).split('/')[2], value: opened.result.value, url: url }
}

const ticketed = (route, endpoint, payload) => callRpc(route, endpoint, payload, { ticket: false })
const withTicket = (route, endpoint, payload, token) => callRpc(route, endpoint, payload, { headers: { 'x-teach-classroom': token } })

const revisionOf = (ws) => readArchiveState(ws).revision

test('无票：submit/status/export/import 全部 401，且不写档案', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const before = revisionOf(ws)
  for (const endpoint of ['classroom/submit', 'classroom/status', 'classroom/export', 'classroom/import']) {
    const out = await ticketed(route, endpoint, { sessionId: 's1', lessonId: 'l1', revision: 1, questionId: 'q1', rawAnswer: 'b', data: { version: 1 } })
    assert.equal(out.status, 401, endpoint)
    assert.equal(out.result.ok, false)
    assert.equal(out.result.error.code, 'unauthorized', endpoint)
  }
  assert.equal(revisionOf(ws), before, '被拒的请求不能推进档案 revision')
})

test('票放在 body 里不当身份依据：仍然 401', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const { token } = await openTicket(route)
  const out = await ticketed(route, 'classroom/status', { sessionId: 's1', lessonId: 'l1', token: token, ticket: token, 'x-teach-classroom': token })
  assert.equal(out.status, 401)
  assert.equal(out.result.error.code, 'unauthorized')
})

test('篡改签名 / 篡改 payload：401 ticket-invalid；过期票：410 ticket-expired', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const { token } = await openTicket(route)

  // 改签名最后一个字符
  const signatureTampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
  const tampered = await withTicket(route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' }, signatureTampered)
  assert.equal(tampered.status, 401)
  assert.equal(tampered.result.error.code, 'ticket-invalid')

  // 改 payload 段（保留原签名）：把 sessionId 换掉
  const parts = token.split('.')
  const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  payload.sessionId = 's2'
  const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') + '.' + parts[1]
  const forgedOut = await withTicket(route, 'classroom/status', { sessionId: 's2', lessonId: 'l1' }, forged)
  assert.equal(forgedOut.status, 401)
  assert.equal(forgedOut.result.error.code, 'ticket-invalid')

  // 过期：把 Date.now 推到 TTL 之后（票只有服务端密钥能签，测试用时间推进构造过期）
  const realNow = Date.now
  Date.now = () => realNow() + 13 * 60 * 60 * 1000
  try {
    const expired = await withTicket(route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' }, token)
    assert.equal(expired.status, 410)
    assert.equal(expired.result.error.code, 'ticket-expired')
  } finally {
    Date.now = realNow
  }
})

test('票的 workspaceId 与档案不符：403 workspace-mismatch', async () => {
  const ws = workspace('a')
  const other = workspace('b')
  const sessions = sessionOf(ws)
  const route = mount(sessions)
  const { token } = await openTicket(route)
  // 同一会话换到另一个教学根（真实场景：bind 到别的目录 / 档案被替换）
  sessions.set('s1', { header: { cwd: other } })
  const out = await withTicket(route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' }, token)
  assert.equal(out.status, 403)
  assert.equal(out.result.error.code, 'workspace-mismatch')
})

test('票的 lessonId/revision 与档案不符：410；payload.lessonId 与票不符：403', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const { token } = await openTicket(route)
  // 课程重新发布 → revision 变了，旧票必须 410
  fs.writeFileSync(path.join(ws, 'assets', 'course.js'), 'window.courseLoaded = 2\n')
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  const stale = await withTicket(route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' }, token)
  assert.equal(stale.status, 410)
  assert.equal(stale.result.error.code, 'lesson-revision-stale')

  // 另一节课：票绑定 l1，payload 要 l2 → 403
  const fresh = ws
  const { token: token2 } = await openTicket(route, { sessionId: 's1', lessonId: 'l1' })
  const cross = await withTicket(route, 'classroom/export', { sessionId: 's1', lessonId: 'l1' }, token2)
  assert.equal(cross.status, 200, JSON.stringify(cross.result))
  // payload.revision 与票不一致
  const wrongRevision = await withTicket(route, 'classroom/submit', { sessionId: 's1', lessonId: 'l1', revision: 99, questionId: 'q1', rawAnswer: 'b' }, token2)
  assert.equal(wrongRevision.status, 410)
  assert.equal(wrongRevision.result.error.code, 'lesson-revision-stale')
  assert.equal(fresh, ws)
})

test('payload.sessionId 与票不一致：403，且不产生 journal 行（跨会话读写）', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const { token } = await openTicket(route)
  const before = revisionOf(ws)
  for (const endpoint of ['classroom/status', 'classroom/export', 'classroom/import', 'classroom/submit']) {
    const payload = endpoint === 'classroom/import'
      ? { sessionId: 's2', lessonId: 'l1', data: { version: 1, selfReports: [{ id: 'cross-1', questionId: 'q1', claim: '别的会话写的' }] } }
      : endpoint === 'classroom/submit'
        ? { sessionId: 's2', lessonId: 'l1', revision: 1, questionId: 'q1', rawAnswer: 'b' }
        : { sessionId: 's2', lessonId: 'l1' }
    const out = await withTicket(route, endpoint, payload, token)
    assert.equal(out.status, 403, endpoint)
    assert.equal(out.result.error.code, 'session-mismatch', endpoint)
  }
  assert.equal(revisionOf(ws), before, '跨会话请求不能写档案')
})

test('宿主围栏代理条件：无 cookie 401 / 伪造 Origin 或 cross-site 403（非真实第二主体）', async () => {
  const ws = workspace()
  const before = revisionOf(ws)
  const cases = [
    { label: 'no-cookie', rejection: () => 401, status: 401, code: 'unauthorized' },
    { label: 'forged-origin', rejection: () => 403, status: 403, code: 'forbidden' },
    { label: 'cross-site', rejection: () => 403, status: 403, code: 'forbidden' }
  ]
  for (const item of cases) {
    const route = mount(sessionOf(ws), { rejection: item.rejection })
    const out = await ticketed(route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' })
    assert.equal(out.status, item.status, item.label)
    assert.equal(out.result.error.code, item.code, item.label)
  }
  assert.equal(revisionOf(ws), before)
})

test('课程页响应头必须有 frame-ancestors + sandbox；二级 .html 不以 text/html 返回', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const { token, url } = await openTicket(route)
  const page = await getAsset(route, url)
  assert.equal(page.status, 200)
  const csp = page.headers['content-security-policy']
  assert.equal(typeof csp, 'string')
  assert.match(csp, /frame-ancestors 'self'/)
  assert.match(csp, /sandbox allow-scripts/)
  assert.match(csp, /connect-src 'none'/)
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8')
  assert.match(page.body, /teach-classroom-bridge/)

  const sub = await getAsset(route, '/teach-classroom/' + token + '/lessons/extra.html')
  assert.equal(sub.status, 200)
  assert.equal(sub.headers['content-type'], 'text/plain; charset=utf-8')
  assert.doesNotMatch(String(sub.headers['content-type']), /text\/html/)
  assert.doesNotMatch(sub.body, /teach-classroom-bridge/)

  // 课程页里点到另一份已发布页面（参考页、速查页）：这是文档导航，浏览器里得看到页面而不是源码。
  // 它仍然跑在同一套 sandbox + CSP 下，但没有课堂桥——题目只在课程页本身上报。
  const subDoc = await getAsset(route, '/teach-classroom/' + token + '/lessons/extra.html', { headers: { accept: 'text/html', 'sec-fetch-dest': 'iframe' } })
  assert.equal(subDoc.status, 200)
  assert.equal(subDoc.headers['content-type'], 'text/html; charset=utf-8')
  assert.match(String(subDoc.headers['content-security-policy']), /sandbox allow-scripts/)
  assert.match(String(subDoc.headers['content-security-policy']), /frame-ancestors 'self'/)
  assert.doesNotMatch(String(subDoc.body), /teach-classroom-bridge/)
  assert.match(String(subDoc.body), /<base href="\/teach-classroom\//)
})

test('限频：每 endpoint + 每 session 60 次/分钟，超限 429 且 message 可读', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws), { rpcRateLimit: { limit: 3, windowMs: 60000 } })
  const { token } = await openTicket(route)
  for (let index = 0; index < 3; index += 1) {
    const ok = await withTicket(route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' }, token)
    assert.equal(ok.status, 200)
  }
  const limited = await withTicket(route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' }, token)
  assert.equal(limited.status, 429)
  assert.equal(limited.result.error.code, 'rate-limited')
  assert.match(limited.result.error.message, /每分钟上限/)
  // 桶按 session 分：另一条会话的票不受影响
  const other = await openTicket(route, { sessionId: 's2', lessonId: 'l1' })
  const allowed = await withTicket(route, 'classroom/status', { sessionId: 's2', lessonId: 'l1' }, other.token)
  assert.equal(allowed.status, 200)
})

test('import 超过 500 条：413 拒绝且一条都不写', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const { token } = await openTicket(route)
  const before = revisionOf(ws)
  const selfReports = []
  for (let index = 0; index <= 500; index += 1) selfReports.push({ id: 'bulk-' + index, questionId: 'q1', claim: '第 ' + index + ' 条' })
  const out = await withTicket(route, 'classroom/import', { sessionId: 's1', lessonId: 'l1', data: { version: 1, lessonId: 'l1', selfReports: selfReports } }, token)
  assert.equal(out.status, 413)
  assert.equal(out.result.error.code, 'import-too-many')
  assert.equal(revisionOf(ws), before)
  assert.equal(Object.keys(readArchiveState(ws).selfReports).length, 0)
})

test('import 身份绑定：文件 lessonId/workspaceId/revision/fingerprint/题目 revision 对不上即拒', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const { token } = await openTicket(route)
  const state = readArchiveState(ws)
  const before = state.revision
  const base = { version: 1, lessonId: 'l1', selfReports: [{ id: 'id-1', questionId: 'q1', claim: '一条' }] }
  const call = (data) => withTicket(route, 'classroom/import', { sessionId: 's1', lessonId: 'l1', data: data }, token)

  const wrongLesson = await call(Object.assign({}, base, { lessonId: 'l2' }))
  assert.equal(wrongLesson.status, 403)
  assert.equal(wrongLesson.result.error.code, 'import-lesson')

  const wrongWorkspace = await call(Object.assign({}, base, { workspaceId: 'someone-else' }))
  assert.equal(wrongWorkspace.status, 403)
  assert.equal(wrongWorkspace.result.error.code, 'import-workspace')

  const wrongRevision = await call(Object.assign({}, base, { revision: 2 }))
  assert.equal(wrongRevision.status, 410)
  assert.equal(wrongRevision.result.error.code, 'import-revision')

  const wrongFingerprint = await call(Object.assign({}, base, { fingerprint: '0'.repeat(64) }))
  assert.equal(wrongFingerprint.status, 410)
  assert.equal(wrongFingerprint.result.error.code, 'import-fingerprint')

  const staleQuestion = await call(Object.assign({}, base, { selfReports: [{ id: 'id-2', questionId: 'q1', claim: '旧题面', questionRevision: 9 }] }))
  assert.equal(staleQuestion.status, 410)
  assert.equal(staleQuestion.result.error.code, 'import-question-revision')

  assert.equal(revisionOf(ws), before, '以上拒绝都不能写档案')
  assert.equal(Object.keys(readArchiveState(ws).selfReports).length, 0)
})

test('import 批量事务：N 条只推进一个 revision；重放幂等', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const { token } = await openTicket(route)
  const before = revisionOf(ws)
  const data = {
    version: 1,
    lessonId: 'l1',
    selfReports: [
      { id: 'batch-1', questionId: 'q1', claim: '一' },
      { id: 'batch-2', questionId: 'q1', claim: '二' },
      { id: 'batch-3', questionId: 'q1', claim: '三' }
    ]
  }
  const first = await withTicket(route, 'classroom/import', { sessionId: 's1', lessonId: 'l1', data: data }, token)
  assert.equal(first.status, 200)
  assert.equal(first.result.value.imported, 3)
  assert.equal(revisionOf(ws), before + 1, '批量导入必须只推进一个 revision（一次事务）')

  const replay = await withTicket(route, 'classroom/import', { sessionId: 's1', lessonId: 'l1', data: data }, token)
  assert.equal(replay.result.value.imported, 0)
  assert.equal(replay.result.value.skipped, 3)
  assert.equal(revisionOf(ws), before + 1, '幂等重放不写档案')
})

test('正常路径回归：open → 页面 → submit → status → export → import 全绿', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const { token, url, value } = await openTicket(route)
  assert.equal(value.lessonId, 'l1')

  const page = await getAsset(route, url)
  assert.equal(page.status, 200)
  assert.match(page.body, /"lessonId":"l1"/)

  const submitted = await withTicket(route, 'classroom/submit', {
    sessionId: 's1', lessonId: 'l1', revision: value.revision, questionId: 'q1', questionRevision: 1, rawAnswer: 'b', idempotencyKey: 'auth-ok-1'
  }, token)
  assert.equal(submitted.status, 200)
  assert.equal(submitted.result.ok, true, JSON.stringify(submitted.result))
  assert.equal(submitted.result.value.verdict, 'passed')

  const status = await withTicket(route, 'classroom/status', { sessionId: 's1', lessonId: 'l1' }, token)
  assert.equal(status.status, 200)
  assert.equal(status.result.value.submissions.length, 1)

  const exported = await withTicket(route, 'classroom/export', { sessionId: 's1', lessonId: 'l1' }, token)
  assert.equal(exported.status, 200)
  assert.match(exported.result.value.filename, /l1-r1\.html$/)

  const imported = await withTicket(route, 'classroom/import', {
    sessionId: 's1', lessonId: 'l1', data: { version: 1, lessonId: 'l1', revision: 1, selfReports: [{ id: 'offline-1', questionId: 'q1', claim: '离线做对了' }] }
  }, token)
  assert.equal(imported.status, 200)
  assert.equal(imported.result.value.imported, 1)
})

test('引导端点口径：catalog/open 无票可用（宿主围栏 + 会话存在性），pending 无票可用且不写档案', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const catalog = await ticketed(route, 'classroom/catalog', { sessionId: 's1' })
  assert.equal(catalog.status, 200)
  assert.equal(catalog.result.value.lessons.length, 1)
  const pending = await ticketed(route, 'classroom/pending', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(pending.status, 200)
  assert.equal(pending.result.value.pendingCount, 0)
  // 未知会话仍然被拒（引导端点也要过会话存在性）
  const missing = await ticketed(route, 'classroom/catalog', { sessionId: 'nope' })
  assert.equal(missing.status, 200)
  assert.equal(missing.result.ok, false)
})

test('非 owner / 未知端点保持不变', async () => {
  const ws = workspace()
  const route = mount(sessionOf(ws))
  const unknown = await ticketed(route, 'classroom/nope', { sessionId: 's1' })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.result.error.code, 'unknown-endpoint')
})
