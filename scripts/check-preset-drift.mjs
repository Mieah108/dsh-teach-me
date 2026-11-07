#!/usr/bin/env node
/* 宿主 ptc 预设漂移检测（A1）。
 *
 * 目的：教学模式包把宿主 `ptc.patch.yml` 的整份 `config.plugins` 行表抄进
 * `cordis.patch.yml`（整份替换，不做深合并），宿主升级后必然出现行/键差异。
 * 本脚本把差异分成三类并对照 allowlist 解释：
 *   - missing rows：宿主有、包内无；
 *   - extra rows：包内有、宿主无；
 *   - key drift：同 id 行上被观察的键不同（含行序漂移，记作 `#order`）。
 *
 * 每条 allowlist 条目必须写明「为什么这个偏离对教学预设是必要的」，并做
 * **腐烂自检**：登记的行/键若已不存在或差异已消失 → 视为错误，防止白名单
 * 永久漂移后掩盖新问题。
 *
 * 用法：
 *   node scripts/check-preset-drift.mjs [--json] [--host <ptc.patch.yml>] [--patch <cordis.patch.yml>] [--allowlist <json>]
 *   DSH_PRESET_PTC=<path> 可覆盖宿主预设路径。
 *
 * 宿主缺失（未安装/版本不含该文件）→ 打印 `skip (host preset not found)` 并 exit 0：
 * CI 与别人的机器上不该因为没装某个宿主版本而失败。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PATCH = path.join(ROOT, 'cordis.patch.yml')
const DEFAULT_ALLOWLIST = path.join(ROOT, 'scripts', 'preset-drift.allowlist.json')

/** 不被比较的结构性键：容器与预设身份字段。 */
const STRUCTURAL = new Set(['config', 'plugins', 'isolate', 'insert'])
/** 行序漂移的伪键名（真实的 YAML 键不会用 # 开头）。 */
const ORDER_KEY = '#order'

