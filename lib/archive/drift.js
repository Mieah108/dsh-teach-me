/* F1：已发布清单与磁盘对账，只读；不把用户未登记的文件称为废弃资产。 */
import fs from 'node:fs'
import path from 'node:path'
import { tryOpenArchive } from './store.js'
import { sha256 } from './util.js'

const MAX_FILES = 10000
const MAX_DEPTH = 16
const posix = (value) => value.split(path.sep).join('/')

/**
 * 共享运行资源：模板运行时的副本（样式/脚本/MathJax），一个工作区里被所有课引用。
 * 它们变化时**不阻断 lint**：改一次样式就要重发所有课的代价与收益不成比例，
 * 报成提醒让作者知道"已发布页面的外观已经变了"即可。页面自己的资产（图片、媒体）仍是硬伤。
 */
const SHARED_RUNTIME = [/^assets\/course\.css$/, /^assets\/course\.js$/, /^assets\/mathjax\//]
const isSharedRuntime = (rel) => SHARED_RUNTIME.some((pattern) => pattern.test(rel))

/** 不跟随任一目录/文件链接。只在工作区内读取普通文件。 */
function plainAsset(root, rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => part === '..' || part.startsWith('.'))) {
    throw new Error('资产路径不安全')
  }
  const parts = rel.split('/')
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('资产路径含链接，未读取')
    if (index < parts.length - 1 ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1)) throw new Error('资产路径不是普通文件')
  }
  return current
}

/** 同步只读快照；state可由调用者提供以复用同一次档案重放。 */
export function inspectAssetDrift(root, options = {}) {
  const workspace = fs.realpathSync.native(root)
  const state = Object.hasOwn(options, 'state') ? options.state : tryOpenArchive(workspace, { repairIndex: false })?.state
  const issues = []
  const add = (rel, level, code, message, extra = {}) => issues.push({ path: rel, level, code, message, ...extra })
  const manifests = new Map()
  for (const lesson of Object.values(state?.lessons ?? {})) {
    for (const asset of lesson.assets ?? []) {
      const key = asset.path
      if (!manifests.has(key)) manifests.set(key, new Set())
      manifests.get(key).add(asset.sha256)
    }
  }
  for (const [rel, hashes] of manifests) {
    try {
      const actual = sha256(fs.readFileSync(plainAsset(workspace, rel)))
      const shared = isSharedRuntime(rel)
      for (const expected of hashes) {
        if (actual !== expected) {
          const code = shared ? 'asset-shared-drift' : 'asset-hash-drift'
          const level = shared ? 'warn' : 'error'
          const message = shared
            ? `共享运行资源已变化：期望 ${expected.slice(0, 8)}，实际 ${actual.slice(0, 8)}（已发布页面外观会跟着变；要固化成快照就重发这些课）`
            : `资产哈希变化：期望 ${expected.slice(0, 8)}，实际 ${actual.slice(0, 8)}`
          add(rel, level, code, message, { expected, actual })
        }
      }
    } catch (error) {
      const code = error?.code === 'ENOENT' ? 'asset-missing' : 'asset-unreadable'
      add(rel, 'error', code, code === 'asset-missing' ? '已发布资产缺失' : '已发布资产无法安全读取：' + error.message)
    }
  }
  let count = 0
  const walk = (rel, depth) => {
    if (depth > MAX_DEPTH || count >= MAX_FILES) {
      add(rel, 'warn', 'asset-scan-limit', '资产扫描达到上限，未登记文件检查不完整')
      return
    }
    const absolute = path.join(workspace, rel)
    let entries
    try {
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        add(rel, 'warn', 'asset-directory-unsafe', '资产目录含链接或不是目录，未遍历')
        return
      }
      entries = fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    } catch (error) {
      if (error?.code !== 'ENOENT') add(rel, 'warn', 'asset-directory-unreadable', '资产目录无法读取')
      return
    }
    for (const entry of entries) {
      if (++count > MAX_FILES) {
        add(rel, 'warn', 'asset-scan-limit', '资产扫描达到上限，未登记文件检查不完整')
        break
      }
      if (entry.name.startsWith('.')) continue
      const child = posix(path.join(rel, entry.name))
      if (entry.isSymbolicLink()) {
        if (!manifests.has(child)) add(child, 'warn', 'asset-link', '未登记链接，未读取或遍历')
      } else if (entry.isDirectory()) walk(child, depth + 1)
      else if (entry.isFile() && !manifests.has(child)) add(child, 'warn', 'asset-unregistered', '资产文件未登记（可能属于用户）')
    }
  }
  // 还没有任何已发布课程时，"未登记"没有意义：新工作区里每个文件都会被算成未登记，
  // 对着第一次开课的学习者刷一屏假警告。只有存在已发布课程时才扫。
  if (Object.keys(state?.lessons ?? {}).length > 0) walk('assets', 0)
  issues.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : (a.expected ?? '').localeCompare(b.expected ?? ''))
  return { issues, errors: issues.filter((item) => item.level === 'error').length, warnings: issues.filter((item) => item.level === 'warn').length }
}
