import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { ValidationError } from '../../lib/archive/errors.js'
import { readJournal } from '../../lib/archive/journal.js'
import { publishLesson } from '../../lib/archive/operations.js'
import { planRunState } from '../../lib/archive/runs.js'
import { openArchive } from '../../lib/archive/store.js'
import { registerStageTool } from '../../lib/stages.js'

/* B2：阶段状态落档案（投影优先、内存兜底、run 级 CAS）。
 * 每条用例对应 v0.6.3-B 规格 §3 的一行；全部用临时档案，不碰真实课程。 */

const HTML = '<html><body><div class="quiz" data-question-id="q1">题</div></body></html>'

function freshWorkspace({ archive = true } = {}) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-stage-persist-'))
  if (archive) openArchive(ws, { create: true })
  return ws
}

function harnessFor(workspace, { allowSkip = true, start = 'intake' } = {}) {
  let tool
  const ctx = {
    get(name) {
      if (name === 'tools') {
        return {
          register(definition) {
            tool = definition
            return () => {}
          }
        }
      }
      if (name === 'permissionPresets') return { current: () => 'ask' }
      return undefined
    },
    effect: (factory) => factory()
  }
  const api = registerStageTool(
    ctx,
    () => ({
      animation: { enabled: false, root: '', softLimitSeconds: 120, gateSkill: true },
      stages: { allowSkip, start },
      tools: { stage: true }
    }),
    os.tmpdir(),
    () => workspace
  )
  return { tool, api }
}

const exec = (id = 'agent-1') => ({ agent: { id, session: { id: 'session-1' } } })

/** 直接往档案里写一条 run.state（模拟「上一次会话」留下的记录）。 */
function seedRun(workspace, { runId = 'agent-1', stage, pending = [], runRevision } = {}) {
  const archive = openArchive(workspace, { create: false })
  return archive.transact('seed', undefined, (draft) => {
    const planned = planRunState({
      state: draft,
      runId,
      stage,
      pending,
      watermarks: { lastSeq: draft.lastSeq, lastHash: draft.lastHash, lessonRevisions: {} }
    })
    if (runRevision !== undefined) planned.change.data.runRevision = runRevision
    return { changes: [planned.change], result: { runRevision: planned.runRevision } }
  })
}

function runStateEvents(workspace) {
  const archive = openArchive(workspace, { create: false })
  return readJournal(archive.path).entries.flatMap((entry) =>
    entry.changes.filter((change) => change.type === 'run.state').map((change) => ({ entry, change }))
  )
}

test('矩阵 1：无关会话写档案后推进阶段，不报冲突（run 级 CAS 不看全局 revision）', async () => {
  const ws = freshWorkspace()
  const { tool } = harnessFor(ws)
  const first = await tool.execute({ action: 'advance' }, exec())
  assert.equal(first.stage, 'diagnose')
  assert.equal(first.persisted, true)
  assert.equal(first.source, 'archive')

  // 另一个会话/另一类写入推进全局 revision：不该影响这个 run 的版本判定。
  const archive = openArchive(ws, { create: false })
  archive.transact('other-session', undefined, () => ({
    changes: [{ type: 'self_report.recorded', data: { id: 'sr-1', claim: '离线自测过了' } }],
    result: {}
  }))
  const bumped = openArchive(ws, { create: false }).state.revision
  assert.ok(bumped > first.runRevision, '全局 revision 应该已经推进')

  const second = await tool.execute({ action: 'advance' }, exec())
  assert.equal(second.stage, 'plan')
  assert.equal(second.persisted, true)
  assert.equal(second.error, undefined, '无关写入不能造成伪冲突')
  assert.equal(second.runRevision, 2)
})

test('矩阵 2：同一 run 并发推进，一次成功、另一次 run-revision-conflict，不产生重复事件', async () => {
  const ws = freshWorkspace()
  const a = harnessFor(ws)
  const b = harnessFor(ws)
  // 两个工具实例都先读到「还没有 run 记录」。
  assert.equal((await a.tool.execute({ action: 'show' }, exec())).stage, 'intake')
  assert.equal((await b.tool.execute({ action: 'show' }, exec())).stage, 'intake')

  const aAdvanced = await a.tool.execute({ action: 'advance' }, exec())
  assert.equal(aAdvanced.persisted, true)
  const bAdvanced = await b.tool.execute({ action: 'advance' }, exec())
  assert.equal(bAdvanced.persisted, false)
  assert.equal(bAdvanced.error, 'run-revision-conflict')
  assert.equal(bAdvanced.nextAction, 'reload-stage')
  assert.match(bAdvanced.text, /没有覆盖/)
  assert.equal(runStateEvents(ws).length, 1, '冲突的一方不能追加第二条 run.state')
  // 冲突方把记忆同步成档案真值，而不是假装自己推进了。
  assert.equal(bAdvanced.stage, 'diagnose')
  const shown = await b.tool.execute({ action: 'show' }, exec())
  assert.equal(shown.stage, 'diagnose')
  assert.equal(shown.source, 'archive')
})

