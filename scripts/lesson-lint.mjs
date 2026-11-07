#!/usr/bin/env node
/* 课程页自检 CLI（与 lesson_lint 使用同一套 HTML 规则，不经过模型工具层）。
 *
 * 用法：node scripts/lesson-lint.mjs <file.html> [more.html ...]
 * 退出码：0 = 无硬伤；1 = 有硬伤；2 = 用法/读文件错误。
 * 输出：每个文件的 硬伤数/提醒数 与逐条明细（含行号），便于"改到零硬伤"。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { lintHtml } from '../lib/lint.js'

const files = process.argv.slice(2)
const usage = '用法：node scripts/lesson-lint.mjs <file.html> [more.html ...]'
if (files.includes('--help') || files.includes('-h')) {
  console.log(usage)
  process.exit(0)
}
if (files.length === 0) {
  console.error(usage)
  process.exit(2)
}

let errors = 0
let warnings = 0
for (const file of files) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    console.error('× 读不了文件：' + file + '（' + (error instanceof Error ? error.message : String(error)) + '）')
    process.exit(2)
  }
  const issues = lintHtml(text, path.resolve(file))
  const fileErrors = issues.filter((issue) => issue.level === 'error')
  const fileWarnings = issues.filter((issue) => issue.level === 'warn')
  errors += fileErrors.length
  warnings += fileWarnings.length
  console.log(file + '：' + fileErrors.length + ' 个硬伤 / ' + fileWarnings.length + ' 条提醒')
  for (const issue of issues) {
    console.log('  ' + (issue.level === 'error' ? '[硬伤]' : '[提醒]') + ' ' + (issue.line ?? '?') + ' ' + issue.code + ' ' + issue.message)
  }
}

console.log('')
console.log(errors === 0 ? '✓ 无硬伤（' + warnings + ' 条提醒）' : '× 共 ' + errors + ' 个硬伤、' + warnings + ' 条提醒：改到 0 硬伤再交付')
process.exit(errors === 0 ? 0 : 1)
