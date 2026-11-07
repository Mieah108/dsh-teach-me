#!/usr/bin/env node
/* 上下文与调用成本计量（v0.6.3-A · A3，纯读）。
 *
 * 用一个假 ctx 跑一遍 plugin.apply，把「每轮固定开销」与「典型回执」量成数字：
 *   1. 常驻提示词：8 段的 UTF-8 字节、persona prefix 字节、合计；
 *   2. 工具 schema：按工具名逐项 UTF-8 字节、合计、Top 5；
 *   3. 典型回执：teach_status / lesson_lint（示例页）/ teach_lesson_publish（dryRun）/ teach_stage；
 *   4. 环境：node 版本、宿主版本（读不到就标不可观测）、cordis.patch.yml sha256、配置快照、时间戳。
 *
 * 口径（已批准，不要改）：
 *   - 字节一律 Buffer.byteLength(text, 'utf8')；不是 String.length，也不是默认编码；
 *   - 工具 schema 的字节 = JSON.stringify({name, description, parameters, output:{schema}}) 的 UTF-8 字节；
 *   - 回执字节 = Buffer.byteLength(JSON.stringify(result), 'utf8')（工具实际返回的整个对象）；
 *   - token 不在这里猜：本脚本只量字节，token 由 teach_report 读宿主投影（读不到就写不可观测）。
 *
 * 不写工作区：示例工作区建在 os.tmpdir()，结束即删；只读包内 prompt/、cordis.patch.yml。
 *
 * 跑法：
 *   node scripts/measure-context.mjs            # 人读 + JSON
 *   node scripts/measure-context.mjs --json     # 只出 JSON（便于两次运行 diff）
 *   node scripts/measure-context.mjs --check    # 连跑两次，断言除生成时间外逐字节一致
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const patchFile = path.join(packageRoot, 'cordis.patch.yml')
const promptDir = path.join(packageRoot, 'prompt')
const packageJsonFile = path.join(packageRoot, 'package.json')

const byteLength = (text) => Buffer.byteLength(text, 'utf8')
const format = (value) => value.toLocaleString('en-US')

/** 终端显示宽度：CJK/全角算 2 列，其余算 1 列（只用于人读对齐，不影响字节数）。 */
const displayWidth = (text) => [...String(text)].reduce((sum, ch) => sum + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0)
const pad = (text, width) => String(text) + ' '.repeat(Math.max(0, width - displayWidth(text)))
const padStart = (text, width) => ' '.repeat(Math.max(0, width - displayWidth(text))) + String(text)

/** 示例页：与 scripts/selftest.mjs 的「干净页」同构，依赖 assets/ 下三个真实文件。
    用 String.raw 拼，避免 LaTeX 反斜杠被 JS 转义吃掉（\t、\f 会被解释成控制字符）。 */
const SAMPLE_LESSON = String.raw`<!doctype html><html><head><meta charset="utf-8"><title>计量示例课</title>
<link rel="stylesheet" href="assets/course.css"></head><body>
<aside class="sidenav"><nav class="toc"><a href="#s1">一</a></nav></aside>
<main><section id="s1"><h2>一、一个能自己算的例子</h2>
<p>公式 $\mathbf{q}^\top$ 在这里，独立公式：</p>
<div class="eq">$$\frac{\mathbf{q}\mathbf{K}^\top}{\sqrt{d_k}}$$</div>
<table><thead><tr><th>符号</th><th>含义</th></tr></thead><tbody><tr><td>$d_k$</td><td>维度</td></tr></tbody></table>
<p>口径：只写本文能核到的结论。</p>
<div class="quiz" data-explain="ok" data-scope="ok" data-question-id="measure-q1">
<p>这一项的作用是什么？</p>
<input type="radio" name="measure-q1" data-ok="1"> 缩放
<input type="radio" name="measure-q1"> 归一化
</div>
</section></main>
<script src="assets/course.js"></script><script async src="assets/mathjax/tex-svg.js"></script></body></html>`

