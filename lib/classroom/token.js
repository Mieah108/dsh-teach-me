/* 课堂能力票：URL 里携带的、可验证的短期授权。
 *
 * 课堂 iframe 是 sandbox 的 opaque origin，不能依赖宿主 Cookie 当唯一认证；
 * 这里把「哪个工作区、哪条会话、哪节课、哪个 revision」签进 URL，服务端每次
 * 重新验签并按已发布清单校验资源。密钥只在进程内，重启后旧链接自然失效。 */

import crypto from 'node:crypto'

export const TOKEN_VERSION = 1
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000

const SEGMENT = /^[A-Za-z0-9_-]+$/

function b64url(value) {
  return Buffer.from(value).toString('base64url')
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

function safeEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** 创建一个进程级密钥；每个宿主实例独立。 */
export function createSecret() {
  return crypto.randomBytes(32)
}

/**
 * 签发一张能力票。claims 必须包含工作区绝对路径、会话、课程与 revision；
 * 其余字段由服务端补全。返回 token 字符串。
 */
export function issueToken(secret, claims, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!(secret instanceof Uint8Array) || secret.length < 16) throw new Error('classroom: token secret is too short')
  if (typeof claims?.root !== 'string' || claims.root.length === 0) throw new Error('classroom: token needs workspace root')
  if (typeof claims?.workspaceId !== 'string' || claims.workspaceId.length === 0) throw new Error('classroom: token needs workspaceId')
  if (typeof claims?.sessionId !== 'string' || claims.sessionId.length === 0) throw new Error('classroom: token needs sessionId')
  if (typeof claims?.lessonId !== 'string' || claims.lessonId.length === 0) throw new Error('classroom: token needs lessonId')
  if (!Number.isInteger(claims?.revision) || claims.revision < 1) throw new Error('classroom: token needs lesson revision')
  const payload = {
    v: TOKEN_VERSION,
    purpose: 'classroom',
    root: claims.root,
    workspaceId: claims.workspaceId,
    sessionId: claims.sessionId,
    lessonId: claims.lessonId,
    revision: claims.revision,
    ...(claims.collectionId ? { collectionId: claims.collectionId } : {}),
    ...(claims.contentVersion ? { contentVersion: claims.contentVersion } : {}),
    nonce: crypto.randomBytes(12).toString('base64url'),
    exp: now + ttlMs
  }
  const encoded = b64url(JSON.stringify(payload))
  const signature = sign(secret, encoded)
  return { token: encoded + '.' + signature, payload, expiresAt: new Date(payload.exp).toISOString() }
}

function decodePayload(encoded) {
  const text = Buffer.from(encoded, 'base64url').toString('utf8')
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
  return value
}

/**
 * 校验一张能力票。返回 {ok:true,claims} 或 {ok:false,code}。
 * code：bad-format / bad-signature / expired / bad-claims。
 */
export function verifyToken(secret, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length === 0) return { ok: false, code: 'bad-format' }
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return { ok: false, code: 'bad-format' }
  const encoded = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (!SEGMENT.test(encoded) || !SEGMENT.test(signature)) return { ok: false, code: 'bad-format' }
  const expected = sign(secret, encoded)
  if (!safeEqual(signature, expected)) return { ok: false, code: 'bad-signature' }
  let claims
  try {
    claims = decodePayload(encoded)
  } catch {
    return { ok: false, code: 'bad-format' }
  }
  if (claims.v !== TOKEN_VERSION || claims.purpose !== 'classroom') return { ok: false, code: 'bad-claims' }
  if (typeof claims.root !== 'string' || typeof claims.workspaceId !== 'string') return { ok: false, code: 'bad-claims' }
  if (typeof claims.sessionId !== 'string' || typeof claims.lessonId !== 'string') return { ok: false, code: 'bad-claims' }
  if (!Number.isInteger(claims.revision) || claims.revision < 1) return { ok: false, code: 'bad-claims' }
  if (typeof claims.nonce !== 'string' || claims.nonce.length < 8) return { ok: false, code: 'bad-claims' }
  if (claims.collectionId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(claims.collectionId)) return { ok: false, code: 'bad-claims' }
  if (claims.contentVersion !== undefined && !/^[0-9a-f]{64}$/.test(claims.contentVersion)) return { ok: false, code: 'bad-claims' }
  if (!Number.isFinite(claims.exp) || claims.exp <= now) return { ok: false, code: 'expired' }
  return { ok: true, claims }
}

/** 把工作区相对路径编码成 URL 的一段（保留 / 分隔）。 */
export function encodeRelative(relative) {
  return String(relative)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/** URL 段解码；拒绝空段/点段/反斜杠/NUL。 */
export function decodeRelative(parts) {
  const decoded = []
  for (const part of parts) {
    let value
    try {
      value = decodeURIComponent(part)
    } catch {
      return null
    }
    if (value === '' || value === '.' || value === '..' || value.includes('\\') || value.includes('\0')) return null
    decoded.push(value)
  }
  return decoded.join('/')
}
