/* 追加式事务日志：一行一个提交单元，带序号、版本和哈希链。
 *
 * 读日志只接受完整行。最后一行写了一半（进程被杀/断电）时，前面的提交仍有效，
 * 但打开档案会明确报错并指出文件与行号，不会静默忽略；修复必须显式调用
 * repairPartialTail()，它先整份备份，再只删掉最后那个不完整片段。 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JournalCorruptionError } from './errors.js'
import { acquireLock } from './lock.js'
import { appendLine, assertPlainFile, atomicWrite, backupArchiveFiles, ensureRealDir, hashJson, nowIso, randomId } from './util.js'

export const JOURNAL_VERSION = 1

export function journalDir(archiveDir) {
  return path.join(archiveDir, 'journal')
}

export function journalFiles(archiveDir) {
  const dir = journalDir(archiveDir)
  let names
  try {
    const stat = fs.lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new JournalCorruptionError('日志目录不允许符号链接：' + dir)
    names = fs.readdirSync(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return names
    .filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
    .sort()
    .map((name) => path.join(dir, name))
}

function entryPayload(entry) {
  return {
    v: entry.v,
    seq: entry.seq,
    revision: entry.revision,
    at: entry.at,
    id: entry.id,
    actor: entry.actor,
    changes: entry.changes,
    prevHash: entry.prevHash
  }
}

export function hashEntry(entry) {
  return hashJson(entryPayload(entry))
}

function corrupt(file, line, message, extra) {
  return new JournalCorruptionError(message, { file, line, ...extra })
}

/** 校验一条已解析的记录；失败给出可定位的错误。 */
export function validateEntry(entry, expected, file, line) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw corrupt(file, line, `日志第 ${line} 行不是对象：${file}`)
  }
  if (entry.v !== JOURNAL_VERSION) {
    throw corrupt(file, line, `日志第 ${line} 行版本 ${String(entry.v)} 不支持（期望 ${JOURNAL_VERSION}）：${file}`, { version: entry.v })
  }
  if (!Number.isInteger(entry.seq) || entry.seq !== expected.seq + 1) {
    throw corrupt(file, line, `日志第 ${line} 行序号不连续（期望 ${expected.seq + 1}，实际 ${String(entry.seq)}）：${file}`, { seq: entry.seq })
  }
  if (!Number.isInteger(entry.revision) || entry.revision !== expected.revision + 1) {
    throw corrupt(file, line, `日志第 ${line} 行版本不连续（期望 ${expected.revision + 1}，实际 ${String(entry.revision)}）：${file}`, {
      revision: entry.revision
    })
  }
  if (typeof entry.prevHash !== 'string' || entry.prevHash !== expected.hash) {
    throw corrupt(file, line, `日志第 ${line} 行哈希链断裂：${file}`, { prevHash: entry.prevHash, expected: expected.hash })
  }
  if (!Array.isArray(entry.changes) || entry.changes.length === 0) {
    throw corrupt(file, line, `日志第 ${line} 行没有变更内容：${file}`)
  }
  const actual = hashEntry(entry)
  if (entry.hash !== actual) {
    throw corrupt(file, line, `日志第 ${line} 行内容哈希不符（可能被改动）：${file}`, { expected: actual, actual: entry.hash })
  }
  return entry
}

/**
 * 读出全部记录。任何完整行不合法都立即抛错。
 * @returns {{entries: object[], lastSeq: number, lastHash: string, revision: number}}
 */
export function readJournal(archiveDir) {
  const entries = []
  let expected = { seq: 0, revision: 0, hash: 'genesis' }
  for (const file of journalFiles(archiveDir)) {
    let text
    try {
      assertPlainFile(file)
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      throw corrupt(file, 0, `读不到日志文件：${file}（${error.message}）`, { cause: String(error) })
    }
    if (text.length === 0) continue
    const lines = text.split('\n')
    const trailingNewline = text.endsWith('\n')
    if (!trailingNewline) {
      const last = lines[lines.length - 1]
      throw new JournalCorruptionError(
        `日志最后一行没有写完（${file} 第 ${lines.length} 行，${Buffer.byteLength(last, 'utf8')} 字节）。先备份并显式修复，不要直接删文件。`,
        { kind: 'partial-tail', file, line: lines.length, fragment: last.slice(0, 200) }
      )
    }
    const complete = lines.slice(0, -1)
    for (let index = 0; index < complete.length; index += 1) {
      const raw = complete[index]
      if (raw.length === 0) continue
      let entry
      try {
        entry = JSON.parse(raw)
      } catch (error) {
        throw corrupt(file, index + 1, `日志第 ${index + 1} 行不是合法 JSON（可能损坏）：${file}`, { cause: String(error) })
      }
      validateEntry(entry, expected, file, index + 1)
      entries.push(entry)
      expected = { seq: entry.seq, revision: entry.revision, hash: entry.hash }
    }
  }
  return { entries, lastSeq: expected.seq, lastHash: expected.hash, revision: expected.revision }
}

