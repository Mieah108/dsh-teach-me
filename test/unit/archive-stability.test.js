import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { atomicWrite } from '../../lib/archive/util.js'
import { recordSelfReport } from '../../lib/archive/operations.js'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openArchive } from '../../lib/archive/store.js'
import { acquireLock } from '../../lib/archive/lock.js'
import { canonicalJson } from '../../lib/archive/util.js'

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'teach-stability-'))
const change = (id, at) => ({ changes: [{ type: 'objective.upsert', data: { id, title: id } }], result: { id }, at })

test('索引 JSON 合法但内容被改写时，以日志重放结果为准', () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  archive.transact('test', undefined, () => change('o1'))
  const file = path.join(archive.path, 'index.json')
  const index = JSON.parse(fs.readFileSync(file))
  index.state.objectives.o1.title = '伪造标题'
  index.state.revision = 1000
  fs.writeFileSync(file, JSON.stringify(index))
  const reopened = openArchive(ws)
  assert.equal(reopened.state.objectives.o1.title, 'o1')
  assert.equal(reopened.state.revision, 2)
})

test('日志已 fsync、索引替换失败时仍报告已提交，重开可恢复', (t) => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === path.join(archive.path, 'index.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    return rename(source, target)
  })
  const result = archive.transact('test', undefined, () => change('o1'))
  assert.equal(result.committed, true)
  assert.equal(archive.state.revision, 2)
  assert.ok(archive.warnings.some((text) => text.includes('索引')))
  t.mock.restoreAll()
  assert.equal(openArchive(ws).state.objectives.o1.title, 'o1')
})

test('月度日志在系统时间回拨后仍按提交顺序重放', () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  archive.transact('test', undefined, () => change('future', '2035-03-01T00:00:00.000Z'))
  archive.transact('test', undefined, () => change('past', '2035-02-01T00:00:00.000Z'))
  const reopened = openArchive(ws)
  assert.equal(reopened.state.revision, 3)
  assert.equal(reopened.state.objectives.past.title, 'past')
})

test('稀疏数组的 canonical JSON 与落盘 JSON 一致', () => {
  const values = new Array(3)
  values[1] = 'x'
  assert.equal(canonicalJson(values), canonicalJson(JSON.parse(JSON.stringify(values))))
})

test('保留字 constructor 可作为课程/目标标识，不继承对象原型条目', () => {
  const archive = openArchive(workspace(), { create: true })
  assert.equal(archive.state.lessons.constructor, undefined)
  archive.transact('test', undefined, () => change('constructor'))
  assert.equal(Object.hasOwn(archive.state.objectives, 'constructor'), true)
})

test('零等待的无竞争锁允许一次获取', () => {
  const archive = openArchive(workspace(), { create: true })
  const lock = acquireLock(archive.path, { timeoutMs: 0 })
  lock.release()
})

test('内部 journal 目录或日志文件不能是符号链接', () => {
  for (const kind of ['directory', 'file']) {
    const ws = workspace()
    const archive = openArchive(ws, { create: true })
    const journal = path.join(archive.path, 'journal')
    const source = kind === 'directory' ? journal : path.join(journal, fs.readdirSync(journal)[0])
    const target = path.join(workspace(), path.basename(source))
    fs.renameSync(source, target)
    fs.symlinkSync(target, source)
    assert.throws(() => openArchive(ws), /符号链接|普通文件/)
  }
})

test('迁移不挪动有写锁的旧档案，释放后再迁移，旧句柄仍可写', () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  const legacy = path.join(ws, '.teach')
  fs.renameSync(archive.path, legacy)
  const lock = acquireLock(legacy)
  try {
    assert.equal(openArchive(ws).path, fs.realpathSync(legacy))
    assert.equal(fs.existsSync(legacy), true)
  } finally { lock.release() }
  const moved = openArchive(ws)
  assert.notEqual(moved.path, legacy)
  archive.transact('test', undefined, () => change('after-move'))
  assert.equal(openArchive(ws).state.objectives['after-move'].title, 'after-move')
  assert.equal(fs.existsSync(legacy), false)
})

