import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { registerPrompt } from '../../lib/prompt.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const recipes = path.join(root, 'templates/recipes')
const manifest = JSON.parse(fs.readFileSync(path.join(recipes, 'UPSTREAM.json'), 'utf8'))

test('上游配方原件保持固定提交与逐字可核验内容，许可随包保存', () => {
  assert.equal(manifest.assets.length, 3)
  for (const asset of manifest.assets) {
    const bytes = fs.readFileSync(path.join(recipes, asset.file))
    assert.match(asset.commit, /^[a-f0-9]{40}$/)
    assert.ok(asset.url.includes('/blob/' + asset.commit + '/'))
    assert.equal(asset.modified, false)
    assert.equal(bytes.length, asset.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
  }
  assert.match(fs.readFileSync(path.join(recipes, 'upstream/LICENSE-DeepTutor.txt'), 'utf8'), /Apache License/)
  assert.match(fs.readFileSync(path.join(recipes, 'upstream/LICENSE-OpenMAIC.txt'), 'utf8'), /MIT License/)
})

test('运行时只注入短入口，上游大配方不进入常驻系统提示', () => {
  const sections = []
  const service = { section: (section) => sections.push(section), variable() {} }
  const ctx = { get: (name) => name === 'systemPrompt' ? service : undefined, effect: (effect) => effect() }
  // D1：未配置动画时 60-animation 不常驻，短入口引用在动画篇里 —— 这里显式配置动画，
  // 才能断言"动画篇常驻的是短入口、不是上游大配方"。
  const result = registerPrompt(ctx, () => ({ prompt: { dir: '' }, animation: { enabled: true, root: '/tmp/recipe-animation' } }), root)
  assert.ok(result.sections.includes('teach:30-lesson'))
  const text = sections.map((section) => section.text).join('\n')
  assert.match(text, /COMPONENTS\.md/)
  assert.match(text, /recipes\/INDEX\.md/)
  assert.match(text, /recipes\/remotion-reuse\.md/)
  for (const asset of manifest.assets) {
    const original = fs.readFileSync(path.join(recipes, asset.file), 'utf8').trim()
    assert.equal(text.includes(original), false, asset.file + ' should be on demand')
  }
  assert.equal(sections.some((section) => /recipe|upstream/.test(section.name)), false)
})

test('按需资源的本地指引均可到达，适配版包含当前课堂边界', () => {
  const files = ['INDEX.md', 'lesson-composition.md', 'diagram.md', 'simulation.md', 'remotion-reuse.md', 'NOTICE.md']
  for (const name of files) {
    const file = path.join(recipes, name)
    const text = fs.readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^[a-z]+:/i.test(match[1]) || match[1].startsWith('#')) continue
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), match[1].split('#')[0])), name + ': ' + match[1])
    }
  }
  const lesson = fs.readFileSync(path.join(recipes, 'lesson-composition.md'), 'utf8')
  assert.match(lesson, /\.quiz/)
  assert.match(lesson, /不强制每课有动画或实验/)
  const simulation = fs.readFileSync(path.join(recipes, 'simulation.md'), 'utf8')
  assert.match(simulation, /本地操作不请求模型/)
  assert.match(simulation, /p\[data-teach-state\]/)
  const animation = fs.readFileSync(path.join(recipes, 'remotion-reuse.md'), 'utf8')
  assert.match(animation, /先取得这次动画制作的同意/)
  assert.match(animation, /teach_animation_sync/)
})
