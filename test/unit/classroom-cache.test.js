import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ASSET_CACHE_LIMITS, createAssetCache } from '../../lib/classroom/assets.js'
import { createArchiveProjectionCache, registerClassroom } from '../../lib/classroom/service.js'
import { registerQuestion, publishLesson } from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import { callRpc } from '../helpers/classroom-rpc.js'

/* D3：课堂资源读缓存。
 *
 * 验收口径（upgrade-decision.md §4.4.3）：单次课堂会话内每个课程 revision 的 archive
 * 全量重放 ≤ 1 次；第二次资源请求命中进程内缓存、不再重算 sha256；ETag = 清单 sha256；
 * Cache-Control 从 no-store 改成 private, max-age；安全头保留；离线导出/导入语义不变。
 *
 * 计数用注入实例（createAssetCache / createArchiveProjectionCache 自带 stats），
 * 不 mock 模块、不改生产代码语义。 */

/** MathJax 量级：2 MiB。用确定性伪随机字节，避免把 2 MiB 常量写进测试源码。 */
const BIG_BYTES = 2 * 1024 * 1024

function filler(size) {
  const buffer = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) buffer[index] = (index * 37 + 11) % 251
  return buffer
}

function workspace({ big = BIG_BYTES } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-classroom-cache-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'assets', 'course.css'), 'body{color:#111}\n')
  fs.writeFileSync(path.join(ws, 'assets', 'mathjax.js'), filler(big))
  fs.writeFileSync(
    path.join(ws, 'lessons', 'one.html'),
    '<html><head><link rel="stylesheet" href="../assets/course.css"></head><body>缓存课<script src="../assets/mathjax.js"></script></body></html>'
  )
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '缓存测试课' })
  return ws
}

/** 注册课堂路由；caches 可注入自带计数的实例。 */
function harness(ws, caches) {
  const captured = { route: undefined }
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (route) => { captured.route = route; return () => {} } }
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'sessions') return { get: (id) => (id === 's1' ? { header: { cwd: ws } } : undefined) }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    },
    logger: { warn: () => {} }
  }
  const injected = caches ?? { assets: createAssetCache(), archive: createArchiveProjectionCache() }
  const registered = registerClassroom(ctx, { getConfig: () => ({ animation: { root: '' } }), caches: injected })
  assert.equal(registered.enabled, true)
  return { captured, caches: injected }
}