test('矩阵 3：老档案（无 run.state）回退内存态，persisted:false 且说明来源', async () => {
  const ws = freshWorkspace()
  const { tool } = harnessFor(ws)
  const shown = await tool.execute({ action: 'show' }, exec())
  assert.equal(shown.stage, 'intake')
  assert.equal(shown.persisted, false)
  assert.equal(shown.source, 'memory')
  assert.equal(shown.runRevision, 0)
  assert.match(shown.text, /阶段来源：内存/)

  const advanced = await tool.execute({ action: 'advance' }, exec())
  assert.equal(advanced.persisted, true)
  assert.equal(advanced.source, 'archive')
  assert.equal(advanced.runRevision, 1)
  assert.match(advanced.text, /阶段来源：档案/)
})

test('矩阵 4：写路径遇到档案不可写 → persisted:false + 可读原因，不假装成功', async () => {
  const ws = freshWorkspace()
  const archive = openArchive(ws, { create: false })
  const dirs = [archive.path, path.join(archive.path, 'journal'), path.join(archive.path, 'locks')]
  const restore = []
  try {
    for (const dir of dirs) {
      restore.push([dir, fs.statSync(dir).mode])
      fs.chmodSync(dir, 0o500)
    }
    const { tool } = harnessFor(ws)
    const advanced = await tool.execute({ action: 'advance' }, exec())
    assert.equal(advanced.persisted, false, '写不进去就必须如实说没写')
    assert.equal(advanced.source, 'memory')
    assert.equal(typeof advanced.error, 'string')
    assert.match(advanced.text, /阶段没有写进档案/)
    assert.match(advanced.text, /重启后可能回到上一次记录/)
    assert.equal(runStateEvents(ws).length, 0, '失败路径不能留下半条事件')
  } finally {
    for (const [dir, mode] of restore) fs.chmodSync(dir, mode)
  }
})

test('矩阵 5：只读诊断遇到工作区故障允许降级，但显式 persisted:false', async () => {
  let tool
  const ctx = {
    get: (name) =>
      name === 'tools'
        ? { register: (definition) => { tool = definition; return () => {} } }
        : name === 'permissionPresets'
          ? { current: () => 'ask' }
          : undefined,
    effect: (factory) => factory()
  }
  registerStageTool(
    ctx,
    () => ({ animation: { enabled: false, root: '', softLimitSeconds: 120, gateSkill: true }, stages: { allowSkip: true, start: 'intake' }, tools: { stage: true } }),
    os.tmpdir(),
    () => {
      throw new Error('会话还没有工作区')
    }
  )
  const shown = await tool.execute({ action: 'show' }, exec())
  assert.equal(shown.stage, 'intake')
  assert.equal(shown.persisted, false)
  assert.equal(shown.source, 'memory')
  assert.match(shown.text, /阶段来源：内存/)

  const advanced = await tool.execute({ action: 'advance' }, exec())
  assert.equal(advanced.persisted, false)
  assert.equal(advanced.error, 'archive-not-initialized')
  assert.match(advanced.text, /阶段没有写进档案/)
})

test('矩阵 6：新实例（重启）从档案恢复阶段、pending 与 runRevision', async () => {
  const ws = freshWorkspace()
  const before = harnessFor(ws)
  await before.tool.execute({ action: 'advance' }, exec())
  await before.tool.execute({ action: 'advance' }, exec())
  const third = await before.tool.execute({ action: 'advance' }, exec())
  assert.equal(third.stage, 'build')
  assert.equal(third.runRevision, 3)

  // 模拟另一次会话写进了待确认项（C 组会从这里接）。
  seedRun(ws, { stage: 'build', pending: [{ id: 'p1', kind: 'approval', label: '等学习者点头再写课' }] })
  const after = harnessFor(ws)
  const shown = await after.tool.execute({ action: 'show' }, exec())
  assert.equal(shown.stage, 'build')
  assert.equal(shown.persisted, true)
  assert.equal(shown.source, 'archive')
  assert.equal(shown.runRevision, 4)
  assert.match(shown.text, /阶段来源：档案（run agent-1 v4）/)
  assert.match(shown.text, /待确认/)
  assert.match(shown.text, /等学习者点头再写课/)
  assert.match(shown.text, /从档案恢复/)
})

