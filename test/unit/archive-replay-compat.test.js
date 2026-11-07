import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { appendJournal, readJournal } from '../../lib/archive/journal.js'
import { publishLesson, recordSubmission, registerQuestion } from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import {
  FORWARD_COMPAT_EVENT_TYPES,
  applyChange,
  emptyState
} from '../../lib/archive/state.js'
import { canonicalJson } from '../../lib/archive/util.js'
import { ValidationError } from '../../lib/archive/errors.js'

/* B0 兼容回滚层（v0.6.3-B 规格 §0）。
 *
 * 背景：新版本写进档案的 run.state，旧版本重放时不认识。B0 之前 applyChange 对未知
 * 类型直接 fail，于是「回滚代码 = 档案不可用」。这里钉死 B0 的口径：
 *   1. 已知事件的日志，容错重放与严格重放逐字节一致（B0 不改任何既有语义）；
 *   2. 只有登记在 FORWARD_COMPAT_EVENT_TYPES 里的类型允许在重放时跳过，且降级可见；
 *   3. 未登记的类型、以及写路径（transact），仍然一律 fail。
 *
 * 注意：测试用「临时加进登记表的哨兵类型」验证跳过机制，而不是用 run.state ——
 * B1 会实现 run.state，届时它不再走跳过分支；跳过通道本身必须长期有覆盖。 */

const HTML = '<html><body><div class="quiz" data-question-id="q1">题</div></body></html>'

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-replay-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML)
  return ws
}

/** 往档案里直接追加一条任意 change（模拟「新版本写、旧版本读」的日志）。 */
function appendRawChange(archive, change) {
  const journal = readJournal(archive.path)
  return appendJournal(archive.path, {
    seq: journal.lastSeq + 1,
    revision: journal.revision + 1,
    actor: 'test',
    at: '2026-10-28T00:00:00.000Z',
    changes: [change]
  })
}

/** 写一份有真实内容的老日志：发布 + 登记题目 + 记提交。 */
function seededWorkspace() {
  const ws = workspace()
  openArchive(ws, { create: true })
  publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  registerQuestion(ws, {
    questionId: 'q1',
    lessonId: 'l1',
    type: 'choice',
    prompt: '选一个',
    options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
    answer: 'b'
  })
  recordSubmission(ws, { questionId: 'q1', rawAnswer: 'b' })
  return ws
}

test('B0：已知事件的日志，容错重放与严格重放逐字节一致', () => {
  const ws = seededWorkspace()
  const archive = openArchive(ws, { create: false })
  // 严格重放 = B0 之前的 applyEntries：没有跳过通道，事件一条条应用。
  const strict = emptyState()
  for (const entry of readJournal(archive.path).entries) {
    for (const change of entry.changes) applyChange(strict, change, { at: entry.at, actor: entry.actor, seq: entry.seq })
    strict.revision = entry.revision
    strict.lastSeq = entry.seq
    strict.lastHash = entry.hash
  }
  assert.equal(canonicalJson(archive.state), canonicalJson(strict))
  assert.deepEqual(archive.toleratedChanges, [])
  assert.deepEqual(archive.warnings, [], '老日志打开时不该有降级或重建警告')
})

test('B0：登记表只登记已登记的新事件类型，且跳过机制对它之外的类型不生效', () => {
  // 登记表每多一项都等于允许旧版本在重放时跳过它：只能是「新版本会写」的事件
  // （B1 的 run.state、C 的 commit.recorded、D4 的 animation.job）。
  assert.deepEqual([...FORWARD_COMPAT_EVENT_TYPES].sort(), ['animation.job', 'commit.recorded', 'run.state'])
})

