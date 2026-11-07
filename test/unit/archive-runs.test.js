import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ValidationError } from '../../lib/archive/errors.js'
import { publishLesson } from '../../lib/archive/operations.js'
import { planRunState, runStateOf, watermarksOf } from '../../lib/archive/runs.js'
import { openArchive } from '../../lib/archive/store.js'
import { EVENT_VERSION, SCHEMA_VERSION, applyChange, emptyRunProjection, emptyState } from '../../lib/archive/state.js'

const HTML = '<html><body><div class="quiz" data-question-id="q1">题</div></body></html>'

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-runs-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML)
  return ws
}

function stateWithRun(change, state = emptyState()) {
  return applyChange(state, change, { at: '2026-10-28T00:00:00.000Z', actor: 'test', seq: 1 })
}

function runChange(overrides = {}) {
  return {
    type: 'run.state',
    data: {
      runId: 'agent-1',
      runRevision: 1,
      stage: 'plan',
      pending: [{ id: 'p1', kind: 'approval', label: '等学习者点头' }],
      watermarks: { lastSeq: 3, lastHash: 'a'.repeat(64), lessonRevisions: { l1: 2 } },
      at: '2026-10-28T00:00:00.000Z',
      ...overrides
    }
  }
}

/** 在一个真实档案里写一条 run.state（走 transact 的写路径，不绕过校验）。 */
function transactRun(ws, runId, stage, extra = {}) {
  const archive = openArchive(ws, { create: false })
  return archive.transact('teach_stage', undefined, (draft) => {
    const watermarks = watermarksOf(archive, Object.keys(draft.lessons))
    const planned = planRunState({ state: draft, runId, stage, pending: [], watermarks, ...extra })
    return { changes: [planned.change], result: { runRevision: planned.runRevision } }
  })
}

test('run.state 写入投影：revision 单调递增，两个 runId 互不影响', () => {
  let state = stateWithRun(runChange())
  assert.equal(state.runs['agent-1'].revision, 1)
  assert.equal(state.runs['agent-1'].stage, 'plan')
  assert.deepEqual(state.runs['agent-1'].pending, [{ id: 'p1', kind: 'approval', label: '等学习者点头' }])
  assert.equal(state.runs['agent-1'].watermarks.lastSeq, 3)
  assert.equal(state.runs['agent-1'].watermarks.lessonRevisions.l1, 2)

  state = stateWithRun(runChange({ runRevision: 2, stage: 'build' }), state)
  assert.equal(state.runs['agent-1'].revision, 2)
  assert.equal(state.runs['agent-1'].stage, 'build')
  assert.equal(state.runs['agent-1'].updatedAt, '2026-10-28T00:00:00.000Z')

  state = stateWithRun(runChange({ runId: 'agent-2' }), state)
  assert.equal(state.runs['agent-2'].revision, 1)
  assert.equal(state.runs['agent-1'].revision, 2, '别的 run 写入不能推高这个 run 的版本')
})

test('run.state 校验：倒退、跳号、缺字段一律 fail', () => {
  const first = stateWithRun(runChange())
  assert.throws(() => stateWithRun(runChange({ runRevision: 1 }), first), (error) => error instanceof ValidationError && /上一次 \+1/.test(error.message))
  assert.throws(() => stateWithRun(runChange({ runRevision: 3 }), first), ValidationError)
  assert.throws(() => stateWithRun(runChange({ runRevision: -1 })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ runRevision: '1' })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ runId: 'bad id', runRevision: 1 })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ stage: '' })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ stage: 'x'.repeat(65) })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ at: 'not-a-date' })), ValidationError)
})

test('run.state 校验：pending 结构、上限与 label 长度', () => {
  assert.doesNotThrow(() => stateWithRun(runChange({ pending: [] })))
  assert.doesNotThrow(() => stateWithRun(runChange({ pending: undefined })))
  assert.throws(() => stateWithRun(runChange({ pending: 'x' })), ValidationError)
  assert.throws(
    () => stateWithRun(runChange({ pending: Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i, kind: 'approval' })) })),
    (error) => error instanceof ValidationError && /最多 5 条/.test(error.message)
  )
  assert.throws(() => stateWithRun(runChange({ pending: [{ kind: 'approval' }] })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ pending: [{ id: 'p1' }] })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ pending: [{ id: 'p1', kind: 'approval', label: 'x'.repeat(121) }] })), ValidationError)
})