/** 发一次课程资源 GET/HEAD，保留原始字节（fakeResponse 会把二进制转成字符串，这里不能用）。 */
function request(route, url, { method = 'GET', headers = {} } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:3080', ...headers }
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    writeHead(status, extra) {
      this.statusCode = status
      if (extra !== undefined) for (const [name, value] of Object.entries(extra)) this.headers[name.toLowerCase()] = value
      return this
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
      this.ended = true
    }
  }
  return route.handler(req, res).then(() => ({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
}

async function openTicket(route, lessonId = 'l1') {
  const opened = await callRpc(route, 'classroom/open', { sessionId: 's1', lessonId })
  assert.equal(opened.result?.ok, true, JSON.stringify(opened.result))
  const value = opened.result.value
  return { token: value.url.split('/')[2], url: value.url, value }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function cleanup(t, ws) {
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
}

test('资源读缓存：同 revision 的重复请求不再重放档案、不再重算 sha256', async (t) => {
  const ws = workspace()
  cleanup(t, ws)
  const { captured, caches } = harness(ws)
  const { token, url } = await openTicket(captured.route)
  const bigUrl = '/teach-classroom/' + token + '/assets/mathjax.js'
  const cssUrl = '/teach-classroom/' + token + '/assets/course.css'

  // 1) 课程页（HTML）：注入后字节已变，保持 no-store，不发 ETag；但原始字节进缓存，sha256 只算一次。
  const page = await request(captured.route, url)
  assert.equal(page.status, 200)
  assert.equal(page.headers['cache-control'], 'no-store')
  assert.equal(page.headers.etag, undefined)
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.equal(page.headers['x-content-type-options'], 'nosniff')
  assert.equal(page.headers['cross-origin-resource-policy'], 'cross-origin')
  assert.equal(caches.archive.stats().replays, 1)
  assert.equal(caches.assets.stats().hashComputations, 1)

  // 2) 2 MiB 资源连取两次：第二次命中缓存，档案不再重放，sha256 不再重算。
  const first = await request(captured.route, bigUrl)
  const second = await request(captured.route, bigUrl)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.equal(first.body.length, BIG_BYTES)
  assert.ok(first.body.equals(second.body), '两次资源字节必须一致')
  assert.equal(first.headers.etag, '"' + sha256(first.body) + '"', 'ETag 必须等于清单 sha256')
  assert.equal(first.headers['cache-control'], 'private, max-age=3600')
  assert.equal(first.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(first.headers['x-content-type-options'], 'nosniff')
  assert.equal(first.headers['referrer-policy'], 'no-referrer')
  assert.equal(first.headers['cross-origin-resource-policy'], 'cross-origin')
  assert.equal(caches.archive.stats().replays, 1, '第二次资源请求不能重放档案')
  assert.equal(caches.archive.stats().hits, 2)
  assert.equal(caches.assets.stats().hashComputations, 2, '页面 + 资源各算一次哈希，第二次复用')
  assert.equal(caches.assets.stats().hits, 1)

  // 3) 再加一个小资源取两次：计数继续按「每个资源一次哈希」增长，档案重放数恒为 1。
  const cssFirst = await request(captured.route, cssUrl)
  const cssSecond = await request(captured.route, cssUrl)
  assert.ok(cssFirst.body.equals(cssSecond.body))
  assert.equal(cssFirst.headers.etag, '"' + sha256(cssFirst.body) + '"')
  assert.equal(caches.archive.stats().replays, 1)
  assert.equal(caches.assets.stats().hashComputations, 3)
  assert.equal(caches.assets.stats().hits, 2)

  // 计数证据：5 次资源请求（页面 1 + 大资源 2 + 小资源 2）→ 档案重放 1 次、字节缓存命中 2 次、
  // sha256 计算 3 次（页、大资源、小资源各 1 次）。
  assert.deepEqual(
    { replays: caches.archive.stats().replays, hit: caches.assets.stats().hits, hash: caches.assets.stats().hashComputations },
    { replays: 1, hit: 2, hash: 3 }
  )
})

test('If-None-Match 命中清单 sha256 时返回 304；HTML 不发 ETag', async (t) => {
  const ws = workspace({ big: 1024 })
  cleanup(t, ws)
  const { captured, caches } = harness(ws)
  const { token, url } = await openTicket(captured.route)
  const bigUrl = '/teach-classroom/' + token + '/assets/mathjax.js'

  const first = await request(captured.route, bigUrl)
  const etag = first.headers.etag
  assert.match(etag, /^"[0-9a-f]{64}"$/)

  const revalidated = await request(captured.route, bigUrl, { headers: { 'if-none-match': etag } })
  assert.equal(revalidated.status, 304)
  assert.equal(revalidated.body.length, 0)
  assert.equal(revalidated.headers.etag, etag)
  assert.equal(revalidated.headers['cache-control'], 'private, max-age=3600')

  // 弱校验器与列表写法也认。
  const weak = await request(captured.route, bigUrl, { headers: { 'if-none-match': 'W/' + etag + ', "other"' } })
  assert.equal(weak.status, 304)

  // 不匹配时照常 200。
  const mismatch = await request(captured.route, bigUrl, { headers: { 'if-none-match': '"not-this-one"' } })
  assert.equal(mismatch.status, 200)

  // HTML 页不发 ETag：正文被注入 <base> 与票据 nonce，复用旧页会让桥的 nonce 对不上。
  const page = await request(captured.route, url, { headers: { 'if-none-match': etag } })
  assert.equal(page.status, 200)
  assert.equal(page.headers.etag, undefined)
  assert.equal(page.headers['cache-control'], 'no-store')

  assert.equal(caches.archive.stats().replays, 1)
})

test('Range / HEAD 同样命中缓存，不重复重放档案', async (t) => {
  const ws = workspace({ big: 4096 })
  cleanup(t, ws)
  const { captured, caches } = harness(ws)
  const { token } = await openTicket(captured.route)
  const bigUrl = '/teach-classroom/' + token + '/assets/mathjax.js'

  const range1 = await request(captured.route, bigUrl, { headers: { range: 'bytes=0-1023' } })
  const range2 = await request(captured.route, bigUrl, { headers: { range: 'bytes=0-1023' } })
  assert.equal(range1.status, 206)
  assert.equal(range2.status, 206)
  assert.equal(range1.body.length, 1024)
  assert.ok(range1.body.equals(range2.body))
  assert.equal(range1.headers['content-range'], 'bytes 0-1023/4096')
  assert.equal(range1.headers.etag, range2.headers.etag)
  assert.equal(range1.headers['cache-control'], 'private, max-age=3600')

  const head = await request(captured.route, bigUrl, { method: 'HEAD', headers: { range: 'bytes=0-0' } })
  assert.equal(head.status, 206)
  assert.equal(head.headers['content-length'], 1)

  const fullHead = await request(captured.route, bigUrl, { method: 'HEAD' })
  assert.equal(fullHead.status, 200)
  assert.equal(fullHead.headers['content-length'], 4096)
  assert.equal(fullHead.body.length, 0)

  assert.equal(caches.archive.stats().replays, 1)
  assert.equal(caches.assets.stats().hashComputations, 1)
  assert.equal(caches.assets.stats().hits, 3)
})

test('lessonRevision 变化后缓存键失效：新字节、新 ETag，每个 revision 只重放一次', async (t) => {
  const ws = workspace({ big: 4096 })
  cleanup(t, ws)
  const { captured, caches } = harness(ws)
  const firstOpen = await openTicket(captured.route)
  const bigUrlFirst = '/teach-classroom/' + firstOpen.token + '/assets/mathjax.js'

  const first = await request(captured.route, bigUrlFirst)
  assert.equal(first.status, 200)
  assert.equal(caches.archive.stats().replays, 1)

  // 改资源后重新发布：lessonRevision 1 → 2，清单 sha256 也变。
  const changed = Buffer.alloc(4096, 90)
  fs.writeFileSync(path.join(ws, 'assets', 'mathjax.js'), changed)
  const published = publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '缓存测试课' })
  assert.equal(published.lessonRevision, 2)

  const secondOpen = await openTicket(captured.route)
  const bigUrlSecond = '/teach-classroom/' + secondOpen.token + '/assets/mathjax.js'
  assert.notEqual(bigUrlFirst, bigUrlSecond)

  const second = await request(captured.route, bigUrlSecond)
  const third = await request(captured.route, bigUrlSecond)
  assert.equal(second.status, 200)
  assert.ok(second.body.equals(changed))
  assert.notEqual(second.headers.etag, first.headers.etag)
  assert.equal(second.headers.etag, '"' + sha256(changed) + '"')
  assert.ok(third.body.equals(second.body))

  // 两个 revision 各重放一次（各 1 次 = 满足「每 revision ≤ 1」），第二次取同一资源命中缓存。
  assert.equal(caches.archive.stats().replays, 2)
  assert.equal(caches.assets.stats().hashComputations, 2)
  assert.equal(caches.assets.stats().hits, 1)

  // 旧票（revision 1）已经过期：410，不因为缓存而复活。
  const stale = await request(captured.route, bigUrlFirst)
  assert.equal(stale.status, 410)
  assert.match(stale.body.toString('utf8'), /lesson-revision-stale/)
})

test('workspaceId 变化（档案重建）后旧票 403，新票不复用旧缓存', async (t) => {
  const ws = workspace({ big: 1024 })
  cleanup(t, ws)
  const { captured, caches } = harness(ws)
  const firstOpen = await openTicket(captured.route)
  const firstUrl = '/teach-classroom/' + firstOpen.token + '/assets/mathjax.js'
  assert.equal((await request(captured.route, firstUrl)).status, 200)
  assert.equal(caches.archive.stats().replays, 1)

  // 档案整份重建 = 新 workspaceId；文件与 lesson 相对路径不变（资源字节缓存键里的 workspaceId 必须换）。
  fs.rmSync(path.join(ws, '.dsh-teach-me'), { recursive: true, force: true })
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '缓存测试课' })

  const secondOpen = await openTicket(captured.route)
  const secondUrl = '/teach-classroom/' + secondOpen.token + '/assets/mathjax.js'
  const second = await request(captured.route, secondUrl)
  assert.equal(second.status, 200)
  // 新工作区 → 新的缓存键 → 重新读文件并重新算哈希（不复用旧工作区的字节）。
  assert.equal(caches.assets.stats().hashComputations, 2)

  // 旧票指向旧 workspaceId：身份探针发现档案已重建，返回 403 而不是继续用旧投影。
  const stale = await request(captured.route, firstUrl)
  assert.equal(stale.status, 403)
  assert.match(stale.body.toString('utf8'), /workspace-mismatch/)
})

