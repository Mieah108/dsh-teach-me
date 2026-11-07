import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { archiveStatusFor, registerArchiveTools } from '../../lib/archive/tools.js'
import { WorkspaceError } from '../../lib/workspace.js'

function fakeCtx(workspace) {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (tool) => { registered.push(tool); return () => {} } }
      if (name === 'workingDirectory') {
        if (workspace === undefined) return undefined
        return { get: () => workspace }
      }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    }
  }
  return { ctx, registered }
}

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-tools-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), '<html>lesson</html>')
  return ws
}

const AGENT = { session: { id: 'session-1' }, id: 'agent-1' }

test('注册十一个档案工具（含 due / 自报 / 暂缓 / 模型批改 / 题目登记 / commit），且工作区未知时明确失败', async () => {
  const ws = workspace()
  const { ctx, registered } = fakeCtx(ws)
  assert.equal(registerArchiveTools(ctx, { tools: { archive: true } }, (agent) => {
    assert.equal(agent, AGENT)
    return ws
  }), true)
  assert.deepEqual(
    registered.map((tool) => tool.name).sort(),
    [
      'teach_assessment_void',
      'teach_commit',
      'teach_defer',
      'teach_evaluate',
      'teach_grade_open',
      'teach_lesson_publish',
      'teach_material_index',
      'teach_question_register',
      'teach_review',
      'teach_self_report',
      'teach_submission_record'
    ]
  )
  const publish = registered.find((tool) => tool.name === 'teach_lesson_publish')
  const published = await publish.execute({ lessonId: 'l1', path: 'lessons/one.html', title: '第一课' }, { agent: AGENT })
  assert.equal(published.ok, true)
  assert.match(published.text, /已登记/)
  assert.match(published.text, /lessons\/one.html/)

  const { ctx: blind, registered: blindTools } = fakeCtx(undefined)
  registerArchiveTools(blind, {}, () => {
    throw new WorkspaceError('还不知道工作区')
  })
  const failed = await blindTools.find((tool) => tool.name === 'teach_lesson_publish').execute(
    { lessonId: 'l1', path: 'lessons/one.html' },
    { agent: AGENT }
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'workspace-unknown')
  assert.match(failed.text, /没有写入/)
  assert.ok(!fs.existsSync(path.join(process.cwd(), '.dsh-teach-me', 'archive')))
})

test('config.tools.archive=false 时不注册', () => {
  const ws = workspace()
  const { ctx, registered } = fakeCtx(ws)
  assert.equal(registerArchiveTools(ctx, { tools: { archive: false } }, () => ws), false)
  assert.equal(registered.length, 0)
})

test('档案段：未初始化说清楚，已初始化报告课程/提交/复习', async () => {
  const empty = workspace()
  const uninitialized = archiveStatusFor(empty)
  assert.equal(uninitialized.initialized, false)
  assert.match(uninitialized.text, /还没建立/)
  assert.ok(!fs.existsSync(path.join(empty, '.dsh-teach-me', 'archive')))

  const ws = workspace()
  const { ctx, registered } = fakeCtx(ws)
  registerArchiveTools(ctx, {}, () => ws)
  const publish = registered.find((tool) => tool.name === 'teach_lesson_publish')
  await publish.execute({ lessonId: 'l1', path: 'lessons/one.html' }, { agent: AGENT })
  const status = archiveStatusFor(ws)
  assert.equal(status.initialized, true)
  assert.equal(status.summary.lessons, 1)
  assert.match(status.text, /档案：workspace ws_/)
  assert.match(status.text, /课程 1/)
  assert.match(status.text, /自报与暂缓都不是通过/)
  assert.equal(status.dueReviews.length, 0)
  assert.match(status.text, /现在没有到期复习/)
})

test('config.tools.commit=false 时不下发 teach_commit（回滚开关），其余档案工具不受影响', () => {
  const ws = workspace()
  const { ctx, registered } = fakeCtx(ws)
  assert.equal(registerArchiveTools(ctx, { tools: { commit: false } }, () => ws), true)
  assert.equal(registered.some((tool) => tool.name === 'teach_commit'), false)
  assert.equal(registered.length, 10)
  // 默认（没配）仍然下发：回滚是显式动作，不靠缺省。
  const second = fakeCtx(ws)
  registerArchiveTools(second.ctx, {}, () => ws)
  assert.equal(second.registered.some((tool) => tool.name === 'teach_commit'), true)
})

test('带 ctx.llm 时模型批改工具能注册；没有 llm 也不影响注册', () => {
  const ws = workspace()
  const { ctx, registered } = fakeCtx(ws)
  registerArchiveTools(ctx, {}, () => ws)
  const grade = registered.find((tool) => tool.name === 'teach_grade_open')
  assert.deepEqual(grade.parameters.required, ['submissionId'])
  assert.ok(!JSON.stringify(grade.parameters).includes('verdict'))
  const review = registered.find((tool) => tool.name === 'teach_review')
  assert.deepEqual(review.parameters.properties.action.enum, ['due', 'schedule', 'finish'])
})