test('run.state 校验：watermarks 只记录也要形状正确', () => {
  assert.doesNotThrow(() => stateWithRun(runChange({ watermarks: { lastSeq: null, lastHash: null, lessonRevisions: {} } })))
  assert.doesNotThrow(() => stateWithRun(runChange({ watermarks: { lastSeq: 0, lastHash: 'genesis', lessonRevisions: {} } })))
  assert.throws(() => stateWithRun(runChange({ watermarks: null })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ watermarks: { lastSeq: -1, lastHash: null, lessonRevisions: {} } })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ watermarks: { lastSeq: 1.5, lastHash: null, lessonRevisions: {} } })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ watermarks: { lastSeq: 1, lastHash: 'nope', lessonRevisions: {} } })), ValidationError)
  assert.throws(() => stateWithRun(runChange({ watermarks: { lastSeq: 1, lastHash: null, lessonRevisions: { l1: 0 } } })), ValidationError)
  assert.throws(
    () =>
      stateWithRun(
        runChange({ watermarks: { lastSeq: 1, lastHash: null, lessonRevisions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['l' + i, 1])) } })
      ),
    (error) => error instanceof ValidationError && /最多 8 项/.test(error.message)
  )
})

test('run.state 走 transact 落日志，重放后投影一致且不影响其它档案状态', () => {
  const ws = workspace()
  openArchive(ws, { create: true })
  publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })

  const written = transactRun(ws, 'agent-1', 'plan')
  assert.equal(written.runRevision, 1)
  assert.equal(written.committed, true)

  const reopened = openArchive(ws, { create: false })
  const projection = runStateOf(reopened.state, 'agent-1')
  assert.equal(projection.revision, 1)
  assert.equal(projection.stage, 'plan')
  assert.deepEqual(projection.pending, [])
  assert.equal(projection.watermarks.lessonRevisions.l1, 1, 'watermarks 记下课程当前 revision')
  assert.equal(projection.watermarks.lastSeq, reopened.state.lastSeq - 1, 'watermark 是写入前的 journal 位置')
  assert.deepEqual(Object.keys(reopened.state.lessons), ['l1'], '其它投影不受影响')
  assert.deepEqual(reopened.toleratedChanges, [], '本版本认识的 run.state 不该被跳过')

  const second = transactRun(ws, 'agent-1', 'build')
  assert.equal(second.runRevision, 2)
  const third = transactRun(ws, 'agent-2', 'intake')
  assert.equal(third.runRevision, 1)
  const after = openArchive(ws, { create: false }).state
  assert.equal(runStateOf(after, 'agent-1').revision, 2)
  assert.equal(runStateOf(after, 'agent-2').revision, 1)
})

test('老档案没有 runs 根键：读得到 null、不报错、不因升级重写索引形状', () => {
  const ws = workspace()
  openArchive(ws, { create: true })
  publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  const archive = openArchive(ws, { create: false })
  assert.equal(archive.state.runs, undefined, '旧档案不该被补上 runs 根键（不迁移）')
  assert.equal(runStateOf(archive.state, 'agent-1'), null)
  assert.deepEqual(archive.warnings, [], '没有 run.state 的老档案打开时不该有任何重建警告')
  // 投影里的字典是 null prototype（按 id 索引的语义），比较前走一遍 JSON。
  assert.deepEqual(JSON.parse(JSON.stringify(emptyRunProjection())), {
    revision: 0,
    stage: null,
    pending: [],
    watermarks: { lastSeq: null, lastHash: null, lessonRevisions: {} },
    updatedAt: null
  })
})

test('planRunState 与 watermarksOf：不写盘、只算事件与数据水位', () => {
  const ws = workspace()
  openArchive(ws, { create: true })
  publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML + '<!-- changed -->')
  publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  const archive = openArchive(ws, { create: false })
  const before = archive.state.revision

  const planned = planRunState({
    state: archive.state,
    runId: 'agent-1',
    stage: 'diagnose',
    watermarks: watermarksOf(archive, ['l1', 'missing'])
  })
  assert.equal(planned.runRevision, 1)
  assert.equal(planned.change.type, 'run.state')
  assert.equal(planned.change.data.runRevision, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(planned.change.data.watermarks.lessonRevisions)), { l1: 2 })
  assert.equal(planned.change.data.watermarks.lastSeq, archive.state.lastSeq)
  assert.equal(openArchive(ws, { create: false }).state.revision, before, '规划不写盘')
})

test('事件版本不动：run.state 不是 schema 升级（老档案照读，不迁移）', () => {
  assert.equal(SCHEMA_VERSION, 1)
  assert.equal(EVENT_VERSION, 1)
})
