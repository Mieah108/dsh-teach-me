import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { acquirePathLock, inspectLock } from '../../lib/archive/lock.js'

const directory = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-lock-release-race-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// macOS/APFS 可在 lstat 与另一进程 unlink 竞争时返回 nlink=0 的普通 inode。
// 用真实 unlink + fstat 冻结该快照，确保每次都触发与并发探针相同的分支。
function releaseDuringStat(t, file) {
  const lstat = fs.lstatSync
  let released = false
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    if (target !== file || released) return lstat(target, ...args)
    released = true
    const fd = fs.openSync(file, 'r')
    try {
      fs.unlinkSync(file)
      const stat = fs.fstatSync(fd)
      assert.equal(stat.isFile(), true)
      assert.equal(stat.nlink, 0)
      return stat
    } finally {
      fs.closeSync(fd)
    }
  })
}

test('读取已释放的 nlink=0 普通锁视为不存在，继续竞争而非 validation', (t) => {
  const dir = directory(t)
  const held = acquirePathLock(dir)
  releaseDuringStat(t, held.file)
  const next = acquirePathLock(dir, { timeoutMs: 500, pollMs: 1 })
  assert.notEqual(next.owner, held.owner)
  assert.equal(JSON.parse(fs.readFileSync(next.file)).owner, next.owner)
  next.release()
})

test('inspectLock 在同一释放竞争中返回 null', (t) => {
  const dir = directory(t)
  const held = acquirePathLock(dir)
  releaseDuringStat(t, held.file)
  assert.equal(inspectLock(dir), null)
})

test('仍拒绝真实硬链接和符号链接锁，不读取或删除外部文件', (t) => {
  const outside = path.join(directory(t), 'outside')
  fs.writeFileSync(outside, '{"owner":"external"}')
  for (const kind of ['hardlink', 'symlink']) {
    const dir = directory(t)
    const file = path.join(dir, 'workspace.lock')
    if (kind === 'hardlink') fs.linkSync(outside, file)
    else fs.symlinkSync(outside, file)
    assert.throws(() => inspectLock(dir), (error) => error.code === 'validation')
    assert.throws(() => acquirePathLock(dir, { timeoutMs: 0 }), (error) => error.code === 'validation')
    assert.equal(fs.readFileSync(outside, 'utf8'), '{"owner":"external"}')
    assert.equal(fs.lstatSync(file).isSymbolicLink(), kind === 'symlink')
    fs.unlinkSync(file)
  }
})
