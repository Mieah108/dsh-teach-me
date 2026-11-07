/* 高频阅读数据不写入掌握证据日志。每个集合/课程/内容版本独立原子文件，沿用档案锁。 */
import fs from 'node:fs'
import path from 'node:path'
import { acquireLock } from './lock.js'
import { atomicWrite, ensureRealDir, hashJson, readJson } from './util.js'
import { ValidationError } from './errors.js'

const keyOf = ({ workspaceId, collectionId = 'default', lessonId, contentVersion }) => hashJson({ workspaceId, collectionId, lessonId, contentVersion })
export function readReading(archive, identity) {
  const file = path.join(archive.path, 'reading', keyOf(identity) + '.json')
  try { return readJson(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
export function saveReading(archive, identity, input, { now = Date.now() } = {}) {
  if (!identity.contentVersion) throw new ValidationError('此课还没有固定内容版本，请先在选课页初始化教学集合')
  const ratio = input?.ratio
  const position = input?.position
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1 || !Number.isFinite(position?.ratio) || position.ratio < 0 || position.ratio > 1) throw new ValidationError('阅读位置必须在 0–100% 之间')
  const activeAt = Number(input.activeAt)
  const sequence = Number(input.sequence)
  if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isFinite(activeAt) || activeAt > now + 5000 || activeAt < 0) throw new ValidationError('无效阅读事件')
  const lock = acquireLock(archive.path, { label: 'reading-progress' })
  try {
    const previous = readReading(archive, identity)
    if (input.active !== true) return previous
    const windowId = identity.windowId
    const windows = { ...(previous?.windows ?? {}) }
    if ((windows[windowId] ?? -1) >= sequence) return previous
    windows[windowId] = sequence
    // 续读位置按实际用户交互时间归并；迟到的后台/旧窗口消息不会抢占位置。
    const ownsPosition = !previous || activeAt > previous.activeAt || (activeAt === previous.activeAt && windowId === previous.windowId)
    const next = { version: 1, maxRatio: Math.max(previous?.maxRatio ?? 0, ratio),
      position: ownsPosition ? { ratio: position.ratio, section: typeof position.section === 'string' ? position.section.slice(0, 200) : '', offset: Math.max(0, Math.min(1, Number(position.offset) || 0)) } : previous.position,
      activeAt: ownsPosition ? activeAt : previous.activeAt, windowId: ownsPosition ? windowId : previous.windowId,
      windows: Object.fromEntries(Object.entries(windows).slice(-64)), updatedAt: new Date(now).toISOString() }
    const dir = path.join(archive.path, 'reading')
    ensureRealDir(dir)
    atomicWrite(path.join(dir, keyOf(identity) + '.json'), JSON.stringify(next) + '\n')
    return next
  } finally { lock.release() }
}
export function readingSummary(items) {
  return { percent: items.length ? Math.round(items.reduce((sum, item) => sum + (item?.maxRatio ?? 0), 0) / items.length * 100) : 0,
    count: items.length, unrecorded: items.filter((item) => item === null).length }
}