test('矩阵 7：allowSkip=false 时跨阶 set 被拒并给 nextAction；同阶/下一阶放行', async () => {
  const ws = freshWorkspace()
  seedRun(ws, { stage: 'build' })
  const { tool } = harnessFor(ws, { allowSkip: false })
  const shown = await tool.execute({ action: 'show' }, exec())
  assert.equal(shown.stage, 'build', '恢复同 run 已记录的阶段不算跨阶（重启要继续）')

  const refused = await tool.execute({ action: 'set', stage: 'record' }, exec())
  assert.equal(refused.stage, 'build')
  assert.match(refused.text, /allowSkip=false/)
  assert.equal(refused.nextAction, 'advance-stage')

  const next = await tool.execute({ action: 'set', stage: 'check' }, exec())
  assert.equal(next.stage, 'check')
  assert.equal(next.persisted, true)
})

test('runId 默认取 agent id，可显式覆盖；非法 runId 明确失败', async () => {
  const ws = freshWorkspace()
  const { tool, api } = harnessFor(ws)
  await tool.execute({ action: 'advance' }, exec('agent-1'))
  assert.equal(runStateEvents(ws).length, 1)
  assert.equal(runStateEvents(ws)[0].change.data.runId, 'agent-1')

  const other = await tool.execute({ action: 'show' }, exec('agent-2'))
  assert.equal(other.stage, 'intake', '另一个 agent 是另一个 run，不共享阶段')
  assert.equal(other.persisted, false)

  const explicit = await tool.execute({ action: 'advance', runId: 'learner-run' }, exec('agent-1'))
  assert.equal(explicit.persisted, true)
  assert.ok(runStateEvents(ws).some(({ change }) => change.data.runId === 'learner-run'))

  await assert.rejects(() => tool.execute({ action: 'show', runId: 'bad id' }, exec('agent-1')), ValidationError)
})

test('show 与「留在当前阶」不写 journal（阶段回执不是心跳）', async () => {
  const ws = freshWorkspace()
  const { tool } = harnessFor(ws)
  await tool.execute({ action: 'show' }, exec())
  await tool.execute({ action: 'set', stage: 'intake' }, exec())
  assert.equal(runStateEvents(ws).length, 0)
  const advanced = await tool.execute({ action: 'advance' }, exec())
  assert.equal(advanced.persisted, true)
  const count = runStateEvents(ws).length
  await tool.execute({ action: 'show' }, exec())
  await tool.execute({ action: 'set', stage: 'diagnose' }, exec())
  assert.equal(runStateEvents(ws).length, count, '重复推进同一阶不再追加事件')
})

test('阶段从档案恢复后继续推进，pending 原样保留（不丢也不改）', async () => {
  const ws = freshWorkspace()
  seedRun(ws, { stage: 'plan', pending: [{ id: 'p1', kind: 'approval', label: '等点头' }] })
  const { tool } = harnessFor(ws)
  const advanced = await tool.execute({ action: 'advance' }, exec())
  assert.equal(advanced.stage, 'build')
  assert.equal(advanced.persisted, true)
  const archive = openArchive(ws, { create: false })
  const latest = archive.state.runs['agent-1']
  assert.equal(latest.stage, 'build')
  assert.deepEqual(JSON.parse(JSON.stringify(latest.pending)), [{ id: 'p1', kind: 'approval', label: '等点头' }])
  assert.equal(latest.revision, 2)
})

test('watermarks 记下课程版本与 journal 位置，但不参与冲突判定', async () => {
  const ws = freshWorkspace()
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML)
  publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  const { tool } = harnessFor(ws)
  const advanced = await tool.execute({ action: 'advance' }, exec())
  assert.equal(advanced.persisted, true)
  const archive = openArchive(ws, { create: false })
  const projection = archive.state.runs['agent-1']
  assert.equal(projection.watermarks.lessonRevisions.l1, 1)
  assert.equal(projection.watermarks.lastSeq, archive.state.lastSeq - 1)
  // 课程再改版：不构成冲突（水位只记录）。
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), HTML + '<!-- changed -->')
  publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  const again = await tool.execute({ action: 'advance' }, exec())
  assert.equal(again.persisted, true)
  assert.equal(again.error, undefined)
})

test('F4同版本snapshot只读不清掉阶段备注和已走历史', async () => {
  const ws = freshWorkspace()
  const { tool, api } = harnessFor(ws)
  await tool.execute({ action: 'advance', note: '记住这个起点' }, exec())
  const before = structuredClone(api.stageOf(exec().agent))
  const snapshot = openArchive(ws, { repairIndex: false })
  const after = api.stageOf(exec().agent, { archive: snapshot })
  assert.deepEqual(after, before)
  assert.equal(after.note, '记住这个起点')
  const shown = await tool.execute({ action: 'show' }, exec())
  assert.match(shown.text, /记住这个起点/)
})
