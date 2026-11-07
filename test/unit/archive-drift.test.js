import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inspectAssetDrift } from '../../lib/archive/drift.js'
import { publishLesson } from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import { registerLintTool } from '../../lib/lint.js'

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-drift-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'assets'))
  fs.writeFileSync(path.join(root, 'assets', 'a.js'), 'a')
  fs.writeFileSync(path.join(root, 'one.html'), '<script src="assets/a.js"></script>')
  return root
}
const publish = (root, lessonId = 'l1', file = 'one.html') => publishLesson(root, { lessonId, path: file })

test('drift：无档案 / 空档案不扫未登记（新工作区零噪音），只读不建目录', (t) => {
  const root = setup(t)
  // 新工作区第一次开课：assets/ 里的运行资源还没被任何课程登记，逐条报"未登记"是纯噪音。
  const first = inspectAssetDrift(root)
  assert.equal(first.errors, 0)
  assert.deepEqual(first.issues, [])
  assert.equal(fs.existsSync(path.join(root, '.dsh-teach-me')), false)
  // 建了档案但还没有课：同样没有"已发布"可比，也不报。
  const archive = openArchive(root, { create: true })
  assert.deepEqual(inspectAssetDrift(root).issues, [])
  const index = path.join(archive.path, 'index.json')
  fs.unlinkSync(index)
  assert.equal(inspectAssetDrift(root).errors, 0)
  assert.equal(fs.existsSync(index), false)
})

test('drift：有已发布课程后才扫未登记，用户文件报未登记而不是"废弃"', (t) => {
  const root = setup(t)
  publish(root)
  fs.writeFileSync(path.join(root, 'assets', 'user-figure.png'), 'png')
  const result = inspectAssetDrift(root)
  const unregistered = result.issues.filter((item) => item.code === 'asset-unregistered')
  assert.deepEqual(unregistered.map((item) => item.path), ['assets/user-figure.png'])
  assert.equal(unregistered[0].level, 'warn')
  assert.match(unregistered[0].message, /未登记/)
  assert.doesNotMatch(unregistered[0].message, /废弃/)
})

test('drift：共享运行资源（course.css/course.js/mathjax）变化只报提醒，不阻断 lint', (t) => {
  const root = setup(t)
  fs.writeFileSync(path.join(root, 'assets', 'course.css'), 'a{}')
  fs.writeFileSync(path.join(root, 'assets', 'course.js'), 'void 0')
  fs.writeFileSync(
    path.join(root, 'shared.html'),
    '<link rel="stylesheet" href="assets/course.css"><script src="assets/course.js"></script><script src="assets/a.js"></script>'
  )
  publish(root, 'l1', 'shared.html')
  fs.writeFileSync(path.join(root, 'assets', 'course.css'), 'b{}')
  const result = inspectAssetDrift(root)
  const drift = result.issues.find((item) => item.path === 'assets/course.css')
  assert.equal(drift.code, 'asset-shared-drift')
  assert.equal(drift.level, 'warn')
  assert.equal(result.errors, 0, '改一次共享样式不该让所有课的 lint 变成硬伤')
  // 页面自己的资产仍是硬伤
  fs.writeFileSync(path.join(root, 'assets', 'a.js'), 'changed')
  assert.equal(inspectAssetDrift(root).errors, 1)
})

test('drift：哈希不符和缺失，报告路径与哈希，保持文件和日志不变', (t) => {
  const root = setup(t)
  publish(root)
  const archive = openArchive(root)
  const before = archive.state.lastSeq
  fs.writeFileSync(path.join(root, 'assets', 'a.js'), 'b')
  const result = inspectAssetDrift(root)
  assert.equal(result.errors, 1)
  assert.equal(result.issues[0].path, 'assets/a.js')
  assert.match(result.issues[0].message, /期望 [0-9a-f]{8}，实际 [0-9a-f]{8}/)
  assert.equal(fs.readFileSync(path.join(root, 'assets', 'a.js'), 'utf8'), 'b')
  assert.equal(openArchive(root).state.lastSeq, before)
  fs.unlinkSync(path.join(root, 'assets', 'a.js'))
  assert.equal(inspectAssetDrift(root).issues[0].code, 'asset-missing')
})

