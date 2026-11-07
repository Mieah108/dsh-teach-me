#!/usr/bin/env node
/** Check the public source or runtime payload without reading Git, HOME or host profiles. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const SOURCE_FILES = ['.gitignore', '.ignore', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'README.md', 'CHANGELOG.md', 'GLOSSARY.md', 'INVENTORY.md', 'ATTRIBUTIONS.md', 'LICENSE', 'client.js', 'cordis.patch.yml']
export const SOURCE_DIRS = ['.github', 'assets', 'lib', 'locale', 'prompt', 'skills', 'templates', 'scripts', 'ui', 'test', 'docs', 'experiments', 'licenses']
export const RUNTIME_SCRIPTS = ['scripts/lesson-compile.mjs', 'scripts/lesson-lint.mjs', 'scripts/lesson-patch.mjs', 'scripts/teach-workspace.mjs']
export const RUNTIME_DIRS = ['assets', 'lib', 'locale', 'prompt', 'skills', 'templates', 'docs', 'licenses']
const rootHere = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const ignoredMacFile = (name) => name === '.DS_Store' || name.startsWith('._')
const forbiddenName = /(?:^|\/)(?:\.git|\.repro|\.codex|\.slim|\.playwright-cli|\.impeccable|\.dsh-teach-me|\.teach|_teach-managed|\.npmrc|\.pypirc|node_modules|private-backup|transcripts)(?:\/|$)|(?:^|\/)docs\/(?:evidence|research|architecture)(?:\/|$)|\.(?:log|pem|key|p12|pfx|sqlite3?|db|bak|backup|tgz|tar\.gz)$/i

/** Enumerate only explicit public roots; reject links rather than following them. */
export function publicFiles(root, { runtime = false } = {}) {
  const result = []
  const walk = (relative) => {
    const absolute = path.join(root, relative)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error('不允许发布符号链接：' + relative)
    const basename = path.posix.basename(relative)
    const localEnv = /^\.env(?:\.|$)/i.test(basename) && !['.env.example', '.env.sample'].includes(basename)
    const localConfig = /\.local\.(?:json|ya?ml)$/i.test(basename)
    if (forbiddenName.test(relative) || localEnv || localConfig) throw new Error('不允许发布本地/敏感文件：' + relative)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) {
        if (!ignoredMacFile(name)) walk(path.posix.join(relative, name))
      }
    } else if (stat.isFile()) result.push(relative)
    else throw new Error('不支持的发布文件：' + relative)
  }
  const roots = runtime
    ? [...SOURCE_FILES.filter((name) => !['.gitignore', '.ignore', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(name)), ...RUNTIME_DIRS, ...RUNTIME_SCRIPTS]
    : [...SOURCE_FILES, ...SOURCE_DIRS]
  for (const relative of roots) {
    if (!fs.existsSync(path.join(root, relative))) throw new Error('发布文件缺失：' + relative)
    walk(relative)
  }
  return [...new Set(result)].sort()
}

