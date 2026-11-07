import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { registerPrompt } from '../../lib/prompt.js'

/* D1：动画篇按配置条件化（Q-D1/Q-D3）。
 * 关键点不是"少一段"，而是：跳过必须在循环内完成，其它段的 order 与内容一个字都不动。 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function configOf(overrides = {}) {
  return {
    prompt: { enabled: true, dir: '' },
    animation: { enabled: false, root: '', softLimitSeconds: 120, gateSkill: true },
    ...overrides
  }
}

function harness(config) {
  const sections = []
  const variables = []
  const ctx = {
    get(name) {
      if (name !== 'systemPrompt') return undefined
      return {
        section: (section) => {
          sections.push(section)
          return () => {}
        },
        variable: (name, provider) => {
          variables.push({ name, provider })
          return () => {}
        }
      }
    },
    effect: (factory) => factory(),
    logger: { warn: () => {} }
  }
  const result = registerPrompt(ctx, () => config, packageRoot)
  return { sections, variables, result }
}

test('未配置动画：60-animation 不注入，其余段与 order 保持原样（不重排）', () => {
  const { sections, result } = harness(configOf())
  const names = sections.map((section) => section.name)
  assert.deepEqual(names, [
    'teach:10-startup',
    'teach:20-ask',
    'teach:30-lesson',
    'teach:40-writing',
    'teach:50-questions',
    'teach:70-production',
    'teach:80-freedom'
  ])
  // order 以原始文件索引计算：动画篇的 150 留空，后面的段不前移。
  assert.deepEqual(sections.map((section) => section.order), [100, 110, 120, 130, 140, 160, 170])
  assert.equal(result.sections.length, 7)
})

test('配置动画：8 段全回来，60-animation 仍在原位置（150）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-d1-anim-'))
  try {
    const { sections } = harness(configOf({ animation: { enabled: true, root, softLimitSeconds: 120, gateSkill: true } }))
    assert.deepEqual(sections.map((section) => section.name), [
      'teach:10-startup',
      'teach:20-ask',
      'teach:30-lesson',
      'teach:40-writing',
      'teach:50-questions',
      'teach:60-animation',
      'teach:70-production',
      'teach:80-freedom'
    ])
    assert.deepEqual(sections.map((section) => section.order), [100, 110, 120, 130, 140, 150, 160, 170])
    assert.equal(sections.find((section) => section.name === 'teach:60-animation').interpolate, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('变量不随条件化消失（4 个包内路径 + 4 个运行期仍全在）', () => {
  const disabled = harness(configOf())
  assert.equal(disabled.variables.length, 8)
  assert.deepEqual(disabled.variables.map((item) => item.name).sort(), [
    'teach_animation_root',
    'teach_animation_soft_limit',
    'teach_animation_state',
    'teach_package',
    'teach_prompts',
    'teach_skills',
    'teach_staging_dir',
    'teach_templates'
  ])
})

test('自定义 prompt 目录同样按文件名条件化，不因目录不同漏判', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-d1-prompt-'))
  try {
    fs.writeFileSync(path.join(dir, '10-startup.md'), '# 启动')
    fs.writeFileSync(path.join(dir, '60-animation.md'), '# 动画')
    const disabled = harness(configOf({ prompt: { enabled: true, dir } }))
    assert.deepEqual(disabled.sections.map((section) => section.name), ['teach:10-startup'])
    const enabled = harness(configOf({ prompt: { enabled: true, dir }, animation: { enabled: true, root: dir, softLimitSeconds: 120, gateSkill: true } }))
    assert.deepEqual(enabled.sections.map((section) => section.name), ['teach:10-startup', 'teach:60-animation'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
