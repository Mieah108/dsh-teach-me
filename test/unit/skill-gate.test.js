import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachSkillWitness,
  createSkillWitness,
  gatedCall,
  isSkillFile,
  registerSkillGate,
  SKILL_GATE_MESSAGE,
  SKILL_NAME
} from '../../lib/skill-gate.js'

function makeCtx() {
  let guard
  const handlers = new Map()
  const ctx = {
    get(name) {
      if (name !== 'tools') return undefined
      return {
        guard(fn) {
          guard = fn
          return () => {}
        }
      }
    },
    on(event, handler) {
      handlers.set(event, handler)
      return () => {}
    },
    effect(factory) {
      factory()
    }
  }
  return { ctx, guardFn: () => guard, handlers }
}

const session = { id: 's1' }
const exec = (name, args = {}, execSession = session) => ({ name, arguments: args, agent: { session: execSession } })
const config = (gateSkill = true) => () => ({ animation: { gateSkill } })

test('技能名与「读了 SKILL.md」的识别', () => {
  assert.equal(SKILL_NAME, 'teach-animation')
  assert.equal(isSkillFile('skills/teach-animation/SKILL.md'), true)
  assert.equal(isSkillFile('/abs/pkg/skills/teach-animation/SKILL.md'), true)
  assert.equal(isSkillFile('C:\\pkg\\skills\\teach-animation\\SKILL.md'), true)
  assert.equal(isSkillFile('skills/teach/SKILL.md'), false)
  assert.equal(isSkillFile(undefined), false)
})

test('闸门只覆盖动画写路径：源码目录、同步（非 dry_run）、渲染', () => {
  assert.equal(gatedCall('write', { file_path: '/w/.dsh-teach-me/animation-src/0001/a/Comp.tsx' }), true)
  assert.equal(gatedCall('edit', { file_path: '.dsh-teach-me/animation-src/x/y.tsx' }), true)
  assert.equal(gatedCall('write', { file_path: '/w/lessons/0001.html' }), false)
  assert.equal(gatedCall('write', { file_path: '/w/.dsh-teach-me/archive/log.jsonl' }), false)
  assert.equal(gatedCall('teach_animation_sync', {}), true)
  assert.equal(gatedCall('teach_animation_sync', { dry_run: true }), false)
  assert.equal(gatedCall('teach_animation_render', { mode: 'still' }), true)
  assert.equal(gatedCall('read', {}), false)
})

test('没加载过技能时拦住源码写入，文案说明这是前置知识', () => {
  const { ctx, guardFn } = makeCtx()
  const witness = createSkillWitness()
  assert.equal(registerSkillGate(ctx, config(), { witness, available: true }), true)
  const message = guardFn()(exec('write', { file_path: '/w/.dsh-teach-me/animation-src/0001/a/Comp.tsx' }))
  assert.equal(message, SKILL_GATE_MESSAGE)
  assert.match(message, /teach-animation/)
  assert.match(message, /不是审批/)
})

test('skill 工具成功加载后放行（tools/result 见证）', () => {
  const { ctx, guardFn, handlers } = makeCtx()
  const witness = createSkillWitness()
  attachSkillWitness(ctx, witness)
  registerSkillGate(ctx, config(), { witness, available: true })
  assert.equal(typeof guardFn()(exec('write', { file_path: '/w/.dsh-teach-me/animation-src/a.tsx' })), 'string')
  handlers.get('tools/result')(exec('skill', { name: SKILL_NAME }), { isError: false, value: { name: SKILL_NAME } })
  assert.equal(guardFn()(exec('write', { file_path: '/w/.dsh-teach-me/animation-src/a.tsx' })), undefined)
})

test('失败的 skill 调用不算见证；别的技能也不算', () => {
  const { ctx, guardFn, handlers } = makeCtx()
  const witness = createSkillWitness()
  attachSkillWitness(ctx, witness)
  registerSkillGate(ctx, config(), { witness, available: true })
  handlers.get('tools/result')(exec('skill', { name: SKILL_NAME }), { isError: true })
  handlers.get('tools/result')(exec('skill', { name: 'teach' }), { isError: false })
  assert.equal(typeof guardFn()(exec('write', { file_path: '/w/.dsh-teach-me/animation-src/a.tsx' })), 'string')
})

