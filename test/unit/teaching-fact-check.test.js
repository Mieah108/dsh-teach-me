import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { reviewerCount, validateFactReport, registerFactCheckTools } from '../../lib/fact-check.js'
import { publishLesson } from '../../lib/archive/operations.js'
import { withLearningScope } from '../../lib/archive/learning-scope.js'
import { openArchive } from '../../lib/archive/store.js'
test('弹性核查数与保守复查：不足不冒充完成、多代理不得自查、已知错不交付', () => {
  assert.deepEqual(['none', 'loose', 'moderate', 'strict'].map((tier) => [reviewerCount(tier), reviewerCount(tier, true)]), [[0, 0], [1, 1], [1, 2], [3, 4]])
  const participant = (id) => ({ agentId: id, status: 'complete', sources: ['https://primary.example/paper'], findings: [] })
  const run = { level: 'moderate', count: 2, started: ['a', 'b'] }
  const report = { runId: 'r', summary: '实际证据', participants: [participant('a'), participant('b')], followup: [] }
  assert.equal(validateFactReport(run, report).status, 'complete')
  assert.equal(validateFactReport(run, { ...report, participants: [participant('a')] }).status, 'incomplete')
  assert.equal(validateFactReport({ ...run, started: [] }, report).status, 'incomplete')
  assert.throws(() => validateFactReport(run, { ...report, followup: [{ reviewerId: 'a', targetId: 'a', issue: '问题', result: '结果' }] }), /交叉/)
  assert.throws(() => validateFactReport(run, { ...report, participants: [{ ...participant('a'), findings: [{ claim: '已知错', kind: 'error', resolution: 'pending', note: '' }] }] }), /已知错误/)
  assert.equal(validateFactReport({ level: 'loose', count: 1, started: ['a'] }, { ...report, participants: [participant('a')], followup: [{ reviewerId: 'a', targetId: 'a', issue: '修正', result: '通过' }] }).status, 'complete')
})
test('真实计划、预算闸门、实际启动来源与版本证据；同次生成不重复派遣', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-check-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lessons')); fs.writeFileSync(path.join(root, 'lessons/a.html'), '<html><body>待核课程</body></html>')
  publishLesson(root, { lessonId: 'a', path: 'lessons/a.html' })
  const definitions = new Map(), events = new Map(), guards = []
  registerFactCheckTools({ get: () => ({ register: (d) => definitions.set(d.name, d), guard: (g) => guards.push(g) }), on: (e, fn) => events.set(e, fn), effect: (factory) => factory() }, () => root)
  withLearningScope({ factCheck: 'loose', requestId: 's1:1' }, () => {
    const plan = definitions.get('teach_fact_check_plan').execute({ lessonId: 'a' }, {})
    assert.equal(plan.count, 1)
    assert.equal(plan.dispatch[0].name, 'subagent')
    const execution = { name: 'subagent', arguments: plan.dispatch[0].arguments, agent: { id: 's1' } }
    assert.equal(guards[0](execution), undefined)
    assert.match(guards[0](execution), /已尝试/)
    events.get('tools/result')(execution, { isError: false, value: { subagentId: 'child-1' } })
    const again = definitions.get('teach_fact_check_plan').execute({ lessonId: 'a' }, {})
    assert.deepEqual(again.dispatch, [])
    const report = { runId: plan.runId, summary: '核对完成', participants: [{ agentId: 'child-1', status: 'complete', sources: ['材料第1段'], findings: [] }] }
    const recorded = definitions.get('teach_fact_check_record').execute(report, {})
    assert.equal(recorded.status, 'complete', JSON.stringify(recorded))
    assert.equal(definitions.get('teach_fact_check_record').execute(report, {}).ok, false)
    const state = openArchive(root).state
    assert.equal(state.factChecks.a[state.lessons.a.contentVersion].status, 'complete')
  })
})