test('档案推进后投影缓存失效：同一 revision 的页面请求能看到新登记的题目', async (t) => {
  const ws = workspace({ big: 512 })
  cleanup(t, ws)
  const { captured, caches } = harness(ws)
  const { url } = await openTicket(captured.route)

  const before = await request(captured.route, url)
  assert.equal(before.status, 200)
  assert.doesNotMatch(before.body.toString('utf8'), /"q1"/)
  assert.equal(caches.archive.stats().replays, 1)
  assert.equal(caches.assets.stats().hashComputations, 1)

  registerQuestion(ws, { questionId: 'q1', lessonId: 'l1', type: 'choice', prompt: '选一个', options: [{ id: 'a' }, { id: 'b' }], answer: 'b' })

  const after = await request(captured.route, url)
  assert.equal(after.status, 200)
  assert.match(after.body.toString('utf8'), /"q1"/, '投影缓存必须随 index.json 变化失效，不能下发旧题目清单')
  // 投影重放了第 2 次（档案推进），但页面原始字节仍在缓存里：sha256 没有重算。
  assert.equal(caches.archive.stats().replays, 2)
  assert.equal(caches.assets.stats().hashComputations, 1)
  assert.equal(caches.assets.stats().hits, 1)
})

test('不带资源段的课堂 URL 与带 lesson.path 的 URL 共用同一个缓存键', async (t) => {
  const ws = workspace({ big: 128 })
  cleanup(t, ws)
  const { captured, caches } = harness(ws)
  const { token } = await openTicket(captured.route)
  const bareUrl = '/teach-classroom/' + token

  const first = await request(captured.route, bareUrl)
  const second = await request(captured.route, bareUrl)
  assert.equal(first.status, 200)
  assert.equal(second.status, 200)
  assert.ok(first.body.equals(second.body))
  assert.equal(second.headers['cache-control'], 'no-store')
  assert.equal(caches.archive.stats().replays, 1)
  assert.equal(caches.assets.stats().hashComputations, 1)
  assert.equal(caches.assets.stats().hits, 1)
})

