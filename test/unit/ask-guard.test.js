import assert from 'node:assert/strict'
import test from 'node:test'

import { GATED_TOOLS, registerWaitingGuard } from '../../lib/ask-guard.js'

function makeCtx({ active = [], projections = true, guard = true } = {}) {
  let registered
  const ctx = {
    get(name) {
      if (name === 'tools') {
        if (!guard) return {}
        return {
          guard(fn) {
            registered = fn
            return () => {}
          }
        }
      }
      if (name === 'sessionProjections') {
        if (!projections) return undefined
        return {
          stateOf: () => ({ questions: { active, settled: [] } })
        }
      }
      return undefined
    },
    effect(factory) {
      factory()
    }
  }
  return { ctx, guardFn: () => registered }
}

const write = { name: 'write', arguments: { file_path: '/tmp/a' }, agent: { session: { id: 's1' } } }

test('有 active 问题时拦住依赖答案的写操作', () => {
  const { ctx, guardFn } = makeCtx({ active: [{ callId: 'call-9', questions: [] }] })
  assert.equal(registerWaitingGuard(ctx, () => ({ ask: { gateWhileWaiting: true } })), true)
  const message = guardFn()(write)
  assert.equal(typeof message, 'string')
  assert.match(message, /call-9/)
  assert.match(message, /不是批准/)
})

test('读、查、阶段这类动作不拦', () => {
  const { ctx, guardFn } = makeCtx({ active: [{ callId: 'call-9', questions: [] }] })
  registerWaitingGuard(ctx, () => ({ ask: { gateWhileWaiting: true } }))
  for (const name of ['read', 'glob', 'grep', 'teach_status', 'teach_stage', 'lesson_lint']) {
    assert.equal(guardFn()({ ...write, name }), undefined, name)
  }
})

test('每次都读 live 配置：关掉闸门立即放行', () => {
  const { ctx, guardFn } = makeCtx({ active: [{ callId: 'call-9', questions: [] }] })
  let config = { ask: { gateWhileWaiting: false } }
  registerWaitingGuard(ctx, () => config)
  assert.equal(guardFn()(write), undefined, '注册时是关的，但 guard 仍装上')
  config = { ask: { gateWhileWaiting: true } }
  assert.equal(typeof guardFn()(write), 'string', '热打开立即生效')
  config = { ask: { gateWhileWaiting: false } }
  assert.equal(guardFn()(write), undefined)
})

test('投影清空后自动放行，不靠超时窗口', () => {
  const active = [{ callId: 'call-9', questions: [] }]
  const { ctx, guardFn } = makeCtx({ active })
  registerWaitingGuard(ctx, () => ({ ask: { gateWhileWaiting: true } }))
  const commit = { ...write, name: 'teach_commit', arguments: {} }
  assert.equal(typeof guardFn()(write), 'string')
  assert.equal(typeof guardFn()(commit), 'string')
  assert.equal(guardFn()({ ...commit, arguments: { dryRun: true } }), undefined)
  active.length = 0
  assert.equal(guardFn()(write), undefined)
  assert.equal(guardFn()(commit), undefined)
})

test('没有会话/没有投影服务时放行（不制造死锁）', () => {
  const noSession = makeCtx({ active: [{ callId: 'call-9', questions: [] }] })
  registerWaitingGuard(noSession.ctx, () => ({ ask: { gateWhileWaiting: true } }))
  assert.equal(noSession.guardFn()({ name: 'write', arguments: {} }), undefined)

  const noProjection = makeCtx({ projections: false, active: [{ callId: 'call-9', questions: [] }] })
  registerWaitingGuard(noProjection.ctx, () => ({ ask: { gateWhileWaiting: true } }))
  assert.equal(noProjection.guardFn()(write), undefined)
})

test('tools.guard 不可用时明确返回 false', () => {
  const { ctx } = makeCtx({ guard: false })
  assert.equal(registerWaitingGuard(ctx, () => ({ ask: { gateWhileWaiting: true } })), false)
})

test('闸门覆盖发布和提交，不只是文件写', () => {
  assert.ok(GATED_TOOLS.has('teach_animation_sync'))
  assert.ok(GATED_TOOLS.has('teach_animation_render'))
  assert.ok(GATED_TOOLS.has('teach_lesson_publish'))
  assert.ok(GATED_TOOLS.has('teach_submission_record'))
  assert.equal(GATED_TOOLS.has('read'), false)
})

test('候答期间覆盖档案写操作，但允许 workspace status 和 review due', () => {
  const { ctx, guardFn } = makeCtx({ active: [{ callId: 'pending' }] })
  registerWaitingGuard(ctx, () => ({ ask: { gateWhileWaiting: true } }))
  for (const name of ['teach_question_register', 'teach_evaluate', 'teach_self_report', 'teach_defer', 'teach_grade_open', 'teach_material_index', 'teach_assessment_void']) {
    assert.equal(typeof guardFn()({ ...write, name }), 'string', name)
  }
  for (const [name, action] of [['teach_workspace', 'bind'], ['teach_workspace', 'unbind'], ['teach_review', 'schedule'], ['teach_review', 'finish']]) {
    assert.equal(typeof guardFn()({ ...write, name, arguments: { action } }), 'string')
  }
  for (const [name, action] of [['teach_workspace', 'status'], ['teach_review', 'due']]) {
    assert.equal(guardFn()({ ...write, name, arguments: { action } }), undefined)
  }
})

test('run_code 本身放行：候答期间的读/查/诊断不能被整条冻死', () => {
  const { ctx, guardFn } = makeCtx({ active: [{ callId: 'pending' }] })
  registerWaitingGuard(ctx, () => ({ ask: { gateWhileWaiting: true } }))
  assert.equal(guardFn()({ ...write, name: 'run_code', arguments: {} }), undefined)
  assert.equal(guardFn()({ ...write, name: 'run_code', arguments: { code: 'tools.read({file_path:"/tmp/a"})' } }), undefined)
})

test('run_code 带 sandbox_permissions 时仍拦（提权依赖回答）', () => {
  const { ctx, guardFn } = makeCtx({ active: [{ callId: 'pending' }] })
  registerWaitingGuard(ctx, () => ({ ask: { gateWhileWaiting: true } }))
  const message = guardFn()({
    ...write,
    name: 'run_code',
    arguments: { sandbox_permissions: 'danger-full-access' }
  })
  assert.equal(typeof message, 'string')
  assert.match(message, /sandbox_permissions/)
  assert.match(message, /提权/)
})

test('课堂打开与直接侧栏调用也在候答闸门内，编辑器与终端同样算写', () => {
  const { ctx, guardFn } = makeCtx({ active: [{ callId: 'pending' }] })
  registerWaitingGuard(ctx, () => ({ ask: { gateWhileWaiting: true } }))
  for (const name of ['teach_lesson_open', 'sidebar_open', 'str_replace_editor', 'terminal', 'apply_patch']) {
    assert.equal(typeof guardFn()({ ...write, name }), 'string', name)
  }
})
