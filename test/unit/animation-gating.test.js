import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../../lib/index.js'

/* D1：动画未配置时 4 个动画工具不注册（常驻 schema 少 9.1 KB）。
 * 用假上下文把插件真跑一遍，按配置对比工具清单 —— 不单测 registerAnimationTools 的内部门。 */

function boot(config) {
  const captured = { tools: [], sections: [], variables: [], skills: [], guards: [] }
  const services = {
    sessionProjections: { stateOf: () => ({ questions: { active: [], settled: [] } }) },
    tools: {
      register: (definition) => {
        captured.tools.push(definition)
        return () => {}
      },
      guard: (guard) => {
        captured.guards.push(guard)
        return () => {}
      }
    },
    systemPrompt: {
      section: (section) => {
        captured.sections.push(section)
        return () => {}
      },
      variable: (name) => {
        captured.variables.push(name)
        return () => {}
      }
    },
    skills: { register: (registration) => { captured.skills.push(registration); return () => {} } },
    workingDirectory: { get: () => process.cwd() },
    agents: { get: () => undefined },
    llm: { stream: () => {} },
    subprocess: { spawn: () => undefined, resolveExecutable: () => undefined },
    jobs: { start: () => 'job-d1' }
  }
  const ctx = {
    get: (name) => services[name],
    provide: () => {},
    inject: (_deps, callback) => callback(ctx),
    effect: (factory) => factory(),
    on: () => () => {},
    logger: { info: () => {}, warn: () => {} }
  }
  apply(ctx, config)
  return captured
}

const animationToolNames = ['teach_animation_inspect', 'teach_animation_register', 'teach_animation_render', 'teach_animation_sync']

test('默认（未配置动画）：19 个工具、8 段，4 个动画工具不注册', () => {
  const captured = boot({})
  const names = captured.tools.map((tool) => tool.name)
  assert.equal(names.length, 19)
  for (const name of animationToolNames) assert.equal(names.includes(name), false, name + ' 不该常驻')
  assert.equal(captured.sections.length, 8)
})

test('配置动画工程：23 个工具、9 段，与条件化之前一致', () => {
  const captured = boot({ animation: { root: '/tmp/d1-animation-project' } })
  const names = captured.tools.map((tool) => tool.name)
  assert.equal(names.length, 23)
  for (const name of animationToolNames) assert.equal(names.includes(name), true, name + ' 应注册')
  assert.equal(captured.sections.length, 9)
  assert.equal(captured.sections.some((section) => section.name === 'teach:60-animation'), true)
})

test('tools.animation=false 仍是显式总闸：即使配了工程也不注册动画工具', () => {
  const captured = boot({ animation: { root: '/tmp/d1-animation-project' }, tools: { animation: false } })
  const names = captured.tools.map((tool) => tool.name)
  assert.equal(names.length, 19)
  for (const name of animationToolNames) assert.equal(names.includes(name), false, name + ' 被显式关掉')
})
