import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { publishLesson, registerQuestion } from '../../lib/archive/operations.js'
import { manageCollection } from '../../lib/archive/collections.js'
import { registerClassroom } from '../../lib/classroom/service.js'
import { callRpc } from '../helpers/classroom-rpc.js'
import { withLearningScope } from '../../lib/archive/learning-scope.js'
import { openArchive } from '../../lib/archive/store.js'
test('课堂票固定集合和内容版本，换集合/发布新版后原课堂仍可阅读提交，导入拒绝其他集合', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teach-learning-rpc-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lessons'))
  fs.writeFileSync(path.join(root, 'lessons/one.html'), '<html><body>旧版</body></html>')
  publishLesson(root, { lessonId: 'one', path: 'lessons/one.html' })
  registerQuestion(root, { questionId: 'q', lessonId: 'one', type: 'short', prompt: '题', answer: 'a' })
  manageCollection(root, { action: 'copy', id: 'second', name: '第二次' })
  let selected = 'default', route
  registerClassroom({ get: (key) => ({ webServer: { register: (value) => { route = value } }, connection: { requestRejection: () => undefined }, sessions: { get: () => ({ header: { cwd: root } }) }, teachPreferences: { ensure: async () => ({ collections: { [root]: selected } }) } })[key], effect: (factory) => factory() })
  const rpc = async (name, value, token) => (await callRpc(route, name, { sessionId: 's1', ...value }, { ticket: false, headers: token ? { 'x-teach-classroom': token } : {} })).result
  const opened = await rpc('classroom/open', { lessonId: 'one' })
  assert.equal(opened.ok, true, JSON.stringify(opened))
  const token = opened.value.url.split('/')[2]
  selected = 'second'
  fs.writeFileSync(path.join(root, 'lessons/one.html'), '<html><body>新版</body></html>')
  publishLesson(root, { lessonId: 'one', path: 'lessons/one.html' })
  const reading = await rpc('classroom/reading', { lessonId: 'one', ratio: .8, position: { ratio: .4 }, activeAt: Date.now(), active: true, sequence: 1 }, token)
  assert.equal(reading.ok, true, JSON.stringify(reading))
  assert.equal(reading.value.maxRatio, .8)
  const submitted = await rpc('classroom/submit', { lessonId: 'one', revision: opened.value.revision, questionId: 'q', rawAnswer: 'a' }, token)
  assert.equal(submitted.ok, true, JSON.stringify(submitted))
  assert.equal(withLearningScope({ collectionId: 'second' }, () => Object.keys(openArchive(root).state.submissions).length), 0)
  const imported = await rpc('classroom/import', { data: { version: 1, lessonId: 'one', collectionId: 'second', items: [] } }, token)
  assert.equal(imported.ok, false)
  const current = await rpc('classroom/catalog', {})
  assert.equal(current.value.collectionId, 'second')
  assert.equal(current.value.reading.percent, 0)
  assert.equal(current.value.reading.unrecorded, 1)
  const old = await rpc('classroom/open', { lessonId: 'one', collectionId: 'default', contentVersion: opened.value.contentVersion })
  assert.equal(old.value.reading.maxRatio, .8)
  assert.equal(old.value.reading.position.ratio, .4)
})
