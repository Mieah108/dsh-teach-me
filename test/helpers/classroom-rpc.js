import { EventEmitter } from 'node:events'

/* 课堂回传现在是「一条前缀路由 + POST /rpc/<endpoint>」，测试直接打路由处理器。
 * 这里只做最小 HTTP 假件：够 src 侧的 writeHead/end/setHeader 与 req 的事件流用。 */

export function fakeResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value
    },
    writeHead(status, headers) {
      this.statusCode = status
      if (headers !== undefined) for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value
      return this
    },
    end(body) {
      if (body !== undefined) this.body += Buffer.isBuffer(body) ? body.toString('utf8') : String(body)
      this.ended = true
    },
    on() {
      return this
    }
  }
  return res
}

/** 票据端点的「正常客户端」动作：先 open 拿票，再带 X-Teach-Classroom 重放。 */
const TICKETED_ENDPOINTS = new Set(['classroom/submit', 'classroom/status', 'classroom/export', 'classroom/import'])

function postRpc(route, endpoint, payload, headers) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/teach-classroom/rpc/' + String(endpoint).split('/').map(encodeURIComponent).join('/')
  req.headers = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', ...headers }
  const res = fakeResponse()
  const done = route.handler(req, res)
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify({ payload })))
    req.emit('end')
  })
  return done.then(() => {
    const parsed = res.body === '' ? undefined : JSON.parse(res.body)
    return { status: res.statusCode, headers: res.headers, result: parsed }
  })
}

/**
 * 发一次课堂 RPC：POST /teach-classroom/rpc/<endpoint>，体是 {payload}。
 *
 * 这里模拟**真实客户端**（client.js 的 ClassroomTab）：票据端点（submit/status/export/import）
 * 先 classroom/open 拿票 —— 票就是 open 回执 url 的第一段 /teach-classroom/<token>/... ——
 * 再带 X-Teach-Classroom 请求头重放。真实客户端没有别的取票途径。
 * 要构造「无票 / 票不在请求头」的用例时传 { ticket: false } 关掉自动取票；
 * 要构造伪造/篡改票时直接传 headers['x-teach-classroom']。
 */
export async function callRpc(route, endpoint, payload = {}, { headers = {}, ticket } = {}) {
  const name = String(endpoint)
  let outbound = headers
  const provided = headers['x-teach-classroom'] ?? headers['X-Teach-Classroom']
  if (TICKETED_ENDPOINTS.has(name) && ticket !== false && provided === undefined) {
    const opened = await postRpc(route, 'classroom/open', { sessionId: payload?.sessionId, lessonId: payload?.lessonId }, {})
    const value = opened.result !== null && typeof opened.result === 'object' && opened.result.ok === true ? opened.result.value : undefined
    const token = value === undefined || typeof value.url !== 'string' ? '' : String(value.url).split('/')[2] || ''
    if (token !== '') outbound = { ...headers, 'x-teach-classroom': token }
  }
  return postRpc(route, name, payload, outbound)
}

/** GET/HEAD 课程资源。 */
export async function getAsset(route, url, { method = 'GET', headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', ...headers }
  const res = fakeResponse()
  await route.handler(req, res)
  return { status: res.statusCode, headers: res.headers, body: res.body }
}
