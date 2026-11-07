/* 跨进程文件锁：同一工作区同一时间只允许一个写入者。
 *
 * 拿不到锁时先看现有锁是谁的：
 *  - 同一台机器且进程已经不在：独占回收围栏内重读锁，确认后删除，再重试；
 *  - 进程还活着、别的机器、或无法判断：抛 LockHeldError，告诉调用方谁占着，不盲目抢。
 * 这样崩溃留下的锁能恢复，而一个正在写长事务的进程不会被误抢。
 *
 * 0.6.4-D4 起这一份实现被两个调用方共用：
 *  - 档案写锁 acquireLock(archiveDir)：锁在 <archiveDir>/locks/workspace.lock；
 *  - 动画渲染锁 acquireAnimationLock(projectRoot)（lib/animation.js）：锁在工程根下的
 *    .dsh-teach/locks/render.lock，键 = 工程根 realpath。
 * 通用入口是 acquirePathLock，语义完全一致（wx + pid 判活 + 回收围栏），只是锁目录、
 * 锁文件名与锁内附加字段由调用方决定 —— 不是为了动画另写一份互斥，也不是在工程根伪造
 * 档案身份文件。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LockHeldError, ValidationError } from './errors.js'
import { assertPlainFile, atomicWrite, ensureRealDir, randomId } from './util.js'

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    return undefined
  }
}

function describeLock(info) {
  if (info === null || info === undefined) return '未知进程'
  return `pid ${info.pid} @ ${info.host}（自 ${info.startedAt ?? '?'}）`
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 锁可在另一进程释放时被解绑；APFS 的 lstat 此时可能返回 nlink=0。 */
function readLockText(file) {
  try {
    const stat = fs.lstatSync(file)
    if (stat.isFile() && stat.nlink === 0) return null
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new ValidationError('档案需要无符号链接/硬链接的普通文件：' + file)
    }
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** 只读检查当前锁；没有锁返回 null。name 默认是档案写锁的文件名。 */
export function inspectLock(lockDir, name = 'workspace.lock') {
  const file = path.join(lockDir, name)
  const raw = readLockText(file)
  if (raw === null) return null
  let info = null
  try {
    info = JSON.parse(raw)
  } catch {
    info = { corrupt: true, rawPreview: raw.slice(0, 200) }
  }
  return { file, info, raw }
}

function readLock(file) {
  const raw = readLockText(file)
  if (raw === null) return null
  let info
  try {
    info = JSON.parse(raw)
  } catch {
    info = { corrupt: true }
  }
  return { raw, info }
}

/** 回收者本身也互斥，防止两个回收者一起删掉后来者的新锁。
 * 若回收进程在此临界区崩溃，保留回收锁并明确阻断，不冒险递归抢锁。 */
function reclaimStale(lockDir, file, snapshot, name) {
  const guard = path.join(lockDir, name + '.reclaim')
  if (!createLockFile(guard, { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() })) return false
  try {
    const current = readLock(file)
    if (current === null) return true
    if (current.raw !== snapshot.raw) return false
    if (current.info?.host !== os.hostname() || processAlive(current.info?.pid) !== false) return false
    fs.unlinkSync(file)
    return true
  } finally {
    fs.unlinkSync(guard)
  }
}

function createLockFile(file, info) {
  let fd
  try {
    fd = fs.openSync(file, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(info, null, 2) + '\n', 'utf8')
    fs.fsyncSync(fd)
  } catch (error) {
    fs.unlinkSync(file)
    throw error
  } finally {
    fs.closeSync(fd)
  }
  return true
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * 通用跨进程文件锁：wx 建锁文件 + 同机 pid 判活 + 只回收确认死掉的持锁者。
 *
 * 与档案写锁是同一份逻辑（本函数就是它的实现），区别只在参数：
 * 锁目录、锁文件名、锁内附加字段（例如动画作业的 jobId / mode / composition）与
 * 报错文案里的主体（「工作区」/「动画工程」）由调用方给。
 *
 * @param {string} lockDir 放锁文件的目录（不存在会创建；结构里不允许符号链接）
 * @param {object} [options]
 * @param {number} [options.timeoutMs] 等锁上限（默认 3000；0 = 只试一次）
 * @param {number} [options.pollMs] 轮询间隔
 * @param {string} [options.label] 锁内 label（谁在锁）
 * @param {string} [options.name] 锁文件名（默认 workspace.lock）
 * @param {object} [options.info] 锁内附加字段（pid/时间/owner 由本函数写）
 * @param {string} [options.subject] 报错文案里的主体（默认「工作区」）
 * @param {() => void} [options.precondition] 每次尝试前的前置校验（档案用它确认身份文件还在）
 * @returns {{file: string, owner: string, info: object, update: Function, relocate: Function, release: Function}}
 */
export function acquirePathLock(lockDir, {
  timeoutMs = 3000,
  pollMs = 25,
  label = 'write',
  name = 'workspace.lock',
  info: extraInfo = {},
  subject = '工作区',
  precondition
} = {}) {
  const precheck = () => {
    if (typeof precondition === 'function') precondition()
  }
  precheck()
  // 目录若已被迁移/删除，不能为了拿锁重建一份空旧档案（档案由 precondition 负责）。
  ensureRealDir(lockDir)
  let file = path.join(lockDir, name)
  const owner = randomId('owner')
  let deadline = Date.now() + timeoutMs
  let reclaimed = false

  do {
    precheck()
    const info = {
      owner,
      ...extraInfo,
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
      label
    }
    if (!fs.existsSync(path.join(lockDir, name + '.reclaim')) && createLockFile(file, info)) {
      let released = false
      const acquired = {
        file,
        owner,
        info,
        /**
         * 回填锁内信息（只有持锁者能改）。动画渲染用它把 jobId 补进去：
         * 拿锁时 job id 还没生成，但「谁在跑」要说得清。
         * @param {object} patch 要覆盖的字段
         * @returns {boolean} 是否真的写了（锁已经被别人接管时 false）
         */
        update(patch) {
          if (!isPlainObject(patch)) throw new Error('锁信息补丁必须是对象')
          const current = readLock(file)
          if (current === null || current.info?.owner !== owner) return false
          const merged = { ...acquired.info, ...patch }
          // 原子替换：另一个进程可能正在读锁文件，不能让它读到半份 JSON。
          atomicWrite(file, JSON.stringify(merged, null, 2) + '\n')
          acquired.info = merged
          return true
        },
        relocate(dir) { file = path.join(dir, name) },
        release() {
          if (released) return
          released = true
          const current = readLock(file)
          if (current !== null && current.info?.owner === owner) fs.rmSync(file, { force: true })
        }
      }
      return acquired
    }

    const current = readLock(file)
    if (current === null) {
      if (Date.now() >= deadline) break
      sleepMs(pollMs)
      continue
    }

    const holder = current.info ?? {}
    const sameHost = holder.host === os.hostname()
    const alive = sameHost ? processAlive(holder.pid) : undefined
    const canReclaim = sameHost && alive === false && reclaimed === false
    if (canReclaim) {
      reclaimed = true
      const removed = reclaimStale(lockDir, file, current, name)
      if (!removed) {
        throw new LockHeldError(
          `锁文件刚被别的进程更新，不能安全回收：${describeLock(holder)}。稍后重试。`,
          { holder }
        )
      }
      // 回收成功后必须至少再尝试一次：timeoutMs=0（渲染互斥要立刻说不）时
      // 原截止时间已经到了，不延长就等于「回收完却不拿锁」。
      deadline = Math.max(deadline, Date.now() + pollMs)
      continue
    }

    if (Date.now() >= deadline) break
    sleepMs(pollMs)
  } while (Date.now() <= deadline)

  const current = readLock(file)
  const recoveryPending = fs.existsSync(path.join(lockDir, name + '.reclaim'))
  if (current === null) {
    // 零等待下的良性竞态：上一刻的锁刚好被释放/回收，读取瞬间文件已不在。
    throw new LockHeldError(`${subject}的锁文件刚被另一个进程释放，这不是被占用：重试一次即可。`, { holder: null })
  }
  throw new LockHeldError(
    recoveryPending ? `锁回收围栏仍存在（${name}.reclaim）；确认没有回收进程运行后再显式处理，不能自动抢占。` : `${subject}正被另一个写入者占用：${describeLock(current?.info)}。等它结束后重试；不要直接删锁文件。`,
    { holder: current?.info ?? null }
  )
}

/**
 * 取得档案写锁。返回 {dir, file, owner, release()}。
 * @param {string} archiveDir 档案目录（.dsh-teach-me/archive）
 * @param {{timeoutMs?: number, pollMs?: number, label?: string}} [options]
 */
export function acquireLock(archiveDir, { timeoutMs = 3000, pollMs = 25, label = 'write' } = {}) {
  // 目录若已被迁移/删除，不能为了拿锁重建一份空旧档案。
  const marker = path.join(archiveDir, 'workspace.json')
  const precondition = () => assertPlainFile(marker, { allowHardLinks: true })
  precondition()
  const lock = acquirePathLock(path.join(archiveDir, 'locks'), { timeoutMs, pollMs, label, precondition })
  // 档案目录整体迁移（.teach → .dsh-teach-me/archive）时锁文件跟着走。
  return {
    ...lock,
    relocate(dir) {
      lock.relocate(path.join(dir, 'locks'))
    }
  }
}
