/* G3 派生缓存；不替代 journal。调用方先完成完整日志链校验，写入方必须持档案锁。 */
import fs from 'node:fs'
import path from 'node:path'
import { emptyState, SCHEMA_VERSION } from './state.js'
import { atomicWrite, hashJson, nowIso, readJson, sha256 } from './util.js'

const FILE = 'snapshot.json'
const VERSION = 1
// 领域与重放实现变化即使 schema 没变也会使旧快照失效。
const PROJECTOR = hashJson(['state.js', 'store.js', 'snapshot.js'].map((file) => sha256(fs.readFileSync(new URL(file, import.meta.url)))))

export function writeSnapshot(archiveDir, state, tolerated) {
  const payload = {
    version: VERSION, projector: PROJECTOR, workspaceId: state.workspaceId,
    seq: state.lastSeq, revision: state.revision, hash: state.lastHash,
    createdAt: nowIso(), state, tolerated
  }
  atomicWrite(path.join(archiveDir, FILE), JSON.stringify({ ...payload, checksum: hashJson(payload) }) + '\n')
  return { file: path.join(archiveDir, FILE), seq: payload.seq, revision: payload.revision, hash: payload.hash }
}

export function readSnapshot(archiveDir, workspaceId, journal) {
  try {
    const snapshot = readJson(path.join(archiveDir, FILE))
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('格式不合法')
    const { checksum, ...payload } = snapshot
    if (payload.version !== VERSION || payload.projector !== PROJECTOR) throw new Error('格式或投影器版本不匹配')
    if (checksum !== hashJson(payload)) throw new Error('校验和不匹配')
    if (payload.workspaceId !== workspaceId || !Number.isInteger(payload.seq) || payload.seq < 1 || payload.seq > journal.lastSeq) throw new Error('身份或水位不匹配')
    const anchor = journal.entries[payload.seq - 1]
    if (anchor?.seq !== payload.seq || anchor.hash !== payload.hash || anchor.revision !== payload.revision) throw new Error('前缀锚点不匹配')
    const state = payload.state
    if (!state || state.schemaVersion !== SCHEMA_VERSION || state.workspaceId !== workspaceId ||
        state.lastSeq !== payload.seq || state.revision !== payload.revision || state.lastHash !== payload.hash ||
        !Array.isArray(payload.tolerated)) throw new Error('投影元数据不匹配')
    const maps = Object.entries(emptyState()).filter(([, value]) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === null).map(([key]) => key)
    for (const key of [...maps, 'runs', 'animationJobs']) {
      if (state[key] === undefined && !maps.includes(key)) continue
      if (state[key] === null || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new Error('投影字典不合法：' + key)
      Object.setPrototypeOf(state[key], null)
    }
    return { state, tolerated: payload.tolerated, seq: payload.seq, reason: null }
  } catch (error) {
    return { state: null, reason: error?.code === 'ENOENT' ? 'missing' : String(error.message) }
  }
}
