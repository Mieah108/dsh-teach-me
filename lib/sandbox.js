/* 权限围栏：插件被允许动的东西，只有用户在设置里指定的那一个工程目录。
 *
 * 为什么自己做围栏：DSH 的沙箱按会话工作区判写权限，而动画工程在会话工作区之外
 * （见 ADR-0008）。插件在宿主进程里跑，不受文件沙箱约束，所以「只写这里、别处一律不碰」
 * 必须由本文件保证，不能指望调用它的模型自觉。
 *
 * 闸门：
 *  1. 根目录本身先 realpath 规范化（工程路径里若有软链，按真实位置算）；
 *  2. 相对路径先做词法检查（绝对路径、点段、NUL 一律拒），再逐段 lstat：
 *     断链、指向根外的软链一律拒；不存在的尾部视为待创建；
 *  3. 写入只允许白名单里的子树与扩展名，黑名单优先（node_modules、.git、包清单）；
 *  4. 写入走「同目录临时文件 + fsync + rename」，不跟随最终路径上的软链；
 *     已存在的文件若是硬链接（nlink > 1）或软链，直接拒。
 *
 * TOCTOU 边界：逐段校验与 mkdir/rename 之间，别的进程仍可能把中间目录换成软链。
 * 本文件在 mkdir 之后、rename 之前重新校验一次父目录，把窗口压到最小；
 * 彻底消除需要 openat/O_NOFOLLOW 一类的目录句柄 API，Gate A 会记录这项残余风险。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** 围栏拒绝：message 直接给模型看，说清哪一步被拒、为什么。 */
export class ProjectError extends Error {
  constructor(message, code = 'project-error') {
    super(message)
    this.name = 'ProjectError'
    this.code = code
  }
}

/** 允许写入的子树与文件（相对工程根，斜杠分隔）。 */
const WRITE_ALLOW = [
  { pattern: /^src\/videos\/[^/]+\/[^/]+\/[^/]+\.(tsx?|json|md|css)$/, label: 'src/videos/<类别>/<课程>/<文件>' },
  { pattern: /^src\/videos\/_teach-managed\/[A-Za-z0-9._-]+\.tsx?$/, label: 'src/videos/_teach-managed/<文件>' },
  { pattern: /^src\/Root\.tsx$/, label: 'src/Root.tsx' },
  { pattern: /^out\/[^/]+\/[^/]+\.(mp4|png|json|txt)$/, label: 'out/<类别>/<文件>' },
  {
    pattern:
      /^\.dsh-teach\/managed\/(state\.json|backup-[A-Za-z0-9._-]+\/(Root\.tsx|manifest\.json)|lessons\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.json)$/,
    label: '.dsh-teach/managed/（状态、备份、课程清单）'
  }
]

/** 黑名单优先于白名单。 */
const WRITE_DENY = [
  { pattern: /(^|\/)node_modules(\/|$)/, reason: 'node_modules 是依赖目录，插件不碰' },
  { pattern: /(^|\/)\.git(\/|$)/, reason: '.git 是版本库，插件不碰' },
  { pattern: /^package(-lock)?\.json$/, reason: '包清单归用户管，插件不碰' },
  { pattern: /^(pnpm-lock\.yaml|yarn\.lock)$/, reason: '锁文件归用户管，插件不碰' },
  { pattern: /(^|\/)\.env/, reason: '环境变量文件不碰' }
]

function isInside(root, candidate) {
  if (candidate === root) return true
  const prefix = root.endsWith(path.sep) ? root : root + path.sep
  return candidate.startsWith(prefix)
}

/**
 * 目录必须只装普通文件：软链、子目录、特殊文件一律拒绝。
 * 这是目录级整体替换（swapDir）的前提 —— 只有确认「拿掉这个目录不会连带拿走别的东西」，
 * 才能用一次 rename 换掉它。
 */