/** 宿主 ptc.patch.yml 的候选路径（按确定性顺序，不依赖工作目录）。 */
export function hostPresetCandidates({ execPath = process.execPath, env = process.env, home = os.homedir() } = {}) {
  const out = []
  if (env.DSH_PRESET_PTC) out.push(env.DSH_PRESET_PTC)
  const prefix = path.resolve(path.dirname(execPath), '..')
  const tail = path.join('lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'ptc.patch.yml')
  out.push(path.join(prefix, tail))
  // nvm 多版本：只在 DSH_PRESET_PTC 与当前 node 前缀都不命中时才扫。
  const nvm = path.join(home, '.nvm', 'versions', 'node')
  try {
    const versions = fs.readdirSync(nvm).sort().reverse()
    for (const version of versions) out.push(path.join(nvm, version, tail))
  } catch {
    // 没装 nvm：忽略
  }
  // 常见全局前缀（brew / npm -g / 自建）
  for (const base of [path.join(home, '.npm-global', 'lib', 'node_modules'), '/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules']) {
    out.push(path.join(base, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-web-app', 'presets', 'ptc.patch.yml'))
  }
  return out
}

export function findHostPreset(options) {
  for (const candidate of hostPresetCandidates(options)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      // 下一个候选
    }
  }
  return null
}

function indentOf(line) {
  const match = /^[ ]*/.exec(line)
  return match === null ? 0 : match[0].length
}

function stripInlineComment(value) {
  const text = value.trim()
  if (text.startsWith("'") || text.startsWith('"') || text === '|' || text === '|-' || text === '|+') return text
  const hash = text.indexOf(' #')
  return (hash === -1 ? text : text.slice(0, hash)).trim()
}

function unquote(value) {
  return value.replace(/^['"]|['"]$/g, '')
}

function normalizeBlock(lines) {
  const trimmed = lines.map((line) => line.replace(/\s+$/g, ''))
  while (trimmed.length > 0 && trimmed[0] === '') trimmed.shift()
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return trimmed.join('\n')
}

/**
 * 解析 patch YAML 成可比较的行表。
 * 只识别本仓库用到的子集：`- id:` 行、`key: value` 标量、`key: |` 块标量；
 * 嵌套 list（`config:` 下的 `- id:`）按父行递归。组行（`group: true`）同理。
 *
 * 预设声明行下的子行统一映射成 `preset/<id>`：上游 id 是 `preset-ptc`、包内是
 * `preset-teach`，若按字面路径比较，所有子行都会变成 missing+extra 噪音。
 */
export function parsePatch(text) {
  const lines = String(text).split('\n')
  const rows = []
  const stack = []
  let current = null
  let order = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = indentOf(line)
    const rowMatch = /^-\s+id:\s*(.+)$/.exec(trimmed)
    if (rowMatch !== null) {
      const id = unquote(stripInlineComment(rowMatch[1]))
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
      const parent = stack.length === 0 ? null : stack[stack.length - 1]
      const parentPath = parent === null ? '' : parent.path
      let rowPath
      if (parent !== null && parent.isPresetRoot === true) rowPath = 'preset/' + id
      else rowPath = parentPath === '' ? id : parentPath + '/' + id
      const row = { id, path: rowPath, indent, name: undefined, isPresetRoot: false, fields: {}, order: order++, line: index + 1 }
      rows.push(row)
      stack.push(row)
      current = row
      continue
    }
    const keyMatch = /^([A-Za-z0-9_.-]+):\s?(.*)$/.exec(trimmed)
    if (keyMatch === null || current === null) continue
    const key = keyMatch[1]
    const raw = keyMatch[2]
    if (STRUCTURAL.has(key)) continue
    if (raw === '|' || raw === '|-' || raw === '|+') {
      const body = []
      let cursor = index + 1
      while (cursor < lines.length) {
        const next = lines[cursor]
        if (next.trim() === '') {
          body.push('')
          cursor += 1
          continue
        }
        if (indentOf(next) <= indent) break
        body.push(next.slice(Math.min(next.length, indent + 2)).replace(/\s+$/g, ''))
        cursor += 1
      }
      current.fields[key] = normalizeBlock(body)
      index = cursor - 1
      continue
    }
    const value = stripInlineComment(raw)
    if (value === '') continue
    current.fields[key] = value
    if (key === 'name') {
      current.name = unquote(value)
      if (String(current.name).includes('dsh-agent-preset')) current.isPresetRoot = true
    }
  }
  const byPath = new Map()
  for (const row of rows) byPath.set(row.path, row)
  return { rows, byPath }
}

function sameValue(left, right) {
  return String(left ?? '') === String(right ?? '')
}

/**
 * 三类差异 + 行序漂移。
 * @returns {{missing: object[], extra: object[], keyDrift: object[]}}
 */
export function diffPatches(hostText, localText) {
  const host = parsePatch(hostText)
  const local = parsePatch(localText)
  const missing = []
  const extra = []
  const keyDrift = []
  for (const [rowPath, row] of host.byPath) {
    if (!local.byPath.has(rowPath)) missing.push({ kind: 'row', id: rowPath, side: 'host' })
  }
  for (const [rowPath, row] of local.byPath) {
    if (!host.byPath.has(rowPath)) extra.push({ kind: 'row', id: rowPath, side: 'local' })
  }
  const hostOrder = host.rows.filter((row) => local.byPath.has(row.path)).map((row) => row.path)
  const localOrder = local.rows.filter((row) => host.byPath.has(row.path)).map((row) => row.path)
  for (let index = 0; index < Math.max(hostOrder.length, localOrder.length); index += 1) {
    if (hostOrder[index] === localOrder[index]) continue
    // 只记录第一处错位之后的每一行：给出可执行的 allowlist 依据。
    for (let cursor = index; cursor < localOrder.length; cursor += 1) {
      keyDrift.push({ kind: 'key', id: localOrder[cursor], key: ORDER_KEY, host: hostOrder.indexOf(localOrder[cursor]), local: cursor })
    }
    break
  }
  for (const [rowPath, hostRow] of host.byPath) {
    const localRow = local.byPath.get(rowPath)
    if (localRow === undefined) continue
    const keys = new Set([...Object.keys(hostRow.fields), ...Object.keys(localRow.fields)])
    for (const key of keys) {
      if (sameValue(hostRow.fields[key], localRow.fields[key])) continue
      keyDrift.push({ kind: 'key', id: rowPath, key, host: hostRow.fields[key], local: localRow.fields[key] })
    }
  }
  return { missing, extra, keyDrift }
}

export function loadAllowlist(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  const entries = Array.isArray(parsed) ? parsed : parsed.entries
  if (!Array.isArray(entries)) throw new Error('allowlist 必须是数组或 { entries: [...] }')
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') throw new Error('allowlist 第 ' + (index + 1) + ' 条不是对象')
    if (entry.kind !== 'row' && entry.kind !== 'key') throw new Error('allowlist 第 ' + (index + 1) + ' 条 kind 必须是 row 或 key')
    if (typeof entry.id !== 'string' || entry.id === '') throw new Error('allowlist 第 ' + (index + 1) + ' 条缺 id')
    if (entry.kind === 'key' && (typeof entry.key !== 'string' || entry.key === '')) throw new Error('allowlist 第 ' + (index + 1) + ' 条 kind=key 必须带 key')
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 8) throw new Error('allowlist 第 ' + (index + 1) + ' 条理由太短（必须写清为什么这个偏离是必要的）')
    return { kind: entry.kind, id: entry.id, key: entry.key, reason: entry.reason.trim() }
  })
}

