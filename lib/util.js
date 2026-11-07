/* 小工具：插件只依赖 Node 内置模块，不 import 任何 @deepseek-ai/* 包。
   原因：本包以 `link:` 装进 profile，能不能解析到宿主的依赖取决于安装方式，
   少一个外部 import 就少一处装不上。 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 读文件；不存在返回 undefined。 */
export function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 读 JSON；坏了返回 undefined，不抛。 */
export function readJsonIfExists(file) {
  const text = readIfExists(file)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 列目录下的子目录名（排好序）；不是目录返回空数组。 */
export function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/** 是否存在的普通文件。 */
export function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * 拆 YAML frontmatter（只认顶层的 `key: value`，够读技能头用）。
 * @returns {{data: Record<string, string|boolean>, body: string}}
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  if (!source.startsWith('---')) return { data: {}, body: source }
  const end = source.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: source }
  const head = source.slice(3, end)
  const body = source.slice(end + 4).replace(/^\r?\n/, '')
  const data = {}
  for (const line of head.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1]
    let value = match[2].trim()
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    } else if (value === 'true') {
      data[key] = true
      continue
    } else if (value === 'false') {
      data[key] = false
      continue
    }
    data[key] = value
  }
  return { data, body }
}

/** 内容指纹，用来在 UPSTREAM.json 里判断技能快照有没有漂移。 */
export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** 文件行号索引：把一段源码里某个下标的行号算出来（1 起）。 */
export function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

/** 取一段文本里全部匹配，带行号。 */
export function matches(text, regex) {
  const out = []
  regex.lastIndex = 0
  let match = regex.exec(text)
  while (match !== null) {
    out.push({ index: match.index, match })
    if (match[0].length === 0) regex.lastIndex += 1
    match = regex.exec(text)
  }
  return out
}

/** 截断长文本，保留头尾。 */
export function clip(text, limit = 120) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : value.slice(0, limit - 1) + '…'
}

/** POSIX 风格的相对路径（报告里用，Windows 下也别出现反斜杠）。 */
export function relPath(base, file) {
  return path.relative(base, file).split(path.sep).join('/')
}