/** 建一次性的示例工作区；只在 os.tmpdir() 里，结束即删。 */
function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-measure-'))
  fs.mkdirSync(path.join(dir, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'assets', 'mathjax'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'lessons', 'sample.html'), SAMPLE_LESSON)
  fs.writeFileSync(path.join(dir, 'assets', 'course.css'), '/* 计费用空样式，不参与度量 */' + '\n')
  fs.writeFileSync(path.join(dir, 'assets', 'course.js'), '/* 计费用空脚本，不参与度量 */' + '\n')
  fs.writeFileSync(path.join(dir, 'assets', 'mathjax', 'tex-svg.js'), '/* 计费用占位，不参与度量 */' + '\n')
  return dir
}

/** 假上下文：只实现插件真正用到的那几个服务（与 selftest 同构，但全部静音）。 */
function makeHarness(workspaceDir) {
  const captured = { tools: [], sections: [], variables: [], skills: [], guards: [], listeners: [] }
  const services = {
    teachPreferences: { ensure: async () => ({ factCheck: 'moderate', depth: 'moderate', collections: {} }) },
    // 投影读面给一个「没有 tokenUsage」的空实现：本脚本只量字节，不测 token。
    sessionProjections: { stateOf: () => ({ questions: { active: [], settled: [] } }) },
    tools: {
      register: (definition) => {
        captured.tools.push(definition)
        return () => {}
      },
      guard: (guard) => {
        captured.guards.push(guard)
        return () => {}
      }
    },
    systemPrompt: {
      section: (section) => {
        captured.sections.push(section)
        return () => {}
      },
      variable: (name, provider) => {
        captured.variables.push({ name, provider })
        return () => {}
      }
    },
    skills: {
      register: (registration) => {
        captured.skills.push(registration)
        return () => {}
      }
    },
    workingDirectory: { get: () => workspaceDir },
    // 以下服务只是为了让 teach_status 的回执接近真实宿主（健康三档都读得到），不参与度量。
    teachSettings: { get: () => ({ source: 'measure-context' }), source: 'measure-context' },
    agents: { get: () => undefined },
    llm: { stream: () => {} },
    subprocess: { spawn: () => undefined, resolveExecutable: () => undefined },
    jobs: { start: () => 'job-measure' }
  }
  const ctx = {
    get: (name) => services[name],
    provide: () => {},
    inject: (deps, callback) => callback(ctx),
    effect: (factory) => factory(),
    on: (event, listener) => {
      captured.listeners.push({ event, listener })
      return () => {}
    },
    logger: { info: () => {}, warn: () => {} }
  }
  return { ctx, captured }
}

/** cordis.patch.yml 里 persona 的 prefix 字面块：按缩进取，不引入 YAML 解析依赖。 */
function readPersonaPrefix(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^\s*prefix: \|\s*$/.test(line))
  if (start < 0) return undefined
  const baseIndent = lines[start].match(/^\s*/)[0].length
  const raw = []
  let end = start + 1
  for (; end < lines.length; end += 1) {
    const line = lines[end]
    if (line.trim().length === 0) {
      raw.push('')
      continue
    }
    const indent = line.match(/^\s*/)[0].length
    if (indent <= baseIndent) break
    raw.push(line)
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const firstIndent = raw.find((line) => line.trim().length > 0).match(/^\s*/)[0].length
  const body = raw.map((line) => (line.trim().length === 0 ? '' : line.slice(firstIndent))).join('\n')
  return { text: body, line: start + 1, through: end }
}

/** 宿主版本：本包不依赖宿主，解析不到就如实标不可观测。 */
function readHostVersion() {
  const attempts = []
  try {
    const require = createRequire(packageJsonFile)
    const file = require.resolve('@deepseek-ai/dsh/package.json')
    const version = JSON.parse(fs.readFileSync(file, 'utf8')).version
    if (typeof version === 'string' && version.length > 0) return { version, source: file, attempts }
    attempts.push('createRequire.resolve 解析到了文件但没有 version 字段')
  } catch (error) {
    attempts.push('createRequire().resolve("@deepseek-ai/dsh/package.json") → ' + (error?.code ?? error?.message))
  }
  try {
    const file = import.meta.resolve('@deepseek-ai/dsh/package.json')
    const version = JSON.parse(fs.readFileSync(fileURLToPath(file), 'utf8')).version
    if (typeof version === 'string' && version.length > 0) return { version, source: fileURLToPath(file), attempts }
  } catch (error) {
    attempts.push('import.meta.resolve("@deepseek-ai/dsh/package.json") → ' + (error?.code ?? error?.message))
  }
  return { version: null, source: null, attempts }
}

