import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openArchive, tryOpenArchive } from '../../lib/archive/store.js'
import { inspectJournal, journalFiles, repairPartialTail } from '../../lib/archive/journal.js'
import { ArchiveNotInitializedError, JournalCorruptionError, RevisionConflictError, UnsupportedSchemaError, ValidationError } from '../../lib/archive/errors.js'

const STORE_URL = new URL('../../lib/archive/store.js', import.meta.url).href

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teach-archive-'))
}

function objective(draft, id) {
  return {
    changes: [{ type: 'objective.upsert', data: { id, title: '目标 ' + id } }],
    result: { objectiveId: id }
  }
}

test('首次打开建立身份与初始化事务，重开后身份稳定', () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  assert.match(archive.workspaceId, /^ws_/)
  assert.equal(archive.state.revision, 1)
  assert.equal(archive.state.lastSeq, 1)
  assert.equal(archive.state.mission, null)
  assert.ok(fs.existsSync(path.join(ws, '.dsh-teach-me', 'archive', 'workspace.json')))
  assert.ok(fs.existsSync(path.join(ws, '.dsh-teach-me', 'archive', 'index.json')))
  assert.equal(journalFiles(path.join(ws, '.dsh-teach-me', 'archive')).length, 1)

  const again = openArchive(ws)
  assert.equal(again.workspaceId, archive.workspaceId)
  assert.equal(again.state.revision, 1)
  assert.equal(again.state.createdAt, archive.createdAt)
})

test('只读打开不创建目录，未初始化时明确报未初始化', () => {
  const ws = workspace()
  assert.equal(tryOpenArchive(ws), null)
  assert.ok(!fs.existsSync(path.join(ws, '.dsh-teach-me', 'archive')))
  assert.throws(() => openArchive(ws), ArchiveNotInitializedError)
})

test('索引被删或损坏时从日志重建并保留状态', () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  archive.transact('test', 1, (draft) => objective(draft, 'o1'))
  archive.transact('test', 2, (draft) => objective(draft, 'o2'))
  assert.equal(openArchive(ws).state.objectives.o1.title, '目标 o1')

  fs.rmSync(path.join(ws, '.dsh-teach-me', 'archive', 'index.json'))
  const rebuilt = openArchive(ws)
  assert.equal(rebuilt.state.revision, 3)
  assert.equal(rebuilt.state.objectives.o2.title, '目标 o2')
  assert.ok(rebuilt.warnings.some((line) => line.includes('重建')))

  fs.writeFileSync(path.join(ws, '.dsh-teach-me', 'archive', 'index.json'), '{not json')
  const again = openArchive(ws)
  assert.equal(again.state.revision, 3)
  assert.ok(again.warnings.some((line) => line.includes('索引损坏')))
  const backups = fs.readdirSync(path.join(ws, '.dsh-teach-me', 'archive', 'backups'))
  assert.ok(backups.some((name) => name.endsWith('-index')))
})

test('预期版本不一致时报 revision-conflict，且不写日志', () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  archive.transact('test', 1, (draft) => objective(draft, 'o1'))
  const stale = openArchive(ws)
  assert.equal(stale.state.revision, 2)
  assert.throws(
    () => stale.transact('test', 1, (draft) => objective(draft, 'o2'), { timeoutMs: 200 }),
    (error) => error.code === 'revision-conflict' && error.detail?.expected === 1 && error.detail?.actual === 2
  )
  assert.equal(openArchive(ws).state.revision, 2)
  assert.throws(() => stale.transact('test', 1, (draft) => objective(draft, 'o2')), RevisionConflictError)
})