export function inspectText(relative, text) {
  const errors = []
  // System roots and synthetic /home/nobody test inputs remain valid.
  const rules = [
    ['个人目录', /\/(?:Users\/(?!Shared(?:\/|\b))[^\s/"'`<>]+|Volumes\/(?!\.\.\.)[^\s/"'`<>]+|private\/var\/folders\/[^\s"'`<>]+)/],
    ['Linux 个人目录', /\/(?:home\/(?!nobody(?:[\s"'`<>]|$))[^\s/"'`<>]+|root)(?=[\/\s"'`<>]|$)/],
    ['Windows 个人目录', /[A-Za-z]:\\+Users\\+[^\s\\"'`<>]+/],
    ['真实会话标识', /\bsession-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/i],
    ['凭据格式', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/],
    ['凭据字面量', /(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret)["']?\s*[:=]\s*["'][A-Za-z0-9_+/=-]{16,}["']/i],
    ['URL 查询凭据', /https?:\/\/[^\s"'`]+[?&](?:api[_-]?key|access[_-]?token|token|key|secret)=[A-Za-z0-9_-]{16,}/i],
    ['私钥', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ['URL 内嵌凭据', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
    ['旧过程目录', /docs\/(?:evidence|research|architecture)\//]
  ]
  for (const [index, line] of text.split('\n').entries()) {
    for (const [label, pattern] of rules) {
      if (!pattern.test(line)) continue
      // These cases are deliberately hostile, synthetic inputs for the URL validator.
      if (label === 'URL 内嵌凭据' && relative.startsWith('test/') && /https:\/\/user:pass@example\.org\//.test(line)) continue
      errors.push(`${relative}:${index + 1} ${label}`)
    }
  }
  return errors
}

function markdownLinks(relative, text, inventory) {
  const errors = []
  let fenced = false
  for (const [index, line] of text.split('\n').entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    for (const match of line.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
      const target = match[1].trim().replace(/^<|>$/g, '').split(/\s+["']/)[0]
      if (!target || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue
      const destination = target.split('#')[0]
      if (!destination) continue
      let resolved
      try { resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), decodeURIComponent(destination))) }
      catch { errors.push(`${relative}:${index + 1} 无效链接`); continue }
      if (resolved.startsWith('../') || path.posix.isAbsolute(destination) || (!inventory.has(resolved) && ![...inventory].some((file) => file.startsWith(resolved.replace(/\/$/, '') + '/')))) {
        errors.push(`${relative}:${index + 1} 包内链接不存在：${target}`)
      }
    }
  }
  return errors
}

export async function checkRelease(root = rootHere, { runtime = false } = {}) {
  root = path.resolve(root)
  const files = publicFiles(root, { runtime })
  const inventory = new Set(files)
  const errors = []
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  const topVersion = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((item) => item[1]).find((version) => version !== 'Unreleased')
  if (topVersion !== pkg.version) errors.push('package.json 与 CHANGELOG 版本不一致')
  if (!inventory.has(pkg.main) || !inventory.has('client.js')) errors.push('主入口或客户端入口缺失')
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(root, file))
    if (bytes.includes(0)) { errors.push('公开文件集中有未审查二进制：' + file); continue }
    const text = bytes.toString('utf8')
    errors.push(...inspectText(file, text))
    if (file.endsWith('.md')) errors.push(...markdownLinks(file, text, inventory))
  }
  const requiredNotices = {
    'LICENSE': 'BSD 3-Clause',
    'ATTRIBUTIONS.md': 'DeepSeek',
    'licenses/MIT-teach.txt': 'Matt Pocock',
    'licenses/MIT-DSH.txt': 'DeepSeek',
    'templates/mathjax/LICENSE': 'Apache License',
    'templates/mathjax/NOTICE.txt': '3.2.2',
    'templates/components/THIRD_PARTY_NOTICES.txt': 'DeepTutor'
  }
  for (const [file, marker] of Object.entries(requiredNotices)) {
    if (!inventory.has(file) || !fs.readFileSync(path.join(root, file), 'utf8').includes(marker)) errors.push('许可声明缺失或不完整：' + file)
  }
  if (digest(fs.readFileSync(path.join(root, 'templates/mathjax/tex-svg.js'))) !== 'd4295dc33744836935c1399feece5159577b34c5c8ffb9f1c6324cd82e03a882') errors.push('MathJax 固定资源哈希不符')
  const built = JSON.parse(fs.readFileSync(path.join(root, 'templates/components/build-info.json'), 'utf8'))
  for (const [file, info] of Object.entries(built.files)) {
    if (digest(fs.readFileSync(path.join(root, 'templates/components', file))) !== info.sha256) errors.push('组件产物哈希不符：' + file)
  }
  const sourceManifestPath = path.join(root, 'SOURCE-MANIFEST.json')
  if (!runtime && fs.existsSync(sourceManifestPath)) {
    const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'))
    if (sourceManifest.version !== pkg.version || JSON.stringify(sourceManifest.files?.map((row) => row.path).sort()) !== JSON.stringify(files)) errors.push('源码归档清单与文件集合不一致')
    for (const row of sourceManifest.files ?? []) {
      if (!inventory.has(row.path)) continue
      if (digest(fs.readFileSync(path.join(root, row.path))) !== row.sha256) errors.push('源码归档哈希不符：' + row.path)
    }
  }
  const { checkSkills } = await import('./sync-skills.mjs')
  try {
    const result = checkSkills(root)
    if (result?.errors?.length) errors.push(...result.errors)
  } catch (error) { errors.push('技能清单：' + error.message) }
  return { ok: errors.length === 0, version: pkg.version, files, errors }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--root' && args[1] && !args[1].startsWith('-')))) throw new Error('用法：node scripts/check-release.mjs [--root <源码目录>]')
  const report = await checkRelease(args.length === 0 ? rootHere : args[1])
  if (!report.ok) { console.error(report.errors.join('\n')); process.exitCode = 1 }
  else console.log(`✓ 公开源码检查通过：${report.files.length} 文件，版本 ${report.version}（不代表旧 Git 历史已脱敏）`)
}