test('直接读 SKILL.md 本身就是见证：这次读放行，之后的写也放行', () => {
  const { ctx, guardFn } = makeCtx()
  const witness = createSkillWitness()
  registerSkillGate(ctx, config(), { witness, available: true })
  assert.equal(guardFn()(exec('read', { file_path: '/pkg/skills/teach-animation/SKILL.md' })), undefined)
  assert.equal(witness.has('s1'), true)
  assert.equal(guardFn()(exec('write', { file_path: '/w/.dsh-teach-me/animation-src/a.tsx' })), undefined)
})

test('/skill 直呼（skill-invocation 消息）也算见证', () => {
  const { ctx, guardFn, handlers } = makeCtx()
  const witness = createSkillWitness()
  attachSkillWitness(ctx, witness)
  registerSkillGate(ctx, config(), { witness, available: true })
  handlers.get('session/event')(session, {
    type: 'user/message',
    data: { source: { kind: 'skill-invocation', name: SKILL_NAME, form: 'instructions' } }
  })
  assert.equal(guardFn()(exec('teach_animation_render', { mode: 'still' })), undefined)
})

test('见证按会话隔离：别的会话加载过不算', () => {
  const { ctx, guardFn, handlers } = makeCtx()
  const witness = createSkillWitness()
  attachSkillWitness(ctx, witness)
  registerSkillGate(ctx, config(), { witness, available: true })
  handlers.get('tools/result')(exec('skill', { name: SKILL_NAME }, { id: 'other' }), { isError: false })
  assert.equal(typeof guardFn()(exec('write', { file_path: '/w/.dsh-teach-me/animation-src/a.tsx' })), 'string')
})

test('升级后旧上游技能的加载见证不能替代项目动画指南', () => {
  const { ctx, guardFn, handlers } = makeCtx()
  const witness = createSkillWitness()
  attachSkillWitness(ctx, witness)
  registerSkillGate(ctx, config(), { witness, available: true })
  const oldName = 'remotion-best-practices'
  handlers.get('tools/result')(exec('skill', { name: oldName }), { isError: false })
  handlers.get('session/event')(session, { type: 'user/message', data: { source: { kind: 'skill-invocation', name: oldName } } })
  assert.equal(isSkillFile('/pkg/skills/' + oldName + '/SKILL.md'), false)
  guardFn()(exec('read', { file_path: '/pkg/skills/' + oldName + '/SKILL.md' }))
  assert.equal(witness.has('s1'), false)
  assert.equal(guardFn()(exec('teach_animation_render', { mode: 'still' })), SKILL_GATE_MESSAGE)
  handlers.get('tools/result')(exec('skill', { name: SKILL_NAME }), { isError: false })
  assert.equal(guardFn()(exec('teach_animation_render', { mode: 'still' })), undefined)
})

test('dry_run 同步不需要前置技能', () => {
  const { ctx, guardFn } = makeCtx()
  const witness = createSkillWitness()
  registerSkillGate(ctx, config(), { witness, available: true })
  assert.equal(guardFn()(exec('teach_animation_sync', { dry_run: true })), undefined)
  assert.equal(typeof guardFn()(exec('teach_animation_sync', {})), 'string')
})

test('技能不可用、配置关掉、没有 guard 服务时 fail-open', () => {
  const unavailable = makeCtx()
  const witness = createSkillWitness()
  assert.equal(registerSkillGate(unavailable.ctx, config(), { witness, available: false }), false)

  const off = makeCtx()
  registerSkillGate(off.ctx, config(false), { witness: createSkillWitness(), available: true })
  assert.equal(off.guardFn()(exec('write', { file_path: '/w/.dsh-teach-me/animation-src/a.tsx' })), undefined)

  const noTools = { get: () => undefined, effect: () => {} }
  assert.equal(registerSkillGate(noTools, config(), { witness, available: true }), false)
})

test('非动画写入不受闸门影响', () => {
  const { ctx, guardFn } = makeCtx()
  registerSkillGate(ctx, config(), { witness: createSkillWitness(), available: true })
  assert.equal(guardFn()(exec('write', { file_path: '/w/lessons/0001.html' })), undefined)
  assert.equal(guardFn()(exec('bash', { command: 'ls' })), undefined)
  assert.equal(guardFn()(exec('teach_lesson_publish', { path: 'lessons/0001.html' })), undefined)
})