function plainDirEntries(dir, rel) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new ProjectError(`目录不存在：${rel}`, 'not-a-directory')
    throw new ProjectError(`读不了目录 ${rel}`, 'unresolvable')
  }
  const out = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) throw new ProjectError(`目录 ${rel} 里有软链 ${entry.name}：拒绝整体替换`, 'symlink-entry')
    if (stat.isDirectory()) throw new ProjectError(`目录 ${rel} 里有子目录 ${entry.name}：拒绝整体替换`, 'nested-dir')
    if (!stat.isFile()) throw new ProjectError(`目录 ${rel} 里有特殊文件 ${entry.name}：拒绝整体替换`, 'unexpected-entry')
    out.push({ name: entry.name, size: stat.size })
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** 删掉一个已确认只含普通文件的目录（调用方已做过 plainDirEntries）。 */
function removePlainDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    fs.rmSync(path.join(dir, entry.name), { force: true })
  }
  fs.rmdirSync(dir)
}

/** 词法检查：相对路径、无点段、无 NUL、不用盘符/协议头。 */
function normalizeRel(rel) {
  if (typeof rel !== 'string' || rel.trim().length === 0) throw new ProjectError('路径不能为空', 'empty-path')
  if (rel.includes('\0')) throw new ProjectError('路径里不允许 NUL 字符', 'bad-path')
  if (path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\\\')) {
    throw new ProjectError(`只接受工程内的相对路径，收到绝对路径：${rel}`, 'absolute-path')
  }
  const parts = rel.split(/[\\/]+/).filter((part) => part.length > 0)
  if (parts.some((part) => part === '.' || part === '..')) {
    throw new ProjectError(`路径里不允许 . 或 ..：${rel}`, 'dot-segment')
  }
  if (parts.length === 0) throw new ProjectError(`路径没有指到文件：${rel}`, 'bad-path')
  return parts
}

function checkWriteAllowed(rel) {
  const deny = WRITE_DENY.find((rule) => rule.pattern.test(rel))
  if (deny !== undefined) throw new ProjectError(`拒绝写入 ${rel}：${deny.reason}`, 'write-denied')
  const allow = WRITE_ALLOW.find((rule) => rule.pattern.test(rel))
  if (allow === undefined) {
    throw new ProjectError(
      `拒绝写入 ${rel}：不在允许的白名单里。可写的位置只有 ${WRITE_ALLOW.map((rule) => rule.label).join('、')}。`,
      'write-not-allowed'
    )
  }
  return allow
}

/**
 * 打开一个工程目录，之后所有读写都必须走返回的句柄。
 * @param {string} rawRoot 设置页或预设行给的绝对路径
 */
