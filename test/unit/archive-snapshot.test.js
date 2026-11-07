// G3：待执行回归；本批不运行。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openArchive } from '../../lib/archive/store.js'
import { journalFiles } from '../../lib/archive/journal.js'
import { canonicalJson } from '../../lib/archive/util.js'

function workspace(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-snapshot-'))
  try { run(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test('G3：显式生成不改日志，快照+尾部等价全量，来源列表完整', () => workspace((root) => {
  const archive = openArchive(root, { create: true })
  const journal = journalFiles(archive.path)[0]
  const bytes = fs.readFileSync(journal, 'utf8')
  const info = archive.createSnapshot()
  assert.equal(info.seq, 1)
  assert.equal(fs.readFileSync(journal, 'utf8'), bytes)
  archive.transact('test', undefined, () => ({ changes: [{ type: 'run.state', data: {
    runId: 'test-run', runRevision: 1, stage: 'build', pending: [],
    watermarks: { lastSeq: 1, lastHash: archive.state.lastHash, lessonRevisions: {} }
  } }], result: {} }))
  const fast = openArchive(root, { repairIndex: false })
  const full = openArchive(root, { repairIndex: false, useSnapshot: false })
  assert.equal(canonicalJson(fast.state), canonicalJson(full.state))
  assert.equal(fast.replayInfo.usedSnapshot, true)
  assert.equal(fast.replayInfo.replayedEntries, 1)
  assert.equal(fast.journalEntries.length, 2)
  assert.equal(Object.getPrototypeOf(fast.state.lessons), null)
  assert.equal(fast.state.runs['test-run'].stage, 'build')
}))

test('G3：损坏、错身份、投影器变化或过新快照回退全量；不修写文件', () => workspace((root) => {
  const archive = openArchive(root, { create: true })
  const { file } = archive.createSnapshot()
  const bytes = fs.readFileSync(file, 'utf8')
  for (const mutate of [
    () => '{broken',
    (value) => JSON.stringify({ ...value, version: 999 }),
    (value) => JSON.stringify({ ...value, workspaceId: 'wrong' }),
    (value) => JSON.stringify({ ...value, projector: 'old' }),
    (value) => JSON.stringify({ ...value, seq: 999 }),
    (value) => JSON.stringify({ ...value, state: { ...value.state, mission: 'corrupt' } })
  ]) {
    const changed = mutate(JSON.parse(bytes))
    fs.writeFileSync(file, changed)
    const recovered = openArchive(root, { repairIndex: false })
    assert.equal(recovered.replayInfo.usedSnapshot, false)
    assert.equal(recovered.state.mission, null)
    assert.equal(fs.readFileSync(file, 'utf8'), changed)
  }
}))

test('G3：已有快照也不能掩盖前缀日志篡改或半行；rebuild 不信缓存', () => workspace((root) => {
  const archive = openArchive(root, { create: true })
  archive.createSnapshot()
  archive.rebuild()
  assert.equal(archive.replayInfo.usedSnapshot, false)
  const journal = journalFiles(archive.path)[0]
  const original = fs.readFileSync(journal, 'utf8')
  const entry = JSON.parse(original.trim())
  entry.actor = 'changed'
  fs.writeFileSync(journal, JSON.stringify(entry) + '\n')
  assert.throws(() => openArchive(root, { repairIndex: false }), /哈希/)
  fs.writeFileSync(journal, original + '{partial')
  assert.throws(() => openArchive(root, { repairIndex: false }), /没有写完/)
}))

test('G3：快照是可丢弃缓存，删除后和旧版本一样全量重放', () => workspace((root) => {
  const archive = openArchive(root, { create: true })
  const { file } = archive.createSnapshot()
  fs.unlinkSync(file)
  const reopened = openArchive(root, { repairIndex: false })
  assert.equal(reopened.replayInfo.usedSnapshot, false)
  assert.equal(reopened.replayInfo.fallbackReason, 'missing')
  assert.equal(canonicalJson(reopened.state), canonicalJson(archive.state))
}))
test('G3：快照失效提示只留一条，不随锁内重读重复累积', () => workspace((root) => {
  const archive = openArchive(root, { create: true })
  const { file } = archive.createSnapshot()
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  value.state.mission = 'X'
  fs.writeFileSync(file, JSON.stringify(value))
  for (let i = 0; i < 3; i += 1) {
    archive.transact('test', undefined, () => ({ changes: [{ type: 'run.state', data: {
      runId: 'r' + i, runRevision: 1, stage: 'build', pending: [],
      watermarks: { lastSeq: archive.state.lastSeq, lastHash: archive.state.lastHash, lessonRevisions: {} }
    } }], result: {} }))
  }
  assert.equal(archive.warnings.filter((line) => line.includes('快照不可用')).length, 1)
}))
