import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { archiveDirOf, legacyArchiveDirOf, openArchive, resolveArchiveDir, tryOpenArchive } from '../../lib/archive/store.js'

/* 0.5.0 把档案从 <根>/.teach 挪进 <根>/.dsh-teach-me/archive：一个工作区只留一个隐藏目录。
 * 这里钉住三件事：新位置就是默认位置、老布局第一次打开时整体搬进来（内容不变）、
 * 挪不动时继续读旧位置而不是在新位置另建一份空档案。 */

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teach-layout-'))
}

/** 造一份"旧布局"档案：真实写一份，再整体挪到 <ws>/.teach。 */
function legacyArchive(factory) {
  const ws = workspace()
  const donor = workspace()
  const archive = openArchive(donor, { create: true })
  factory(archive)
  const legacy = legacyArchiveDirOf(ws)
  fs.renameSync(archiveDirOf(donor), legacy)
  return { ws, archived: archive }
}

test('档案默认落在 <根>/.dsh-teach-me/archive，工作区里不再出现 .teach', () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  assert.equal(fs.realpathSync.native(archive.archiveDir), fs.realpathSync.native(archiveDirOf(ws)))
  assert.equal(fs.existsSync(path.join(ws, '.teach')), false)
  assert.deepEqual(fs.readdirSync(path.join(ws, '.dsh-teach-me')).sort(), ['archive'])
})

test('老布局第一次打开时整体搬进新位置，状态照旧', () => {
  const { ws } = legacyArchive((archive) => {
    archive.transact('test', 1, () => ({ changes: [{ type: 'objective.upsert', data: { id: 'o1', title: '目标 o1' } }], result: {} }))
  })
  assert.equal(fs.existsSync(legacyArchiveDirOf(ws)), true, '前置：旧布局存在')

  const resolved = resolveArchiveDir(ws)
  assert.equal(resolved.migrated, true)
  assert.equal(resolved.dir, archiveDirOf(ws))

  const opened = openArchive(ws)
  assert.equal(fs.existsSync(legacyArchiveDirOf(ws)), false, '旧目录应当已经不存在')
  assert.equal(opened.state.objectives.o1.title, '目标 o1')
  assert.equal(opened.state.revision, 2)
})

test('已经有新布局时不会被旧目录干扰', () => {
  const { ws } = legacyArchive(() => {})
  openArchive(ws) // 触发迁移
  fs.mkdirSync(legacyArchiveDirOf(ws), { recursive: true })
  fs.writeFileSync(path.join(legacyArchiveDirOf(ws), 'workspace.json'), '{"schemaVersion":1,"workspaceId":"ws_old"}')
  const opened = openArchive(ws)
  assert.notEqual(opened.workspaceId, 'ws_old')
  assert.equal(fs.existsSync(legacyArchiveDirOf(ws)), true, '多余的老目录不动它，避免删数据')
})

test('没档案时只读打开仍然不创建任何隐藏目录', () => {
  const ws = workspace()
  assert.equal(tryOpenArchive(ws), null)
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false)
})

test('拒绝隐藏目录父级符号链接，外部目录保持不变', () => {
  const ws = workspace()
  const outside = workspace()
  fs.symlinkSync(outside, path.join(ws, '.dsh-teach-me'))
  assert.throws(() => openArchive(ws, { create: true }), /符号链接/)
  assert.deepEqual(fs.readdirSync(outside), [])
})

test('纯读旧布局不搬目录，损坏索引不创建备份', () => {
  const { ws } = legacyArchive(() => {})
  const legacy = legacyArchiveDirOf(ws)
  fs.writeFileSync(path.join(legacy, 'index.json'), '{bad')
  const opened = tryOpenArchive(ws, { repairIndex: false })
  assert.equal(opened.state.revision, 1)
  assert.equal(fs.existsSync(legacy), true)
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false)
  assert.deepEqual(fs.readdirSync(path.join(legacy, 'backups')), [])
})

test('另一进程先迁移成功时，不返回已消失的旧路径', (t) => {
  const { ws } = legacyArchive(() => {})
  const rename = fs.renameSync
  t.mock.method(fs, 'renameSync', (source, target) => {
    rename(source, target)
    throw Object.assign(new Error('另一进程已移动'), { code: 'ENOENT' })
  })
  assert.equal(resolveArchiveDir(ws).dir, archiveDirOf(ws))
  assert.equal(fs.existsSync(legacyArchiveDirOf(ws)), false)
})

test('纯读不补建缺失的身份文件或空日志中的初始化事件', () => {
  const ws = workspace()
  const archive = openArchive(ws, { create: true })
  const dir = archive.archiveDir
  for (const name of fs.readdirSync(path.join(dir, 'journal'))) fs.unlinkSync(path.join(dir, 'journal', name))
  tryOpenArchive(ws, { repairIndex: false })
  assert.deepEqual(fs.readdirSync(path.join(dir, 'journal')), [])
  fs.unlinkSync(path.join(dir, 'workspace.json'))
  assert.equal(tryOpenArchive(ws, { repairIndex: false }), null)
  assert.equal(fs.existsSync(path.join(dir, 'workspace.json')), false)
})