test('日志最后半行：打开即报错，显式修复前备份，修复后保留已确认提交', () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  archive.transact('test', 1, (draft) => objective(draft, 'o1'))
  const [file] = journalFiles(path.join(ws, '.dsh-teach-me', 'archive'))
  fs.appendFileSync(file, '{"v":1,"seq":3')
  const inspected = inspectJournal(path.join(ws, '.dsh-teach-me', 'archive'))
  assert.equal(inspected.partialTail, true)
  assert.equal(inspected.complete, false)

  assert.throws(
    () => openArchive(ws),
    (error) => error.code === 'journal-corruption' && error.detail?.kind === 'partial-tail'
  )
  const repaired = repairPartialTail(path.join(ws, '.dsh-teach-me', 'archive'))
  assert.equal(repaired.repaired, true)
  assert.ok(fs.existsSync(repaired.backup))
  assert.ok(fs.readdirSync(repaired.backup).includes('journal'))

  const reopened = openArchive(ws)
  assert.equal(reopened.state.revision, 2)
  assert.equal(reopened.state.objectives.o1.title, '目标 o1')
  assert.equal(inspectJournal(path.join(ws, '.dsh-teach-me', 'archive')).complete, true)
})

test('schema 0 迁移先整份备份再升级，日志补初始化', () => {
  const ws = workspace()
  const dir = path.join(ws, '.dsh-teach-me', 'archive')
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'locks'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ schemaVersion: 0, workspaceId: 'ws_legacy', createdAt: '2026-01-01T00:00:00.000Z' }))
  const archive = openArchive(ws)
  assert.equal(archive.workspaceId, 'ws_legacy')
  assert.equal(archive.state.revision, 1)
  const identity = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'))
  assert.equal(identity.schemaVersion, 1)
  assert.equal(identity.migratedFrom, 0)
  assert.ok(fs.existsSync(identity.migrationBackup))
  assert.ok(fs.existsSync(path.join(identity.migrationBackup, 'workspace.json')))
})

test('schema 高于支持版本时拒绝打开，不降级读', () => {
  const ws = workspace()
  const dir = path.join(ws, '.dsh-teach-me', 'archive')
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ schemaVersion: 99, workspaceId: 'ws_future', createdAt: '2026-01-01T00:00:00.000Z' }))
  assert.throws(() => openArchive(ws), UnsupportedSchemaError)
})

test('.dsh-teach-me 是符号链接时拒绝写入别处', () => {
  const ws = workspace()
  const outside = workspace()
  fs.mkdirSync(path.join(ws, '.dsh-teach-me'), { recursive: true })
  fs.symlinkSync(outside, path.join(ws, '.dsh-teach-me', 'archive'))
  assert.throws(() => openArchive(ws, { create: true }), ValidationError)
})

test('两个进程同时写：锁串行，只有拿到预期版本的那个提交', async () => {
  const ws = workspace()
  openArchive(ws, { create: true })
  const code = (id) => [
    'import { openArchive } from ' + JSON.stringify(STORE_URL) + ';',
    'const archive = openArchive(' + JSON.stringify(ws) + ');',
    'try {',
    '  archive.transact("child", 1, () => ({ changes: [{ type: "objective.upsert", data: { id: ' + JSON.stringify(id) + ', title: "并发目标" } }], result: {} }));',
    '  console.log("committed");',
    '} catch (error) { console.log("failed:" + error.code); }'
  ].join('\n')
  const run = (childCode) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk) => { out += chunk })
      child.stderr.on('data', (chunk) => { err += chunk })
      child.on('error', reject)
      child.on('close', (codeValue) => resolve({ code: codeValue, out: out.trim(), err }))
    })
  const results = await Promise.all([run(code('o-a')), run(code('o-b'))])
  const lines = results.map((item) => item.out).sort()
  assert.deepEqual(lines, ['committed', 'failed:revision-conflict'])
  const archive = openArchive(ws)
  assert.equal(archive.state.revision, 2)
  assert.equal(Object.keys(archive.state.objectives).length, 1)
})

test('同一个进程内连续事务序号、版本、哈希链连续', () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  archive.transact('test', 1, (draft) => objective(draft, 'o1'))
  archive.transact('test', 2, (draft) => objective(draft, 'o2'))
  const again = openArchive(ws)
  assert.equal(again.state.revision, 3)
  assert.equal(again.state.lastSeq, 3)
  assert.match(again.state.lastHash, /^[a-f0-9]{64}$/)
  assert.throws(() => again.transact('test', 1, (draft) => objective(draft, 'o3')), RevisionConflictError)
})
