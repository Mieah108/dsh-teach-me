#!/usr/bin/env node
/* G1–G3 的本地可验证项（V03 / V04 / V06 / V07）。

 * 只覆盖「不需要真实宿主」的部分：媒体边界、spec patch 的锁与并发语义、
 * 档案快照的等价性与只读零写。真机项（课堂视觉、提交、冷启动）不在这里。
 *
 * 用法：node scripts/verify-g.mjs [--json]
 * 退出码：全通过 0，有失败 1。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { openArchive } from '../lib/archive/store.js'
import { registerArchiveTools } from '../lib/archive/tools.js'
import { registerLintTool } from '../lib/lint.js'
import { hashJson, sha256 } from '../lib/archive/util.js'
import { acquirePathLock } from '../lib/archive/lock.js'
import { inlineLessonAssets } from '../lib/classroom/offline.js'
import { compileSpec } from '../lib/lessonspec/compile.js'
import { inspectSpecFile, patchSpecFile } from '../lib/lessonspec/patch.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const json = process.argv.includes('--json')

const fail = (message) => { throw new Error(message) }
const expect = (value, message) => { if (!value) fail(message) }

async function check(id, label, run) {
  try {
    const detail = await run()
    results.push({ id, label, ok: true, detail: detail ?? '' })
  } catch (error) {
    results.push({ id, label, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-g-'))
  fs.mkdirSync(path.join(dir, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'assets', 'mathjax'), { recursive: true })
  for (const name of ['course.css', 'course.js', 'mathjax/tex-svg.js']) {
    fs.copyFileSync(path.join(root, 'templates', name), path.join(dir, 'assets', name))
  }
  const registered = []
  const ctx = {
    get: (name) => (name === 'tools' ? { register: (tool) => { registered.push(tool); return () => {} } } : undefined),
    effect: (factory) => { factory(); return () => {} }
  }
  registerArchiveTools(ctx, { tools: { archive: true, commit: true } }, () => dir)
  registerLintTool(ctx, { tools: { lint: true } }, () => dir)
  const tools = new Map(registered.map((tool) => [tool.name, tool]))
  return { dir, tools }
}

const EXEC = { agent: { session: { id: 'verify-g' }, id: 'verify-g' } }

function specOf(extra = []) {
  return {
    schemaVersion: 1,
    id: 'spec-verify-g',
    meta: { serial: '0001', course: '', eyebrow: '', title: '验证课', lede: '一句话。' },
    sections: [
      { id: 'body', title: '正文', blocks: [{ id: 'p1', kind: 'p', text: '正文段落。' }, ...extra] },
      { id: 'check', kind: 'quiz', title: '验收', questions: [{ questionId: 'q1', type: 'short', prompt: '回答？', answer: '是' }] }
    ]
  }
}

const writeSpec = (dir, spec, name = 'lessons/one.spec.json') => {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(spec, null, 2) + '\n')
  return name
}

const commitArgs = (specPath, extra = {}) => ({ lessonId: 'lesson-verify', path: specPath, idempotencyKey: 'verify-key', ...extra })

function treeDigest(dir) {
  const lines = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) { lines.push('d ' + path.relative(dir, full)); walk(full); continue }
      lines.push('f ' + path.relative(dir, full) + ' ' + sha256(fs.readFileSync(full)))
    }
  }
  walk(dir)
  return hashJson(lines)
}

// ── G1 / V03 ─────────────────────────────────────────────
await check('V03-1', '媒体与本地来源进清单且指纹一致', async () => {
  const { dir, tools } = workspace()
  try {
    for (const name of ['plot.png', 'poster.png', 'clip.mp4']) fs.writeFileSync(path.join(dir, 'assets', name), 'fixture-' + name)
    fs.writeFileSync(path.join(dir, 'RESOURCES.md'), '本地来源')
    const spec = specOf([
      { kind: 'link', text: '原文', href: 'https://example.org/source' },
      { kind: 'link', text: '摘录', href: '../RESOURCES.md' },
      { kind: 'image', src: '../assets/plot.png', alt: '图' },
      { kind: 'video', src: '../assets/clip.mp4', poster: '../assets/poster.png', watch: '看投影', source: 'src/clip.tsx' }
    ])
    const result = await tools.get('teach_commit').execute(commitArgs(writeSpec(dir, spec)), EXEC)
    expect(result.ok === true, 'commit 失败：' + result.text)
    const lesson = openArchive(dir, { create: false }).state.lessons['lesson-verify']
    const paths = lesson.assets.map((asset) => asset.path)
    for (const wanted of ['RESOURCES.md', 'assets/clip.mp4', 'assets/plot.png', 'assets/poster.png']) {
      expect(paths.includes(wanted), '清单缺 ' + wanted + '：' + paths.join(','))
    }
    for (const asset of lesson.assets) {
      expect(asset.size === fs.statSync(path.join(dir, asset.path)).size, '大小不符：' + asset.path)
    }
    const html = fs.readFileSync(path.join(dir, 'lessons/one.html'), 'utf8')
    const offline = inlineLessonAssets(html, dir, lesson)
    expect(/<img src="data:image\/png;base64,/.test(offline), '图片没有内联')
    expect(/<video src="data:video\/mp4;base64,/.test(offline), '视频没有内联')
    return '4 个资产入清单，图片/视频离线内联'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await check('V03-2', '缺失媒体：lint 与 commit 都拒绝', async () => {
  const { dir, tools } = workspace()
  try {
    const spec = specOf([{ kind: 'image', src: '../assets/missing.png', alt: '缺图' }])
    const specPath = writeSpec(dir, spec)
    const lint = await tools.get('lesson_lint').execute({ paths: [specPath] }, EXEC)
    expect(lint.errors === 1, 'lint 没有报硬伤：' + lint.text)
    const result = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
    expect(result.ok === false && result.error === 'lesson-spec-lint-failed', 'commit 没有拒绝：' + JSON.stringify(result))
    expect(fs.existsSync(path.join(dir, '.dsh-teach-me')) === false, '失败路径写了档案')
    return 'lint 硬伤 1 条，commit 在 lint 关拒绝且零写'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await check('V03-3', '越界媒体：lint 与 commit 同口径（0 硬伤不会再放行）', async () => {
  const { dir, tools } = workspace()
  const outside = path.join(path.dirname(dir), 'outside-' + path.basename(dir) + '.png')
  try {
    fs.writeFileSync(outside, 'x')
    const spec = specOf([{ kind: 'image', src: '../../' + path.basename(outside), alt: '越界' }])
    const specPath = writeSpec(dir, spec)
    const lint = await tools.get('lesson_lint').execute({ paths: [specPath] }, EXEC)
    expect(lint.errors === 1 && /不在工作区内/.test(lint.text), 'lint 没有按发布边界报硬伤：' + lint.text)
    const result = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
    expect(result.ok === false, 'commit 没有拒绝')
    return 'lint 报 ref-outside-workspace，commit 同样拒绝'
  } finally {
    fs.rmSync(outside, { force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('V03-4', '旧 spec（无块 id、无媒体）编译输出保持原写法', async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'experiments/lessonspec/concept.spec.json'), 'utf8'))
  const { html } = compileSpec(raw)
  expect(!/data-node-id/.test(html), '没有 id 的旧 spec 不该出现 data-node-id')
  expect(!/<figure/.test(html), '旧 spec 不该凭空多出 figure')
  return '无 data-node-id / 无 figure，旧 spec 输出不变'
})

await check('V03-5', '大于 8 MiB 的视频保留引用，海报仍内联', async () => {
  const { dir, tools } = workspace()
  try {
    fs.writeFileSync(path.join(dir, 'assets/large.mp4'), Buffer.alloc(8 * 1024 * 1024 + 1))
    fs.writeFileSync(path.join(dir, 'assets/poster.png'), 'poster')
    const spec = specOf([{ kind: 'video', src: '../assets/large.mp4', poster: '../assets/poster.png', watch: '看', source: 'src/clip.tsx' }])
    const result = await tools.get('teach_commit').execute(commitArgs(writeSpec(dir, spec)), EXEC)
    expect(result.ok === true, 'commit 失败：' + result.text)
    const lesson = openArchive(dir, { create: false }).state.lessons['lesson-verify']
    const offline = inlineLessonAssets(fs.readFileSync(path.join(dir, 'lessons/one.html'), 'utf8'), dir, lesson)
    expect(offline.includes('src="../assets/large.mp4"'), '大视频应保留原引用')
    expect(!offline.includes('data:video/mp4'), '大视频不该内联')
    expect(/poster="data:image\/png;base64,/.test(offline), '海报应仍内联')
    return '8 MiB 视频引用保留、海报内联'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await check('V03-6', '正文/属性转义：注入标签不生效', async () => {
  const { html } = compileSpec(specOf([
    { kind: 'p', text: '<script>alert(1)</script>' },
    { kind: 'image', src: '../assets/a.png', alt: '" onerror="alert(1)' }
  ]))
  expect(!/<script>alert/.test(html), '正文里的 script 没有被转义')
  expect(!/onerror="alert/.test(html), '属性注入没有被转义')
  return 'script 与属性注入都被转义'
})

// ── G2 / V04 ─────────────────────────────────────────────
function patchWorkspace() {
  const { dir } = workspace()
  const spec = specOf()
  const specPath = writeSpec(dir, spec)
  return { dir, specPath, spec }
}

await check('V04-1', '锁被占用时 patch 明确失败，释放后成功', async () => {
  const { dir, specPath } = patchWorkspace()
  try {
    const file = fs.realpathSync.native(path.join(dir, specPath))
    const lock = acquirePathLock(path.dirname(file), { name: '.dsh-teach-patch-' + sha256(file).slice(0, 16) + '.lock', label: 'verify-hold', timeoutMs: 0 })
    let held
    try {
      patchSpecFile(dir, specPath, { schemaVersion: 1, expectedHash: inspectSpecFile(dir, specPath).expectedHash, operations: [
        { op: 'replace-block', sectionId: 'body', blockId: 'p1', value: { id: 'p1', kind: 'p', text: '锁内修改' } }
      ] }, { dryRun: false })
      fail('锁被占用时竟然写成功了')
    } catch (error) {
      held = error
      expect(/锁/.test(error.message), '错误文案没有说明锁被占用：' + error.message)
    } finally {
      lock.release()
    }
    const after = patchSpecFile(dir, specPath, { schemaVersion: 1, expectedHash: inspectSpecFile(dir, specPath).expectedHash, operations: [
      { op: 'replace-block', sectionId: 'body', blockId: 'p1', value: { id: 'p1', kind: 'p', text: '锁外修改' } }
    ] }, { dryRun: false })
    expect(after.written === true, '释放锁后仍然没写成功')
    return '持锁被拒（' + String(held.code) + '），释放后写入成功'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await check('V04-2', '外部修改后 apply 冲突且零写', async () => {
  const { dir, specPath, spec } = patchWorkspace()
  try {
    const patch = { schemaVersion: 1, expectedHash: hashJson(spec), operations: [
      { op: 'replace-block', sectionId: 'body', blockId: 'p1', value: { id: 'p1', kind: 'p', text: '新文' } }
    ] }
    const dry = patchSpecFile(dir, specPath, patch)
    const changed = JSON.parse(fs.readFileSync(path.join(dir, specPath), 'utf8'))
    changed.meta.title = '外部改了'
    fs.writeFileSync(path.join(dir, specPath), JSON.stringify(changed, null, 2) + '\n')
    const bytes = fs.readFileSync(path.join(dir, specPath), 'utf8')
    let code
    try { patchSpecFile(dir, specPath, { ...patch, resultHash: dry.resultHash }, { dryRun: false }) } catch (error) { code = error.code }
    expect(code === 'lesson-spec-patch-conflict', '没有报冲突：' + code)
    expect(fs.readFileSync(path.join(dir, specPath), 'utf8') === bytes, '冲突时仍然写了文件')
    return '冲突码 lesson-spec-patch-conflict，文件字节不变'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await check('V04-3', '进程崩溃留下的锁可回收', async () => {
  const { dir, specPath } = patchWorkspace()
  try {
    const file = fs.realpathSync.native(path.join(dir, specPath))
    const lockFile = path.join(path.dirname(file), '.dsh-teach-patch-' + sha256(file).slice(0, 16) + '.lock')
    fs.writeFileSync(lockFile, JSON.stringify({ owner: 'dead', pid: 999999, host: os.hostname(), startedAt: new Date().toISOString(), label: 'crashed' }) + '\n')
    const result = patchSpecFile(dir, specPath, { schemaVersion: 1, expectedHash: inspectSpecFile(dir, specPath).expectedHash, operations: [
      { op: 'replace-block', sectionId: 'body', blockId: 'p1', value: { id: 'p1', kind: 'p', text: '回收后修改' } }
    ] }, { dryRun: false })
    expect(result.written === true, '死锁没有被回收')
    expect(!fs.existsSync(lockFile), '回收后锁文件还在')
    return '死 pid 锁被回收并完成写入'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await check('V04-4', '同一 patch 重放幂等，字节不变', async () => {
  const { dir, specPath, spec } = patchWorkspace()
  try {
    const patch = { schemaVersion: 1, expectedHash: hashJson(spec), operations: [
      { op: 'replace-block', sectionId: 'body', blockId: 'p1', value: { id: 'p1', kind: 'p', text: '新文' } }
    ] }
    const first = patchSpecFile(dir, specPath, patch, { dryRun: false })
    const bytes = fs.readFileSync(path.join(dir, specPath), 'utf8')
    const replay = patchSpecFile(dir, specPath, { ...patch, resultHash: first.resultHash }, { dryRun: false })
    expect(replay.alreadyApplied === true && replay.written === false, '重放不是幂等：' + JSON.stringify(replay))
    expect(fs.readFileSync(path.join(dir, specPath), 'utf8') === bytes, '重放改了文件')
    return 'alreadyApplied=true，零写'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await check('V05-1', 'patch 改源 → teach_commit 发布 → 页面与档案同步', async () => {
  const { dir, tools } = workspace()
  try {
    const specPath = writeSpec(dir, specOf())
    const patch = { schemaVersion: 1, expectedHash: inspectSpecFile(dir, specPath).expectedHash, operations: [
      { op: 'replace-block', sectionId: 'body', blockId: 'p1', value: { id: 'p1', kind: 'p', text: '改后的正文。' } }
    ] }
    patchSpecFile(dir, specPath, patch, { dryRun: false })
    const first = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
    expect(first.ok === true, '发布失败：' + first.text)
    const html = fs.readFileSync(path.join(dir, 'lessons/one.html'), 'utf8')
    expect(html.includes('改后的正文。'), '页面没有用到 patch 后的内容')
    expect(html.includes('data-node-id="p1"'), '节点 id 没有进页面')
    // 发布之后再改源：页面不变直到下一次 commit（源与发布是两步）。
    patchSpecFile(dir, specPath, { schemaVersion: 1, expectedHash: inspectSpecFile(dir, specPath).expectedHash, operations: [
      { op: 'replace-block', sectionId: 'body', blockId: 'p1', value: { id: 'p1', kind: 'p', text: '第二步修改。' } }
    ] }, { dryRun: false })
    expect(fs.readFileSync(path.join(dir, 'lessons/one.html'), 'utf8').includes('改后的正文。'), '没发布就改了页面')
    const second = await tools.get('teach_commit').execute(commitArgs(specPath, { idempotencyKey: 'verify-key-2' }), EXEC)
    expect(second.ok === true, '第二次发布失败：' + second.text)
    expect(fs.readFileSync(path.join(dir, 'lessons/one.html'), 'utf8').includes('第二步修改。'), '第二次发布没生效')
    return '源改动与发布是两步，两次发布都落到页面；节点 id 保留'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ── G3 / V06–V07 ────────────────────────────────────────
function archiveWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-g-archive-'))
  const archive = openArchive(dir, { create: true })
  return { dir, archive }
}

const runEvent = (archive, index) => ({ changes: [{ type: 'run.state', data: {
  runId: 'run-' + index, runRevision: 1, stage: 'build', pending: [],
  watermarks: { lastSeq: archive.state.lastSeq, lastHash: archive.state.lastHash, lessonRevisions: {} }
} }], result: {} })

await check('V06-1', '快照 + 尾部重放与全量重放状态等价', async () => {
  const { dir, archive } = archiveWorkspace()
  try {
    for (let i = 0; i < 3; i += 1) archive.transact('verify', undefined, () => runEvent(archive, i))
    const info = archive.createSnapshot()
    for (let i = 3; i < 6; i += 1) archive.transact('verify', undefined, () => runEvent(archive, i))
    const fast = openArchive(dir, { repairIndex: false })
    const full = openArchive(dir, { repairIndex: false, useSnapshot: false })
    expect(fast.replayInfo.usedSnapshot === true, '没有用上快照')
    expect(fast.replayInfo.replayedEntries === fast.journalEntries.length - info.seq, '尾部条数不对')
    expect(JSON.stringify(fast.state) === JSON.stringify(full.state), '两种重放的状态不一致')
    expect(fast.journalEntries.length === 7, '来源列表不完整：' + fast.journalEntries.length)
    return '快照水位 ' + info.seq + '，重放尾部 ' + fast.replayInfo.replayedEntries + ' 条，状态一致'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await check('V06-2', '坏快照（校验和/版本/身份/水位）全量回退且不改文件', async () => {
  const { dir, archive } = archiveWorkspace()
  try {
    archive.transact('verify', undefined, () => runEvent(archive, 0))
    const { file } = archive.createSnapshot()
    const base = fs.readFileSync(file, 'utf8')
    const cases = [
      () => '{broken',
      (value) => JSON.stringify({ ...value, version: 99 }),
      (value) => JSON.stringify({ ...value, workspaceId: 'other' }),
      (value) => JSON.stringify({ ...value, seq: 999 })
    ]
    for (const mutate of cases) {
      const text = mutate(JSON.parse(base))
      fs.writeFileSync(file, text)
      const reopened = openArchive(dir, { repairIndex: false })
      expect(reopened.replayInfo.usedSnapshot === false, '坏快照被接受了')
      expect(reopened.state.workspaceId === archive.workspaceId, '状态身份不对')
      expect(fs.readFileSync(file, 'utf8') === text, '回退时改写了快照文件')
    }
    return '4 种坏快照全部回退全量，且未改写文件'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await check('V07-1', '只读打开零写（目录字节不变）', async () => {
  const { dir, archive } = archiveWorkspace()
  try {
    archive.transact('verify', undefined, () => runEvent(archive, 0))
    archive.createSnapshot()
    const before = treeDigest(dir)
    openArchive(dir, { repairIndex: false })
    openArchive(dir, { repairIndex: true, useSnapshot: false })
    const after = treeDigest(dir)
    expect(before === after, '只读打开写了文件')
    return '两次打开（含全量）前后目录摘要一致'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

await check('V07-2', 'rebuild 强制全量；删掉快照后与全量等价', async () => {
  const { dir, archive } = archiveWorkspace()
  try {
    for (let i = 0; i < 2; i += 1) archive.transact('verify', undefined, () => runEvent(archive, i))
    const { file } = archive.createSnapshot()
    const fast = openArchive(dir, { repairIndex: false })
    const full = openArchive(dir, { repairIndex: false, useSnapshot: false })
    archive.rebuild()
    expect(archive.replayInfo.usedSnapshot === false, 'rebuild 用了快照')
    fs.rmSync(file)
    const after = openArchive(dir, { repairIndex: false })
    expect(after.replayInfo.usedSnapshot === false, '删掉快照后仍报命中')
    expect(JSON.stringify(after.state) === JSON.stringify(full.state), '删快照后的状态与全量不一致')
    expect(JSON.stringify(fast.state) === JSON.stringify(full.state), '快照状态与全量不一致')
    return 'rebuild 全量、删快照后等价、快照命中时等价'
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ── 输出 ────────────────────────────────────────────────
const failed = results.filter((item) => !item.ok)
if (json) {
  console.log(JSON.stringify({ head: process.env.GIT_HEAD ?? null, results, failed: failed.length }, null, 2))
} else {
  console.log('HEAD: ' + (process.env.GIT_HEAD ?? '(未设置)') + '  node ' + process.version + '  ' + os.platform())
  for (const item of results) {
    console.log((item.ok ? '✓ ' : '✗ ') + item.id + ' ' + item.label + (item.ok ? ' — ' + item.detail : ' — ' + item.detail))
  }
  console.log('')
  console.log('共 ' + results.length + ' 项：通过 ' + (results.length - failed.length) + '，失败 ' + failed.length)
}
process.exitCode = failed.length === 0 ? 0 : 1