test('失效锁回收有独占围栏，不允许另一个回收者进入', (t) => {
  const archive = openArchive(workspace(), { create: true })
  const lockFile = path.join(archive.path, 'locks/workspace.lock')
  fs.writeFileSync(lockFile, JSON.stringify({ host: os.hostname(), pid: 2147483647, owner: 'stale' }))
  const unlink = fs.unlinkSync
  let checked = false
  t.mock.method(fs, 'unlinkSync', (file) => {
    if (file === lockFile && !checked) {
      checked = true
      assert.throws(() => acquireLock(archive.path, { timeoutMs: 0 }), (error) => error.code === 'workspace-locked')
    }
    return unlink(file)
  })
  const lock = acquireLock(archive.path)
  assert.equal(checked, true)
  assert.equal(JSON.parse(fs.readFileSync(lockFile)).owner, lock.owner)
  lock.release()
})

test('锁 JSON 缺有效 pid 时不自动回收；残留回收锁不会被绕过', () => {
  const archive = openArchive(workspace(), { create: true })
  const file = path.join(archive.path, 'locks/workspace.lock')
  fs.writeFileSync(file, JSON.stringify({ host: os.hostname() }))
  assert.throws(() => acquireLock(archive.path, { timeoutMs: 0 }), (error) => error.code === 'workspace-locked')
  fs.unlinkSync(file)
  fs.writeFileSync(path.join(archive.path, 'locks/workspace.lock.reclaim'), '{}')
  assert.throws(() => acquireLock(archive.path, { timeoutMs: 0 }), (error) => error.code === 'workspace-locked')
})


test('四个进程同时首次初始化并写入，身份一致且没有丢提交', async () => {
  const ws = workspace()
  const url = new URL('../../lib/archive/store.js', import.meta.url).href
  const jobs = Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
    const code = `import {openArchive} from ${JSON.stringify(url)}; const a=openArchive(${JSON.stringify(ws)}, {create:true}); a.transact('child',undefined,()=>({changes:[{type:'objective.upsert',data:{id:'o${index}',title:'o${index}'}}],result:{}})); console.log(a.workspaceId)`
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (part) => { out += part })
    child.stderr.on('data', (part) => { err += part })
    child.on('error', reject)
    child.on('close', (exit) => exit === 0 ? resolve(out.trim()) : reject(new Error(err)))
  }))
  const ids = await Promise.all(jobs)
  assert.equal(new Set(ids).size, 1)
  const a = openArchive(ws)
  assert.equal(a.state.revision, 5)
  assert.equal(Object.keys(a.state.objectives).length, 4)
})

test('原子文件写入失败时清理临时文件，保留原目标', (t) => {
  const dir = workspace()
  const target = path.join(dir, 'target.json')
  fs.writeFileSync(target, 'original')
  t.mock.method(fs, 'fsyncSync', () => { throw new Error('disk failure') })
  assert.throws(() => atomicWrite(target, 'replacement'), /disk failure/)
  assert.deepEqual(fs.readdirSync(dir), ['target.json'])
  assert.equal(fs.readFileSync(target, 'utf8'), 'original')
})

test('自报同 id 同 claim 但不同题目时必须冲突', () => {
  const ws = workspace()
  recordSelfReport(ws, { id: 'r1', questionId: 'q1', claim: '已会' })
  assert.throws(() => recordSelfReport(ws, { id: 'r1', questionId: 'q2', claim: '已会' }), (error) => error.code === 'idempotency-conflict')
})

test('离线 CLI --status 不迁移旧布局或写回索引', async () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  const legacy = path.join(ws, '.teach')
  fs.renameSync(archive.path, legacy)
  const script = new URL('../../scripts/teach-workspace.mjs', import.meta.url)
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script.pathname, '--workspace', ws, '--status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', error = ''
    child.stdout.on('data', (part) => { output += part })
    child.stderr.on('data', (part) => { error += part })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)))
  })
  assert.equal(result.initialized, true)
  assert.equal(fs.existsSync(legacy), true)
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me/archive')), false)
})