/**
 * 配置快照：内置默认值 + 说明（预设行在 cordis.patch.yml，sha256 已记录，不解析 YAML）。
 * animationRoot 非空表示按「配了动画工程」这一档计量（D1 起常驻内容随配置变化）。
 */
function configSnapshot(animationRoot = '') {
  const resolved = resolveConfig(animationRoot === '' ? {} : { animation: { root: animationRoot } }, undefined)
  return {
    prompt: { enabled: resolved.prompt.enabled, dir: resolved.prompt.dir },
    tools: { ...resolved.tools },
    ledger: { ...resolved.ledger },
    stages: { ...resolved.stages },
    skills: { enabled: resolved.skills.enabled, modelInvocable: resolved.skills.modelInvocable, userInvocable: resolved.skills.userInvocable },
    animation: {
      enabled: resolved.animation.enabled,
      root: resolved.animation.root,
      softLimitSeconds: resolved.animation.softLimitSeconds,
      gateSkill: resolved.animation.gateSkill
    },
    workspace: { teachingRoot: resolved.workspace.teachingRoot },
    note: '内置默认（设置页未改时）；预设行的值见 cordis.patch.yml（sha256 在 environment.patch），本脚本不解析 YAML。'
  }
}

function onDiskPromptBytes() {
  try {
    return fs
      .readdirSync(promptDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => fs.statSync(path.join(promptDir, entry.name)).size)
      .reduce((sum, size) => sum + size, 0)
  } catch {
    return 0
  }
}

const RECEIPTS = [
  { tool: 'teach_status', label: 'teach_status（会话诊断）', args: {} },
  { tool: 'lesson_lint', label: 'lesson_lint（示例页）', args: { paths: ['lessons/sample.html'] } },
  {
    tool: 'teach_lesson_publish',
    label: 'teach_lesson_publish（dryRun，不落盘）',
    args: { lessonId: 'measure-sample', path: 'lessons/sample.html', title: '计量示例课', dryRun: true }
  },
  { tool: 'teach_stage', label: 'teach_stage（show）', args: { action: 'show' } }
]

/** 「配了动画工程」这一档用的占位工程根：只影响 config.animation.enabled，不会被真读。
 *  用固定字面量（不拼 os.tmpdir）是为了让输出跨机器可对照 —— 它只会出现在 config 快照里。 */
const ANIMATION_PROBE_ROOT = '/tmp/teach-measure-animation-project'

/**
 * 量一次。
 * @param {{animationRoot?: string}} [options] animationRoot 非空 = 按「配了动画工程」这一档量
 *   （D1 起：8 段提示词 + 21 个工具；默认档是 7 段 + 17 个工具）
 */
