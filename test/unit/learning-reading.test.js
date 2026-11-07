import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openArchive } from '../../lib/archive/store.js'
import { saveReading, readReading, readingSummary } from '../../lib/archive/reading.js'
test('阅读的最远值和续读位置独立；迟到、恢复、后台和重复消息不抢位置', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-reading-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const archive = openArchive(root, { create: true })
  const id = { workspaceId: archive.workspaceId, collectionId: 'a', lessonId: 'one', contentVersion: 'v1', windowId: 'window-a' }
  const save = (ratio, activeAt, sequence, identity = id, active = true) => saveReading(archive, identity, { ratio, activeAt, sequence, position: { ratio, section: 'section1', offset: .1 }, active }, { now: 10000 })
  save(.8, 100, 1)
  save(.4, 200, 2)
  assert.equal(readReading(archive, id).maxRatio, .8)
  assert.equal(readReading(archive, id).position.ratio, .4)
  save(.9, 150, 1, { ...id, windowId: 'window-b' })
  assert.equal(readReading(archive, id).maxRatio, .9)
  assert.equal(readReading(archive, id).position.ratio, .4)
  save(1, 300, 3, id, false)
  save(.1, 400, 2)
  assert.equal(readReading(archive, id).position.ratio, .4)
  assert.equal(readReading(archive, { ...id, collectionId: 'b' }), null)
  assert.equal(readReading(archive, { ...id, contentVersion: 'v2' }), null)
  assert.deepEqual(readingSummary([{ maxRatio: 1 }, { maxRatio: 1 }, null]), { percent: 67, count: 3, unrecorded: 1 })
  assert.deepEqual(readingSummary([]), { percent: 0, count: 0, unrecorded: 0 })
})