function matchesEntry(drift, entry) {
  if (entry.kind !== drift.kind) return false
  if (entry.id !== drift.id) return false
  if (entry.kind === 'key' && entry.key !== drift.key) return false
  return true
}

/**
 * 把三类差异分成「allowlist 已解释」与「未解释」两组，并做 aid 腐烂自检。
 * @returns {{allowed: object[], unallowed: object[], rot: object[]}}
 */
export function applyAllowlist(diff, entries) {
  const allowed = []
  const unallowed = []
  for (const drift of [...diff.missing, ...diff.extra, ...diff.keyDrift]) {
    const hit = entries.find((entry) => matchesEntry(drift, entry))
    if (hit === undefined) unallowed.push(drift)
    else allowed.push({ ...drift, reason: hit.reason, entry: hit })
  }
  // 腐烂自检：登记项必须仍然命中一处真实差异，否则它就是在掩盖未来的新问题。
  // 整行仅存在于一侧时，行差异已经报告，当前宿主版本无法比较这行的字段。
  const unmatchedRows = new Set([...diff.missing, ...diff.extra].map((row) => row.id))
  const rot = []
  for (const entry of entries) {
    if (entry.kind === 'key' && unmatchedRows.has(entry.id)) continue
    const hit = allowed.some((drift) => drift.entry === entry)
    if (!hit) rot.push(entry)
  }
  return { allowed, unallowed, rot }
}

function describe(drift) {
  if (drift.kind === 'row' && drift.side === 'host') return 'missing row ' + drift.id
  if (drift.kind === 'row' && drift.side === 'local') return 'extra row ' + drift.id
  if (drift.key === ORDER_KEY) return 'key drift ' + drift.id + ' #order (host ' + drift.host + ', local ' + drift.local + ')'
  return 'key drift ' + drift.id + ' :: ' + drift.key
}

export function run({ hostPath, patchPath = DEFAULT_PATCH, allowlistPath = DEFAULT_ALLOWLIST, json = false, quiet = false } = {}) {
  const host = hostPath === undefined ? findHostPreset() : hostPath
  if (host === null || host === undefined || !fs.existsSync(host)) {
    if (!quiet) console.log('skip (host preset not found)')
    return { skipped: true }
  }
  const hostText = fs.readFileSync(host, 'utf8')
  const localText = fs.readFileSync(patchPath, 'utf8')
  const entries = loadAllowlist(allowlistPath)
  const diff = diffPatches(hostText, localText)
  const result = applyAllowlist(diff, entries)
  const summary = {
    host,
    patch: patchPath,
    allowlist: allowlistPath,
    counts: {
      missing: result.unallowed.filter((drift) => drift.kind === 'row' && drift.side === 'host').length,
      extra: result.unallowed.filter((drift) => drift.kind === 'row' && drift.side === 'local').length,
      keyDrift: result.unallowed.filter((drift) => drift.kind === 'key').length,
      allowlisted: result.allowed.length,
      rot: result.rot.length
    },
    unallowed: result.unallowed,
    allowed: result.allowed.map(({ entry, ...drift }) => drift),
    rot: result.rot
  }
  if (json) {
    console.log(JSON.stringify(summary, null, 2))
  } else if (!quiet) {
    console.log('host preset: ' + host)
    console.log('missing ' + summary.counts.missing + ' / extra ' + summary.counts.extra + ' / key drift ' + summary.counts.keyDrift + '（allowlisted ' + summary.counts.allowlisted + '）')
    for (const drift of result.unallowed) console.log('  ! ' + describe(drift))
    for (const entry of result.rot) {
      console.log('  ! allowlist 腐烂：' + (entry.kind === 'key' ? entry.id + ' :: ' + entry.key : entry.id) + ' 已不再对应任何差异 —— 删掉这条或说明原因')
    }
  }
  return summary
}

function parseArgs(argv) {
  const out = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') out.json = true
    if (arg === '--host') out.hostPath = argv[++index]
    if (arg === '--patch') out.patchPath = argv[++index]
    if (arg === '--allowlist') out.allowlistPath = argv[++index]
    if (arg === '--help' || arg === '-h') out.help = true
  }
  return out
}

function cli() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('node scripts/check-preset-drift.mjs [--json] [--host <ptc.patch.yml>] [--patch <cordis.patch.yml>] [--allowlist <json>]')
    return 0
  }
  const summary = run(args)
  if (summary.skipped === true) return 0
  const bad = summary.counts.missing + summary.counts.extra + summary.counts.keyDrift
  if (summary.counts.rot > 0) return 1
  return bad === 0 ? 0 : 1
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) process.exitCode = cli()