test('字节缓存容量：条目数与总字节双封顶、LRU 淘汰；单条超预算不缓存、错误不缓存', (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-classroom-cache-limit-'))
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  for (const name of ['a.css', 'b.css', 'c.css']) fs.writeFileSync(path.join(ws, 'assets', name), name.repeat(50))
  fs.writeFileSync(path.join(ws, 'assets', 'big.bin'), Buffer.alloc(5000, 66))
  fs.writeFileSync(
    path.join(ws, 'lessons', 'one.html'),
    '<html><head><link rel="stylesheet" href="../assets/a.css"><link rel="stylesheet" href="../assets/b.css"><link rel="stylesheet" href="../assets/c.css"></head><body><a href="../assets/big.bin">下载</a></body></html>'
  )
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '容量课' })
  const lesson = openArchive(ws).state.lessons.l1
  assert.deepEqual(ASSET_CACHE_LIMITS, { entries: 64, bytes: 32 * 1024 * 1024 })
  const cache = createAssetCache({ maxEntries: 2, maxBytes: 1000 })

  cache.read(ws, 'ws1', lesson, 'assets/a.css')
  assert.equal(cache.stats().hashComputations, 1)
  assert.equal(cache.read(ws, 'ws1', lesson, 'assets/a.css').bytes.length, 'a.css'.repeat(50).length)
  assert.equal(cache.stats().hits, 1)

  cache.read(ws, 'ws1', lesson, 'assets/b.css')
  cache.read(ws, 'ws1', lesson, 'assets/c.css') // 条目数 3 > 2 → 淘汰最旧的 a.css
  assert.equal(cache.stats().evictions, 1)
  assert.equal(cache.stats().entries, 2)

  // a.css 已被淘汰：再读要重新算哈希。
  cache.read(ws, 'ws1', lesson, 'assets/a.css')
  assert.equal(cache.stats().hashComputations, 4)

  // big.bin（5000 B）超过总预算（1000 B）→ 不入缓存，每次都要读 + 算哈希。
  cache.read(ws, 'ws1', lesson, 'assets/big.bin')
  cache.read(ws, 'ws1', lesson, 'assets/big.bin')
  assert.equal(cache.stats().hashComputations, 6)
  assert.equal(cache.stats().entries, 2)

  // 同 revision 内的同长度改写：命中缓存的路径不再复核（D3 的代价），但错误结果从不入缓存。
  const fresh = createAssetCache()
  const original = fs.readFileSync(path.join(ws, 'assets', 'a.css'))
  fs.writeFileSync(path.join(ws, 'assets', 'a.css'), Buffer.alloc(original.length, 120))
  assert.equal(fresh.read(ws, 'ws1', lesson, 'assets/a.css').error, 'asset-hash-mismatch')
  fs.writeFileSync(path.join(ws, 'assets', 'a.css'), original)
  assert.equal(fresh.read(ws, 'ws1', lesson, 'assets/a.css').bytes.length, original.length)

  cache.clear()
  assert.equal(cache.stats().entries, 0)
  assert.equal(cache.stats().bytes, 0)
})