async function measureOnce({ animationRoot = '', stageLayering = false, stage = 'unknown' } = {}) {
  const workspaceDir = makeWorkspace()
  try {
    const { ctx, captured } = makeHarness(workspaceDir)
    const plugin = await import(path.join(packageRoot, 'lib/index.js'))
    plugin.apply(ctx, { animation: { root: animationRoot }, prompt: { stageLayering } })
    const exec = { agent: { id: 'measure-context', session: { id: 'measure-session' } } }
    if (stageLayering && stage !== 'unknown') {
      await captured.tools.find((tool) => tool.name === 'teach_stage')?.execute({ action: 'set', stage }, exec)
    }

    const resolvedSections = captured.sections
      .slice()
      .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
      .map((section) => ({ ...section, text: typeof section.text === 'function' ? section.text({ scope: stage === 'unknown' ? undefined : exec.agent }) : section.text }))
      .filter((section) => section.text.length > 0)
    // 哈希实际provider输出（未插值），避免同长度内容改变被聚合字节数掩盖。
    const resolvedTextSha256 = crypto.createHash('sha256').update(resolvedSections.map((section) => section.text).join('\n\n'), 'utf8').digest('hex')
    const sections = resolvedSections.map((section) => ({ name: section.name, order: section.order, bytes: byteLength(section.text), chars: section.text.length }))
    const promptTotal = sections.reduce((sum, section) => sum + section.bytes, 0)
    const persona = readPersonaPrefix(patchFile)
    const personaBytes = persona === undefined ? 0 : byteLength(persona.text)

    const toolSchema = captured.tools
      .map((tool) => ({
        name: tool.name,
        bytes: byteLength(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            output: { schema: tool.output?.schema }
          })
        )
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    const schemaTotal = toolSchema.reduce((sum, tool) => sum + tool.bytes, 0)
    const schemaTop5 = toolSchema
      .slice()
      .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
      .slice(0, 5)

    const receipts = []
    for (const item of RECEIPTS) {
      const tool = captured.tools.find((entry) => entry.name === item.tool)
      if (tool === undefined) {
        receipts.push({ tool: item.tool, label: item.label, bytes: 0, ok: false, missing: true })
        continue
      }
      let result
      try {
        result = await tool.execute(item.args, exec)
      } catch (error) {
        receipts.push({ tool: item.tool, label: item.label, bytes: 0, ok: false, error: error?.code ?? String(error?.message ?? error) })
        continue
      }
      receipts.push({
        tool: item.tool,
        label: item.label,
        bytes: byteLength(JSON.stringify(result)),
        // 只把明确的失败算成失败：teach_status 没有 ok 字段，healthy:false 是「缺服务」不是调用失败。
        ok: result?.ok !== false && result?.isError !== true
      })
    }
    const receiptsTotal = receipts.reduce((sum, item) => sum + item.bytes, 0)

    const pkg = JSON.parse(fs.readFileSync(packageJsonFile, 'utf8'))
    const host = readHostVersion()

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      measurement: {
        byteUnit: 'UTF-8 byte via Buffer.byteLength(text, "utf8")',
        schemaDefinition: 'JSON.stringify({name, description, parameters, output: {schema}})',
        receiptDefinition: 'Buffer.byteLength(JSON.stringify(result), "utf8")'
      },
      environment: {
        node: process.version,
        host: host.version === null ? '不可观测' : host.version,
        hostSource: host.source,
        hostAttempts: host.attempts,
        packageVersion: pkg.version,
        patch: { file: 'cordis.patch.yml', sha256: crypto.createHash('sha256').update(fs.readFileSync(patchFile)).digest('hex') },
        config: configSnapshot(animationRoot),
        stageLayering,
        stage: stageLayering ? stage : 'static',
        profile: animationRoot === '' ? 'animation-off' : 'animation-on'
      },
      prompt: {
        resolvedTextSha256,
        sectionCount: sections.length,
        sections,
        totalBytes: promptTotal,
        totalChars: sections.reduce((sum, section) => sum + section.chars, 0),
        onDiskBytes: onDiskPromptBytes(),
        persona: {
          bytes: personaBytes,
          chars: persona === undefined ? 0 : persona.text.length,
          source: persona === undefined ? 'cordis.patch.yml（没找到 prefix 字面块）' : 'cordis.patch.yml:' + persona.line + ' prefix 字面块'
        }
      },
      toolSchema: {
        toolCount: toolSchema.length,
        tools: toolSchema,
        totalBytes: schemaTotal,
        top5: schemaTop5,
        baseline: {
          referenceBytes: 38864,
          source: 'v0.6.2 历史基线（旧内联脚本口径；不作为当前性能结论）',
          deltaBytes: schemaTotal - 38864
        }
      },
      receipts: { caseCount: receipts.length, cases: receipts, totalBytes: receiptsTotal },
      summary: {
        constantWithoutPersonaBytes: promptTotal + schemaTotal,
        constantWithPersonaBytes: promptTotal + personaBytes + schemaTotal,
        note: '常驻 = 提示词段 + persona prefix + 工具 schema；这里的字节不代表 token，也不代表费用。'
      }
    }
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  }
}

/** 除 generatedAt 外的规范化 JSON：两次运行必须逐字节一致。 */
function stableJson(measurement) {
  return JSON.stringify({ ...measurement, generatedAt: '<timestamp>' }, null, 2)
}