test('drift：当前课程manifest并集保护共享资源，旧manifest哈希差异仍报告', (t) => {
  const root = setup(t)
  publish(root)
  fs.writeFileSync(path.join(root, 'assets', 'b.js'), 'b')
  fs.writeFileSync(path.join(root, 'two.html'), '<script src="assets/b.js"></script>')
  publish(root, 'l2', 'two.html')
  assert.deepEqual(inspectAssetDrift(root).issues, [])
  fs.writeFileSync(path.join(root, 'three.html'), '<script src="assets/a.js"></script>')
  publish(root, 'l3', 'three.html')
  fs.writeFileSync(path.join(root, 'assets', 'a.js'), 'new')
  publish(root)
  assert.equal(inspectAssetDrift(root).errors, 1, '另一课仍引用旧hash，不能静默接受')
})

test('drift：目录/文件链接均不遍历，根assets链接也不读取', (t) => {
  const root = setup(t)
  publish(root)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-drift-out-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'secret'), 'secret')
  fs.unlinkSync(path.join(root, 'assets', 'a.js'))
  fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'assets', 'a.js'))
  fs.symlinkSync(outside, path.join(root, 'assets', 'linked'))
  const result = inspectAssetDrift(root)
  assert.equal(result.errors, 1)
  assert.equal(result.issues.find((item) => item.path === 'assets/a.js').code, 'asset-unreadable')
  assert.equal(result.issues.some((item) => item.path.includes('secret')), false)
  fs.rmSync(path.join(root, 'assets'), { recursive: true })
  fs.symlinkSync(outside, path.join(root, 'assets'))
  assert.ok(inspectAssetDrift(root).issues.some((item) => item.code === 'asset-directory-unsafe'))
})

test('drift：提供state快照时不读/不改档案，结果顺序固定', (t) => {
  const root = setup(t)
  publish(root)
  fs.writeFileSync(path.join(root, 'assets', '0.js'), 'zero')
  const state = openArchive(root, { repairIndex: false }).state
  const lastSeq = state.lastSeq
  const first = inspectAssetDrift(root, { state })
  assert.deepEqual(first, inspectAssetDrift(root, { state }))
  assert.deepEqual(first.issues.filter((item) => item.code === 'asset-unregistered').map((item) => item.path), ['assets/0.js'])
  assert.equal(openArchive(root, { repairIndex: false }).state.lastSeq, lastSeq, '快照读取不能推进档案')
})

test('lesson_lint：未登记文件聚合成一行（几十张配图不刷屏）', async (t) => {
  const root = setup(t)
  publish(root)
  for (let i = 0; i < 30; i += 1) fs.writeFileSync(path.join(root, 'assets', 'img-' + i + '.png'), 'x')
  let tool
  registerLintTool({ tools: { register: (value) => { tool = value } }, effect: (fn) => fn() }, { tools: { lint: true } }, () => root)
  const result = await tool.execute({ paths: ['one.html'] }, {})
  const unregisteredLines = result.text.split('\n').filter((line) => line.includes('未登记'))
  assert.equal(unregisteredLines.length, 1, '30 个文件只应占一行')
  assert.match(unregisteredLines[0], /30 个未登记文件（示例：assets\/img-0\.png/)
  assert.match(result.text, /其中资产 drift 贡献 0 个硬伤、30 条提醒，不在上面的文件计数里/)
})

test('lesson_lint：指定单文件时仍说明工作区drift范围并计入硬伤', async (t) => {
  const root = setup(t)
  publish(root)
  fs.writeFileSync(path.join(root, 'assets', 'a.js'), 'changed')
  let tool
  registerLintTool({ tools: { register: (value) => { tool = value } }, effect: (fn) => fn() }, { tools: { lint: true } }, () => root)
  const result = await tool.execute({ paths: ['one.html'] }, {})
  assert.match(result.text, /资产 drift（工作区全部已发布课程/)
  assert.match(result.text, /assets\/a.js:0.*资产哈希变化/)
  assert.ok(result.errors >= 1)
})