/** 追加一个提交单元；调用方必须持锁。 */
export function appendJournal(archiveDir, { seq, revision, actor, changes, at = nowIso() }) {
  const dir = journalDir(archiveDir)
  ensureRealDir(dir)
  const latestMonth = path.basename(journalFiles(archiveDir).at(-1) ?? '').slice(0, 7)
  const month = at.slice(0, 7) < latestMonth ? latestMonth : at.slice(0, 7)
  const file = path.join(dir, `${month}.jsonl`)
  const previous = readJournal(archiveDir)
  if (previous.lastSeq !== seq - 1) {
    throw new JournalCorruptionError(`写入前序号不一致：日志最后是 ${previous.lastSeq}，这次是 ${seq}`, { file })
  }
  const entry = {
    v: JOURNAL_VERSION,
    seq,
    revision,
    at,
    id: randomId('txn'),
    actor,
    changes,
    prevHash: previous.lastHash
  }
  entry.hash = hashEntry(entry)
  appendLine(file, JSON.stringify(entry))
  return entry
}

/**
 * 显式修复「最后一行没写完」。
 * 只处理 partial-tail；其它损坏拒绝修，避免吞掉有价值的记录。
 * 修复前把整个档案目录复制到 backups/<stamp>/。
 */
export function repairPartialTail(archiveDir) {
  const lock = acquireLock(archiveDir, { label: 'repair-tail' })
  try {
    return repairPartialTailLocked(archiveDir)
  } finally {
    lock.release()
  }
}

function repairPartialTailLocked(archiveDir) {
  const files = journalFiles(archiveDir)
  if (files.length === 0) return { repaired: false, reason: '没有日志' }
  const lastFile = files[files.length - 1]
  const text = fs.readFileSync(lastFile, 'utf8')
  if (text.endsWith('\n')) return { repaired: false, reason: '最后一行是完整的' }
  const cut = text.lastIndexOf('\n')
  const validText = cut === -1 ? '' : text.slice(0, cut + 1)
  // 先在一份临时副本上确认截断后整份日志仍能通过校验，再备份和写回。
  // 临时目录放在系统 temp，避免把 probe 放进 archive/backups 里自我递归。
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-repair-'))
  try {
    fs.mkdirSync(path.join(probeDir, 'journal'), { recursive: true })
    for (const file of files) {
      const target = path.join(probeDir, 'journal', path.basename(file))
      fs.writeFileSync(target, file === lastFile ? validText : fs.readFileSync(file), 'utf8')
    }
    readJournal(probeDir)
  } catch (error) {
    fs.rmSync(probeDir, { recursive: true, force: true })
    throw new JournalCorruptionError(`不能自动修复：截掉半行后日志仍不合法（${error.message}）`, { file: lastFile })
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true })
  }
  const backup = backupArchiveFiles(archiveDir, 'repair')
  atomicWrite(lastFile, validText)
  return { repaired: true, file: lastFile, backup, removedBytes: Buffer.byteLength(text.slice(cut + 1), 'utf8') }
}

/** 给诊断用：不改文件，只报告最后一行是否完整。 */
export function inspectJournal(archiveDir) {
  const files = journalFiles(archiveDir)
  if (files.length === 0) return { files: 0, partialTail: false }
  const lastFile = files[files.length - 1]
  const text = fs.readFileSync(lastFile, 'utf8')
  const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  let complete = false
  try {
    readJournal(archiveDir)
    complete = true
  } catch {
    complete = false
  }
  return { files: files.length, lastFile, lines, partialTail: !text.endsWith('\n') && text.length > 0, complete }
}