test('B0：登记表内的未知类型重放时跳过，toleratedChanges 与 warnings 都可见', () => {
  const ws = seededWorkspace()
  const archive = openArchive(ws, { create: false })
  const before = archive.state
  const probe = 'test.forward-compat-probe'
  FORWARD_COMPAT_EVENT_TYPES.add(probe)
  try {
    appendRawChange(archive, { type: probe, data: { anything: true } })
    const reopened = openArchive(ws, { create: false })
    assert.equal(reopened.toleratedChanges.length, 1)
    assert.equal(reopened.toleratedChanges[0].type, probe)
    assert.equal(reopened.toleratedChanges[0].seq, before.lastSeq + 1)
    assert.ok(reopened.toleratedChanges[0].message.includes('未知事件类型'))
    assert.match(reopened.warnings.join('\n'), /本版本不认识的事件/)
    // 其余投影不受影响：课程、题目、提交都还在。
    assert.deepEqual(Object.keys(reopened.state.lessons), ['l1'])
    assert.deepEqual(Object.keys(reopened.state.questions), ['q1'])
    assert.equal(Object.keys(reopened.state.submissions).length, 1)
    // 日志行本身完整保留（重放跳过 ≠ 删除）。
    assert.equal(readJournal(reopened.path).entries.length, before.lastSeq + 1)
  } finally {
    FORWARD_COMPAT_EVENT_TYPES.delete(probe)
  }
})

test('B0：未登记的类型仍然 fail，不会因为「看起来是未来事件」被放过', () => {
  const ws = seededWorkspace()
  const archive = openArchive(ws, { create: false })
  appendRawChange(archive, { type: 'foo.bar', data: {} })
  assert.throws(
    () => openArchive(ws, { create: false }),
    (error) => error instanceof ValidationError && /未知事件类型/.test(error.message)
  )
})

test('B0：未登记类型的坏载荷照常 rethrow（跳过只针对「不认识」，不针对「写坏了」）', () => {
  const ws = seededWorkspace()
  const archive = openArchive(ws, { create: false })
  appendRawChange(archive, { type: 'lesson.published', data: { id: 'l1' } })
  assert.throws(
    () => openArchive(ws, { create: false }),
    (error) => error instanceof ValidationError && /lesson.(revision|title)/.test(error.message)
  )
})

test('B0：登记表里的类型一旦本版本认识，坏载荷就不能再被兼容层吞掉', () => {
  const ws = seededWorkspace()
  const archive = openArchive(ws, { create: false })
  // run.state 在登记表里；B1 之后本版本认识它 —— 载荷坏了（跳号）必须报日志损坏。
  appendRawChange(archive, {
    type: 'run.state',
    data: {
      runId: 'agent-1',
      runRevision: 2,
      stage: 'plan',
      pending: [],
      watermarks: { lastSeq: 1, lastHash: null, lessonRevisions: {} }
    }
  })
  assert.throws(
    () => openArchive(ws, { create: false }),
    (error) => error instanceof ValidationError && /run.runRevision/.test(error.message)
  )
})

test('B0：transact 写路径不走跳过通道，未知类型仍立即失败且不落日志', () => {
  const ws = seededWorkspace()
  const archive = openArchive(ws, { create: false })
  const probe = 'test.forward-compat-probe'
  FORWARD_COMPAT_EVENT_TYPES.add(probe)
  try {
    const seqBefore = readJournal(archive.path).lastSeq
    assert.throws(
      () => archive.transact('test', undefined, () => ({ changes: [{ type: probe, data: {} }], result: {} })),
      (error) => error instanceof ValidationError && /未知事件类型/.test(error.message)
    )
    assert.equal(readJournal(archive.path).lastSeq, seqBefore, '写失败不能留下半条事件')
  } finally {
    FORWARD_COMPAT_EVENT_TYPES.delete(probe)
  }
})

test('B0：rebuild 也走同一口径，跳过数如实回执，索引按当前投影重写', () => {
  const ws = seededWorkspace()
  const archive = openArchive(ws, { create: false })
  const probe = 'test.forward-compat-probe'
  FORWARD_COMPAT_EVENT_TYPES.add(probe)
  try {
    appendRawChange(archive, { type: probe, data: {} })
    const reopened = openArchive(ws, { create: false })
    const result = reopened.rebuild()
    assert.equal(result.rebuilt, true)
    assert.equal(result.tolerated, 1)
    assert.equal(canonicalJson(openArchive(ws, { create: false }).state), canonicalJson(reopened.state))
  } finally {
    FORWARD_COMPAT_EVENT_TYPES.delete(probe)
  }
})