test('课堂缓存不改变离线导出语义：导出仍逐字节复核并拒绝发布后被改写的资源', async (t) => {
  const ws = workspace({ big: 1024 })
  cleanup(t, ws)
  const { captured, caches } = harness(ws)
  const { token } = await openTicket(captured.route)
  const bigUrl = '/teach-classroom/' + token + '/assets/mathjax.js'

  // 课堂 GET 先把字节读进缓存（哈希核对通过）。
  assert.equal((await request(captured.route, bigUrl)).status, 200)

  // 发布后同长度改写：课堂 GET 命中缓存、不再复核（这是 D3 明确的代价，写进报告的风险项）。
  const file = path.join(ws, 'assets', 'mathjax.js')
  const original = fs.readFileSync(file)
  const tampered = Buffer.from(original)
  tampered[0] = (tampered[0] + 1) % 256
  fs.writeFileSync(file, tampered)
  const cached = await request(captured.route, bigUrl)
  assert.equal(cached.status, 200)
  assert.ok(cached.body.equals(original))

  // 离书导出不走缓存：仍然读盘 + 逐字节核对，拒绝被改写的资源。
  const exported = await callRpc(captured.route, 'classroom/export', { sessionId: 's1', lessonId: 'l1' })
  assert.equal(exported.result.ok, false)
  assert.match(String(exported.result.error.message), /hash|哈希/)

  // 课堂缓存命中没有额外重放档案。
  assert.equal(caches.archive.stats().replays, 1)
  assert.equal(caches.assets.stats().hashComputations, 1)
})