function renderHuman(measurement) {
  const lines = []
  lines.push('上下文与调用成本计量（只读；v0.6.3-A · A3）')
  lines.push('口径：字节 = Buffer.byteLength(text, "utf8")；token 不在此脚本内，见 teach_report。')
  lines.push('')
  lines.push('一、常驻提示词（注册到宿主的 systemPrompt 段）')
  for (const section of measurement.prompt.sections) {
    lines.push('  ' + pad(section.name, 26) + padStart(format(section.bytes), 7) + ' B   order ' + section.order)
  }
  lines.push('  ' + pad('合计', 26) + padStart(format(measurement.prompt.totalBytes), 7) + ' B   ' + measurement.prompt.sectionCount + ' 段')
  lines.push('  ' + pad('磁盘文件合计（含换行）', 26) + padStart(String(measurement.prompt.onDiskBytes), 7) + ' B')
  lines.push('  ' + pad('persona prefix', 26) + padStart(format(measurement.prompt.persona.bytes), 7) + ' B   ' + measurement.prompt.persona.source)
  lines.push('')
  lines.push('二、工具 schema（完整工具定义 JSON）')
  for (const tool of measurement.toolSchema.tools) {
    lines.push('  ' + pad(tool.name, 26) + padStart(format(tool.bytes), 7) + ' B')
  }
  lines.push('  ' + pad('合计', 26) + padStart(format(measurement.toolSchema.totalBytes), 7) + ' B   ' + measurement.toolSchema.toolCount + ' 个工具')
  lines.push('  Top 5：' + measurement.toolSchema.top5.map((tool) => tool.name + ' ' + format(tool.bytes) + ' B').join('、'))
  lines.push(
    '  基线参考：' +
      format(measurement.toolSchema.baseline.referenceBytes) +
      ' B（audit-v0.6.2 §5.2，口径未固化），本次差 ' +
      (measurement.toolSchema.baseline.deltaBytes >= 0 ? '+' : '') +
      measurement.toolSchema.baseline.deltaBytes +
      ' B'
  )
  lines.push('')
  lines.push('三、典型回执（Buffer.byteLength(JSON.stringify(result), "utf8")）')
  for (const item of measurement.receipts.cases) {
    const marker = item.ok ? '' : '（未成功' + (item.error !== undefined ? '：' + item.error : '') + '）'
    lines.push('  ' + pad(item.tool, 26) + padStart(format(item.bytes), 7) + ' B   ' + item.label + marker)
  }
  lines.push('  ' + pad('合计', 26) + padStart(format(measurement.receipts.totalBytes), 7) + ' B')
  lines.push('')
  lines.push('四、环境')
  lines.push('  node ' + measurement.environment.node + '；宿主 ' + measurement.environment.host)
  lines.push(
    '  包版本 ' + measurement.environment.packageVersion + '；' + measurement.environment.patch.file + ' sha256 ' + measurement.environment.patch.sha256
  )
  lines.push(
    '  常驻合计（提示词 + persona + schema）' +
      format(measurement.summary.constantWithPersonaBytes) +
      ' B；不含 persona ' +
      format(measurement.summary.constantWithoutPersonaBytes) +
      ' B'
  )
  lines.push('  生成时间 ' + measurement.generatedAt)
  lines.push('')
  return lines.join('\n')
}

