import assert from 'node:assert/strict'
import os from 'node:os'
import test from 'node:test'

import { registerStageTool } from '../../lib/stages.js'

function makeCtx(preset, stages = { allowSkip: true, start: 'intake' }) {
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
      if (name === 'permissionPresets') {
        return { current: () => preset }
      }
      return undefined
    },
    effect(factory) {
      factory()
    }
  }
  const config = () => ({
    animation: { enabled: false, root: '', softLimitSeconds: 120, gateSkill: true },
    stages,
    tools: { stage: true }
  })
  registerStageTool(ctx, config, os.tmpdir(), () => undefined)
  return { tool }
}

const exec = () => ({ agent: { id: 'a1', session: { id: 's1' } } })

test('auto 权限下阶段回执多一行说明：写入可能被审查通道整段丢弃', async () => {
  const { tool } = makeCtx('auto')
  const shown = await tool.execute({ action: 'show' }, exec())
  assert.equal(shown.stage, 'intake')
  assert.match(shown.text, /权限：auto/)
  assert.match(shown.text, /不重试/)
})

test('非 auto 或读不到权限时不占版面', async () => {
  const ask = makeCtx('ask')
  const askShown = await ask.tool.execute({ action: 'show' }, exec())
  assert.doesNotMatch(askShown.text, /权限：/)

  const unknown = makeCtx(undefined)
  const unknownShown = await unknown.tool.execute({ action: 'show' }, exec())
  assert.doesNotMatch(unknownShown.text, /权限：/)
})

test('allowSkip=false：跨阶 set 被拒且阶段不变，文案说清只能 advance 或 set 下一阶', async () => {
  const { tool } = makeCtx('ask', { allowSkip: false, start: 'intake' })
  const rejected = await tool.execute({ action: 'set', stage: 'record' }, exec())
  assert.equal(rejected.stage, 'intake')
  assert.match(rejected.text, /allowSkip=false/)
  assert.match(rejected.text, /不能从 intake 跳到 record/)
  assert.match(rejected.text, /只能 advance 或 set 到下一阶（diagnose）/)
  // 被拒之后真的没动：读一次还是 intake
  const shown = await tool.execute({ action: 'show' }, exec())
  assert.equal(shown.stage, 'intake')
})

test('allowSkip=false：set 下一阶与当前阶都放行，advance 正常', async () => {
  const { tool } = makeCtx('ask', { allowSkip: false, start: 'intake' })
  const next = await tool.execute({ action: 'set', stage: 'diagnose' }, exec())
  assert.equal(next.stage, 'diagnose')
  const stay = await tool.execute({ action: 'set', stage: 'diagnose' }, exec())
  assert.equal(stay.stage, 'diagnose')
  const advanced = await tool.execute({ action: 'advance' }, exec())
  assert.equal(advanced.stage, 'plan')
  const jumped = await tool.execute({ action: 'set', stage: 'video-render' }, exec())
  assert.equal(jumped.stage, 'plan')
  assert.match(jumped.text, /不能从 plan 跳到 video-render/)
  assert.match(jumped.text, /阶段不能跳/)
})

test('allowSkip=false：已在最后一阶时跨阶 set 仍被拒，文案说明只能留在当前阶段', async () => {
  const { tool } = makeCtx('ask', { allowSkip: false, start: 'intake' })
  for (let i = 0; i < 9; i += 1) await tool.execute({ action: 'advance' }, exec())
  const atLast = await tool.execute({ action: 'show' }, exec())
  assert.equal(atLast.stage, 'record')
  const stuck = await tool.execute({ action: 'set', stage: 'build' }, exec())
  assert.equal(stuck.stage, 'record')
  assert.match(stuck.text, /allowSkip=false：不能从 record 跳到 build/)
  assert.match(stuck.text, /只能留在当前阶段（已经最后一阶）/)
})

test('allowSkip=true 时仍可自由跳阶（行为不变）', async () => {
  const { tool } = makeCtx('ask', { allowSkip: true, start: 'intake' })
  const jumped = await tool.execute({ action: 'set', stage: 'record' }, exec())
  assert.equal(jumped.stage, 'record')
  assert.doesNotMatch(jumped.text, /allowSkip=false/)
  assert.match(jumped.text, /阶段可跳/)
})

test('配了动画工程且技能闸门开着时，阶段清单说明技能前置', async () => {
  let tool
  const ctx = {
    get: (name) =>
      name === 'tools'
        ? {
            register(definition) {
              tool = definition
              return () => {}
            }
          }
        : undefined,
    effect: (factory) => factory()
  }
  registerStageTool(
    ctx,
    () => ({
      animation: { enabled: true, root: '/tmp/anim', softLimitSeconds: 120, gateSkill: true },
      stages: { allowSkip: true, start: 'intake' },
      tools: { stage: true }
    }),
    os.tmpdir(),
    () => undefined
  )
  const shown = await tool.execute({ action: 'set', stage: 'video-build' }, exec())
  assert.match(shown.text, /teach-animation/)
  assert.match(shown.text, /闸门/)
})