export function openProject(rawRoot) {
  if (typeof rawRoot !== 'string' || rawRoot.trim().length === 0) {
    throw new ProjectError('还没有配置动画工程目录（设置 → 插件 → 教学模式 → 动画工程）', 'not-configured')
  }
  const abs = path.resolve(rawRoot.trim())
  let root
  try {
    root = fs.realpathSync.native(abs)
  } catch {
    throw new ProjectError(`动画工程目录不存在：${abs}`, 'root-missing')
  }
  if (!fs.statSync(root).isDirectory()) throw new ProjectError(`动画工程路径不是目录：${root}`, 'root-not-dir')

  /**
   * 逐段检查已存在的组件：软链必须是活的、且真实目标仍在根内。
   * 不存在的一段之后都不存在（后面由 mkdir 创建），到此可以安全返回。
   */
  const walk = (parts, rel) => {
    let current = root
    for (let index = 0; index < parts.length; index += 1) {
      const next = path.join(current, parts[index])
      let stat
      try {
        stat = fs.lstatSync(next)
      } catch (error) {
        if (error?.code === 'ENOENT') return
        if (error?.code === 'ENOTDIR') {
          throw new ProjectError(`路径中间有一段不是目录：${rel}`, 'not-a-directory')
        }
        throw new ProjectError(`读不了路径里的 ${rel}：${error instanceof Error ? error.message : String(error)}`, 'unresolvable')
      }
      if (stat.isSymbolicLink()) {
        let real
        try {
          real = fs.realpathSync.native(next)
        } catch {
          // 断链：写入时 mkdir 会跟着它建到根外，读时会得到 ENOENT；两种都不接受
          throw new ProjectError(`拒绝访问 ${rel}：路径里的软链是断的（${parts.slice(0, index + 1).join('/')}）`, 'symlink-dangling')
        }
        if (!isInside(root, real)) {
          throw new ProjectError(`拒绝访问 ${rel}：路径里的软链指向工程外（${parts.slice(0, index + 1).join('/')}）`, 'symlink-escape')
        }
        current = real
        continue
      }
      if (!stat.isDirectory() && index < parts.length - 1) {
        throw new ProjectError(`路径中间有一段不是目录：${rel}`, 'not-a-directory')
      }
      current = next
    }
  }

  const resolveInside = (rel) => {
    const parts = normalizeRel(rel)
    const lexical = path.resolve(root, ...parts)
    if (!isInside(root, lexical)) throw new ProjectError(`目标落在工程目录之外：${rel}`, 'escape')
    walk(parts, rel)
    return lexical
  }

  /** 已存在的最终文件若是软链或硬链接，写入会改到别处或把链接替换掉：一律拒绝。 */
  const rejectLinkTarget = (file, rel) => {
    let stat
    try {
      stat = fs.lstatSync(file)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw new ProjectError(`读不了目标文件：${rel}`, 'unresolvable')
    }
    if (stat.isSymbolicLink()) {
      throw new ProjectError(`拒绝写入 ${rel}：目标已经是软链；请先人工确认后再改`, 'symlink-target')
    }
    if (stat.isFile() && stat.nlink > 1) {
      throw new ProjectError(`拒绝写入 ${rel}：目标是硬链接（nlink=${stat.nlink}），改写会波及工程外的同一份内容`, 'hardlink-target')
    }
  }

  return {
    root,
    /** 只做词法 + 逐段软链校验，不落盘。 */
    resolveInside,
    /** 工程内的文件是否存在。 */
    exists(rel) {
      try {
        return fs.statSync(resolveInside(rel)).isFile()
      } catch {
        return false
      }
    },
    read(rel, maxBytes = 512 * 1024) {
      const file = resolveInside(rel)
      const stat = fs.statSync(file)
      if (!stat.isFile()) throw new ProjectError(`不是文件：${rel}`, 'not-a-file')
      if (stat.size > maxBytes) throw new ProjectError(`文件太大（${stat.size} 字节）：${rel}`, 'too-large')
      return fs.readFileSync(file, 'utf8')
    },
    /** 写一个允许白名单内的文件；同目录临时文件 + rename，失败不留半成品。 */
    write(rel, text) {
      const file = resolveInside(rel)
      const normalized = path.relative(root, file).split(path.sep).join('/')
      checkWriteAllowed(normalized)
      rejectLinkTarget(file, normalized)
      const parent = path.dirname(file)
      fs.mkdirSync(parent, { recursive: true })
      // mkdir 之后重新校验：新建出来的中间目录必须仍在根内（压小 TOCTOU 窗口）
      resolveInside(normalized)
      const temp = path.join(parent, `.dsh-teach-tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
      let fd
      try {
        fd = fs.openSync(temp, 'wx', 0o600)
        fs.writeFileSync(fd, text, 'utf8')
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        fd = undefined
        fs.renameSync(temp, file)
      } catch (error) {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd)
          } catch {
            // 已经关过
          }
        }
        try {
          fs.rmSync(temp, { force: true })
        } catch {
          // 临时文件可能没建出来
        }
        throw error
      }
      return normalized
    },
    /** 白名单 + 链接检查（不落盘），给 sync 预检用；返回规范化后的相对路径。 */
    checkWritable(rel) {
      const file = resolveInside(rel)
      const normalized = path.relative(root, file).split(path.sep).join('/')
      checkWriteAllowed(normalized)
      rejectLinkTarget(file, normalized)
      return normalized
    },
    /** 只读列目录；目录不存在返回 undefined，不是目录报 not-a-directory。 */
    listDir(rel, limit = 200) {
      const dir = resolveInside(rel)
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') return undefined
        if (error?.code === 'ENOTDIR') throw new ProjectError(`不是目录：${rel}`, 'not-a-directory')
        throw new ProjectError(`读不了目录 ${rel}`, 'unresolvable')
      }
      const out = []
      for (const entry of entries.slice(0, limit)) {
        const full = path.join(dir, entry.name)
        let stat
        try {
          stat = fs.lstatSync(full)
        } catch {
          stat = undefined
        }
        out.push({
          name: entry.name,
          kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
          size: stat !== undefined && stat.isFile() ? stat.size : 0
        })
      }
      out.sort((a, b) => a.name.localeCompare(b.name))
      return out
    },
    /**
     * 目录级原子发布：把同级临时目录整体换成目标目录。
     *
     * 先 write() 把整批内容写进 .dsh-teach-tmp-* 临时目录（每个文件各自原子），
     * 再 rename 目标目录 → 备份名、rename 临时目录 → 目标；两步之间失败就把旧目录 rename 回来。
     * 目标目录里出现 allowNames 之外的内容时拒绝，避免整体替换吞掉用户文件。
     * @param {string} tempRel 临时目录（同级，名字必须 .dsh-teach-tmp- 开头）
     * @param {string} targetRel 目标目录
     * @param {string[]} allowNames 允许被替换掉的旧文件名（插件自己的 + 已复制进新目录的用户文件）
     */
    swapDir(tempRel, targetRel, allowNames = []) {
      const temp = resolveInside(tempRel)
      const target = resolveInside(targetRel)
      if (!path.basename(temp).startsWith('.dsh-teach-tmp-')) {
        throw new ProjectError(`临时目录名必须以 .dsh-teach-tmp- 开头：${tempRel}`, 'not-a-temp-dir')
      }
      if (path.dirname(temp) !== path.dirname(target)) {
        throw new ProjectError('临时目录与目标目录必须同级：只有同级 rename 是原子的', 'not-sibling')
      }
      const allowed = new Set(allowNames)
      const tempEntries = plainDirEntries(temp, tempRel)
      let oldPath
      if (fs.existsSync(target)) {
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink()) throw new ProjectError(`拒绝替换 ${targetRel}：目标是软链`, 'symlink-target')
        if (!stat.isDirectory()) throw new ProjectError(`拒绝替换 ${targetRel}：目标不是目录`, 'not-a-directory')
        for (const entry of plainDirEntries(target, targetRel)) {
          if (!allowed.has(entry.name)) {
            throw new ProjectError(`拒绝替换 ${targetRel}：里面有插件没写过的 ${entry.name}`, 'unexpected-entry')
          }
        }
        oldPath = path.join(path.dirname(target), `.dsh-teach-old-${randomBytes(6).toString('hex')}`)
        fs.renameSync(target, oldPath)
      }
      try {
        fs.renameSync(temp, target)
      } catch (error) {
        if (oldPath !== undefined) {
          try {
            fs.renameSync(oldPath, target)
          } catch {
            // 回滚也失败：目标目录此刻不存在，下面的错误信息会说明
          }
        }
        throw new ProjectError(
          `发布 ${targetRel} 失败：${error instanceof Error ? error.message : String(error)}`,
          'publish-failed'
        )
      }
      if (oldPath !== undefined) {
        try {
          removePlainDir(oldPath)
        } catch {
          // 旧目录没清掉不影响新内容；留一条不致命
        }
      }
      return tempEntries.map((entry) => `${targetRel}/${entry.name}`)
    },
    /** 清理自己建的临时目录：名字必须是 .dsh-teach-tmp-，内容必须全是普通文件。 */
    removeTempDir(rel) {
      const dir = resolveInside(rel)
      if (!path.basename(dir).startsWith('.dsh-teach-tmp-')) {
        throw new ProjectError(`只清理 .dsh-teach-tmp- 临时目录：${rel}`, 'not-a-temp-dir')
      }
      if (!fs.existsSync(dir)) return false
      plainDirEntries(dir, rel)
      removePlainDir(dir)
      return true
    }
  }
}

export { WRITE_ALLOW, WRITE_DENY, isInside, normalizeRel }