/** 两档配置的对照表（D1 起常驻内容随配置变化，两个数字必须一起报）。 */
function profileRow(measurement) {
  return {
    profile: measurement.environment.profile,
    stageLayering: measurement.environment.stageLayering,
    stage: measurement.environment.stage,
    animationRoot: measurement.environment.config.animation.root,
    sections: measurement.prompt.sectionCount,
    promptBytes: measurement.prompt.totalBytes,
    resolvedTextSha256: measurement.prompt.resolvedTextSha256,
    tools: measurement.toolSchema.toolCount,
    schemaBytes: measurement.toolSchema.totalBytes,
    personaBytes: measurement.prompt.persona.bytes,
    constantWithPersonaBytes: measurement.summary.constantWithPersonaBytes
  }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：node scripts/measure-context.mjs [--json] [--check] [--animation [root]] [--profiles] [--stage-matrix]')
    console.log('  --json       只输出 JSON（便于两次运行 diff）')
    console.log('  --check      连跑两次，断言除 generatedAt 外逐字节一致')
    console.log('  --animation  按「配了动画工程」这一档量（省略 root 时用占位工程）')
    console.log('  --stage-matrix  静态/三阶段族/未知阶段 × 动画两档；可加 --check')
    console.log('  --profiles   两档一起量：animation-off 与 animation-on 的常驻对照')
    return 0
  }
  const jsonOnly = args.includes('--json')
  const animationAt = args.indexOf('--animation')
  const animationRoot =
    animationAt === -1
      ? ''
      : (() => {
          const next = args[animationAt + 1]
          return next === undefined || next.startsWith('--') ? ANIMATION_PROBE_ROOT : next
        })()

  if (args.includes('--stage-matrix')) {
    const matrix = async () => {
      const rows = []
      for (const root of ['', ANIMATION_PROBE_ROOT]) {
        rows.push(profileRow(await measureOnce({ animationRoot: root })))
        for (const stage of ['diagnose', 'build', 'record', 'unknown']) {
          rows.push(profileRow(await measureOnce({ animationRoot: root, stageLayering: true, stage })))
        }
      }
      return rows
    }
    const profiles = await matrix()
    const consistent = !args.includes('--check') || JSON.stringify(profiles) === JSON.stringify(await matrix())
    console.log(JSON.stringify({ schemaVersion: 1, profiles, consistent }, null, 2))
    return consistent && profiles.filter((row) => row.profile === 'animation-off').every((row) => row.constantWithPersonaBytes <= 74 * 1024) ? 0 : 1
  }

  if (args.includes('--profiles')) {
    const profiles = [await measureOnce(), await measureOnce({ animationRoot: ANIMATION_PROBE_ROOT })]
    const rows = profiles.map(profileRow)
    if (!jsonOnly) {
      console.log('常驻上下文两档对照（A3 口径：UTF-8 字节；token 不在此脚本）')
      console.log('')
      console.log('  ' + pad('配置', 26) + padStart('段', 4) + padStart('提示词', 10) + padStart('工具', 6) + padStart('schema', 10) + padStart('常驻合计', 12))
      for (const row of rows) {
        console.log(
          '  ' +
            pad(row.profile, 26) +
            padStart(String(row.sections), 4) +
            padStart(format(row.promptBytes), 10) +
            padStart(String(row.tools), 6) +
            padStart(format(row.schemaBytes), 10) +
            padStart(format(row.constantWithPersonaBytes), 12)
        )
      }
      console.log('')
      console.log('  animation-off = 未配置动画工程（默认）：60-animation 与 4 个动画工具都不常驻')
      console.log('  animation-on  = 配了工程：保留动画篇与4个动画工具，字节以本轮实测为准')
      console.log('  D1 目标：animation-off 的常驻合计 ≤ 70 KB（71,680 B）')
      console.log('')
    }
    console.log('--- JSON ---')
    console.log(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), profiles: rows }, null, 2))
    return rows[0].constantWithPersonaBytes <= 74 * 1024 ? 0 : 1
  }

  if (args.includes('--check')) {
    const first = await measureOnce({ animationRoot })
    const second = await measureOnce({ animationRoot })
    const left = stableJson(first)
    const right = stableJson(second)
    const consistent = left === right
    if (!jsonOnly) console.log(renderHuman(first))
    console.log(JSON.stringify({ check: 'two-runs-identical', consistent, normalizedJsonBytes: byteLength(left) }, null, 2))
    if (!consistent) {
      console.error('× 两次运行不一致（除 generatedAt 外）：口径有非确定性来源')
      return 1
    }
    console.log('✓ 两次运行除时间戳外逐字节一致（' + byteLength(left) + ' B 规范化 JSON）')
    return 0
  }
  const measurement = await measureOnce({ animationRoot })
  if (!jsonOnly) console.log(renderHuman(measurement))
  console.log('--- JSON ---')
  console.log(JSON.stringify(measurement, null, 2))
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    console.error('× 计量脚本失败：' + (error instanceof Error ? error.stack : String(error)))
    process.exitCode = 1
  }
)
