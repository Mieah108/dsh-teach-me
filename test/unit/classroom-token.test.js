import assert from 'node:assert/strict'
import test from 'node:test'
import { createSecret, decodeRelative, encodeRelative, issueToken, verifyToken } from '../../lib/classroom/token.js'

const claims = {
  root: '/tmp/workspace',
  workspaceId: 'ws_test',
  sessionId: 'session-1',
  lessonId: 'l1',
  revision: 2
}

test('签发的能力票可验证，claims 原样保留', () => {
  const secret = createSecret()
  const issued = issueToken(secret, claims, { ttlMs: 60_000, now: 1000 })
  assert.match(issued.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  const verified = verifyToken(secret, issued.token, { now: 2000 })
  assert.equal(verified.ok, true)
  assert.deepEqual(
    { root: verified.claims.root, workspaceId: verified.claims.workspaceId, sessionId: verified.claims.sessionId, lessonId: verified.claims.lessonId, revision: verified.claims.revision },
    claims
  )
  assert.equal(verified.claims.purpose, 'classroom')
  assert.equal(verified.claims.v, 1)
  assert.match(verified.claims.nonce, /.+/)
})

test('过期票返回 expired', () => {
  const secret = createSecret()
  const issued = issueToken(secret, claims, { ttlMs: 1000, now: 1000 })
  assert.equal(verifyToken(secret, issued.token, { now: 2001 }).code, 'expired')
})

test('篡改 payload 或签名都验不过', () => {
  const secret = createSecret()
  const issued = issueToken(secret, claims)
  const [payload, signature] = issued.token.split('.')
  const forged = Buffer.from(Buffer.from(payload, 'base64url').toString('utf8').replace('l1', 'l2')).toString('base64url')
  assert.equal(verifyToken(secret, forged + '.' + signature).code, 'bad-signature')
  assert.equal(verifyToken(secret, payload + '.' + signature.slice(0, -2) + 'AA').code, 'bad-signature')
  assert.equal(verifyToken(secret, 'not-a-token').code, 'bad-format')
})

test('缺字段或非法 revision 拒绝签发', () => {
  const secret = createSecret()
  assert.throws(() => issueToken(secret, { ...claims, root: '' }))
  assert.throws(() => issueToken(secret, { ...claims, revision: 0 }))
  assert.throws(() => issueToken(secret, { ...claims, sessionId: '' }))
})

test('相对路径编码/解码拒绝穿越与非法段', () => {
  const encoded = encodeRelative('lessons/01 导数.html')
  assert.equal(encoded, 'lessons/01%20%E5%AF%BC%E6%95%B0.html')
  assert.equal(decodeRelative(encoded.split('/')), 'lessons/01 导数.html')
  assert.equal(decodeRelative(['..']), null)
  assert.equal(decodeRelative(['a', '', 'b']), null)
  assert.equal(decodeRelative(['a%2Fb']), 'a/b')
  assert.equal(decodeRelative(['%E0%A4%A']), null)
})
