/* 档案的底层小工具：稳定序列化、哈希、原子写、路径包含检查。
 * 这些函数不持有状态，方便单测和恢复脚本复用。 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ValidationError } from './errors.js'

/** 稳定 JSON：对象键排序，保证同样的内容哈希一致。
 * 必须与 JSON.stringify 的取舍一致：对象里 undefined/函数/符号字段省略，
 * 数组里这些值变成 null。否则写入前的哈希与读回后的哈希会不同。 */
export function canonicalJson(value) {
  const omit = (item) => item === undefined || typeof item === 'function' || typeof item === 'symbol'
  const walk = (item) => {
    if (item === null) return 'null'
    if (typeof item === 'object') {
      if (Array.isArray(item)) return '[' + Array.from(item, (child) => (omit(child) ? 'null' : walk(child))).join(',') + ']'
      const keys = Object.keys(item).filter((key) => !omit(item[key])).sort()
      return '{' + keys.map((key) => JSON.stringify(key) + ':' + walk(item[key])).join(',') + '}'
    }
    return JSON.stringify(item) ?? 'null'
  }
  return walk(value)
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function hashJson(value) {
  return sha256(canonicalJson(value))
}

export function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`
}

export function nowIso(now) {
  return new Date(now ?? Date.now()).toISOString()
}

/** 真实路径必须在根内；根自己先 realpath。不跟随越界符号链接。 */
export function assertInside(root, target, label = 'path') {
  const realRoot = fs.realpathSync.native(root)
  let realTarget
  try {
    realTarget = fs.realpathSync.native(target)
  } catch (error) {
    throw new ValidationError(`${label} 不存在或无法解析：${target}`, { target })
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new ValidationError(`${label} 落在工作区外：${realTarget}`, { target, root: realRoot })
  }
  return realTarget
}

/**
 * 把一个页面里的相对引用解析成 root 内的真实文件。
 * 工作区内缺失返回 null（缺失由各调用方自己决定要不要报）；
 * 越界（含指向工作区外的缺失路径、符号链接逃逸）一律抛 ValidationError——
 * 发布链与 lint 必须用同一个判定，否则会出现「lint 全绿、commit 才被拒」。
 */
function realpathOr(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return target
  }
}

export function resolveInside(root, baseDir, raw, label = '课程资源') {
  // 两边都取真实路径再比：macOS 的 /var 与 /private/var 指向同一处，混着比会把工作区内的路径当成越界。
  const realRoot = fs.realpathSync.native(root)
  // baseDir 也必须是真实路径：调用方可能传 /var/... 而 root 已经 realpath 成 /private/var/...
  const realBase = realpathOr(baseDir)
  const absolute = path.resolve(realBase, raw)
  let real
  try {
    real = fs.realpathSync.native(absolute)
  } catch {
    // 不存在的路径没法 realpath：父目录取真实路径后按纯路径判断是否越界，工作区内的缺失只跳过。
    const lexical = path.relative(realRoot, path.join(realpathOr(path.dirname(absolute)), path.basename(absolute)))
    if (lexical.startsWith('..') || path.isAbsolute(lexical)) {
      throw new ValidationError(`${label}不在工作区内：${raw}`, { raw })
    }
    return null
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new ValidationError(`${label}不在工作区内：${raw}`, { raw })
  }
  return real
}

/** 只创建真实的目录；已经存在但为符号链接时拒绝，避免把档案写到别处。 */
export function ensureRealDir(dir) {
  try {
    const stat = fs.lstatSync(dir)
    if (stat.isSymbolicLink()) throw new ValidationError(`档案结构里不允许符号链接：${dir}`, { dir })
    if (!stat.isDirectory()) throw new ValidationError(`需要目录但这里是文件：${dir}`, { dir })
    return
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const parent = path.dirname(dir)
  if (parent !== dir) ensureRealDir(parent)
  try {
    fs.mkdirSync(dir, { mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    ensureRealDir(dir)
  }
}

/** 写临时文件、fsync、原子替换；目标已存在也会被替换。 */
export function atomicWrite(file, text, { mode = 0o600 } = {}) {
  const dir = path.dirname(file)
  const temp = path.join(dir, `.dsh-teach-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`)
  try {
    const fd = fs.openSync(temp, 'wx', mode)
    try {
      fs.writeFileSync(fd, text, 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(temp, file)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

/** 追加一行并 fsync；调用方负责 JSON 合法性。 */
export function appendLine(file, line) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1) throw new ValidationError('日志必须是无硬链接的普通文件：' + file)
    fs.writeFileSync(fd, line.endsWith('\n') ? line : line + '\n', 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function readJson(file, options) {
  assertPlainFile(file, options)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 档案内部文件不能通过软/硬链接指向其它位置。不存在仍保留 ENOENT。 */
export function assertPlainFile(file, { allowHardLinks = false } = {}) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || (!allowHardLinks && stat.nlink !== 1)) {
    throw new ValidationError('档案需要无符号链接/硬链接的普通文件：' + file)
  }
}

/**
 * 把档案目录（.dsh-teach-me/archive）里的权威文件整份复制到 backups/<时间戳>-<label>/。
 * 排除 backups 自己，避免备份套备份无限递归。迁移和修复前都要先调用它。
 */
export function backupArchiveFiles(archiveDir, label) {
  const dest = path.join(archiveDir, 'backups', stamp() + '-' + label)
  ensureRealDir(dest)
  for (const name of fs.readdirSync(archiveDir)) {
    if (name === 'backups') continue
    fs.cpSync(path.join(archiveDir, name), path.join(dest, name), { recursive: true, force: true })
  }
  return dest
}

/** 生成人类可读的时间戳目录名，避免冒号。 */
export function stamp(date = Date.now()) {
  return new Date(date).toISOString().replace(/[:.]/g, '-')
}

/**
 * 工具返回值的出口整形：深拷贝并丢掉 null / undefined 的对象属性，数组与 false、0 原样保留。
 *
 * 宿主按工具声明的 output.schema 严格校验返回值（additionalProperties:false、类型必须对），
 * 而它的校验器只认单值 type，不支持 `type: ['string','null']`。档案操作里「没有就写 null」的
 * 字段（material.url、grade_open.model、nextDueAt…）会在到达模型前被判成不合规，把一次成功
 * 的写入报成 invalid output —— 2026-10 的真实测试会话里 8 次假失败就是这么来的。
 * 统一在工具出口剪掉空值：缺字段比 null 字段更贴近「这次没有」的语义，也让 schema 不必为
 * 可空性发愁。
 */
export function pruneEmpty(value) {
  if (Array.isArray(value)) {
    return value.map((item) => pruneEmpty(item)).filter((item) => item !== undefined)
  }
  if (value === null || typeof value !== 'object') return value
  const pruned = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue
    const next = pruneEmpty(item)
    if (next !== undefined) pruned[key] = next
  }
  return pruned
}
