#!/usr/bin/env node
/* LessonSpec 编译器 CLI（离线命令，不是模型可见工具）。
 *
 * 用法：
 *   node scripts/lesson-compile.mjs <spec.json> <out.html>
 *   node scripts/lesson-compile.mjs --check <spec.json>      # 只校验，不写文件
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { compileSpec } from '../lib/lessonspec/compile.js'
import { validateSpec } from '../lib/lessonspec/schema.js'

const args = process.argv.slice(2)
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log('用法：node scripts/lesson-compile.mjs <spec.json> <out.html> | --check <spec.json>')
  process.exit(args.length === 0 ? 2 : 0)
}

const checkOnly = args[0] === '--check'
const specFile = checkOnly ? args[1] : args[0]
const outFile = checkOnly ? undefined : args[1]
if (specFile === undefined || (!checkOnly && outFile === undefined)) {
  console.error('缺参数：需要 <spec.json> 与 <out.html>（或 --check <spec.json>）')
  process.exit(2)
}

let raw
try {
  raw = JSON.parse(fs.readFileSync(specFile, 'utf8'))
} catch (error) {
  console.error('× 读不了 spec：' + specFile + '（' + (error instanceof Error ? error.message : String(error)) + '）')
  process.exit(1)
}

try {
  if (checkOnly) {
    const spec = validateSpec(raw)
    console.log(JSON.stringify({ ok: true, file: specFile, sections: spec.sections.length, components: spec.components.length }))
    process.exit(0)
  }
  const startedAt = process.hrtime.bigint()
  const { html } = compileSpec(raw)
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, html)
  console.log(
    JSON.stringify({ ok: true, spec: specFile, out: outFile, bytes: Buffer.byteLength(html, 'utf8'), compileMs: Number(elapsedMs.toFixed(3)) })
  )
} catch (error) {
  console.error('× 编译失败：' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
