import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { lintHtml } from '../../lib/lint.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-lint-css-'))
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-lint-css-empty-'))
for (const target of [dir, emptyDir]) {
  fs.mkdirSync(path.join(target, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(target, 'assets/course.js'), '')
}

// 与 templates/course.css 同一套上下文：.note 只在 .formula 里，.q 只在 .quiz 里，.num 只给 td/th 与 h2。
fs.writeFileSync(
  path.join(dir, 'assets/course.css'),
  [
    '.wrap{margin:0}',
    '.formula{margin:0}',
    '.eq{margin:0}',
    '.formula .note{display:block}',
    '.quiz .q{margin:0}',
    '.quiz{display:block}',
    'td.num,th.num{white-space:nowrap}',
    'h2 .num{margin-right:.7rem}',
    '.sidenav{position:sticky}',
    '.sidenav .label{display:block}',
    '.callout{padding:1rem}',
    '.callout .tag{display:block}',
    '.verdict{margin:0}',
    '.goals{margin:0}',
    '.goals::before{content:"学完你能做到"}'
  ].join('\n')
)
// 空样式表：类名检查要整体跳过，而不是把每个类都报成未知。
fs.writeFileSync(path.join(emptyDir, 'assets/course.css'), '')

const assets = '<link rel="stylesheet" href="assets/course.css"><script src="assets/course.js"></script>'
const file = path.join(dir, 'lesson.html')
const emptyFile = path.join(emptyDir, 'lesson.html')
const codes = (issues) => issues.map((issue) => issue.code)

const find = (issues, code) => issues.filter((issue) => issue.code === code)

test('类名只在别的上下文里有样式：<p class="note"> 落空，<div class="formula"> 里的 .note 正常', () => {
  const broken = lintHtml(assets + '<p class="note">① Randall &amp; Antoni 2011, p.506。</p>', file)
  const missing = find(broken, 'class-context-missing')
  assert.equal(missing.length, 1, JSON.stringify(broken))
  assert.equal(missing[0].level, 'warn')
  assert.match(missing[0].message, /\.formula \.note/)
  assert.match(missing[0].message, /p class="note"/)

  const correct = lintHtml(assets + '<div class="formula"><span class="eq">IF → ID</span><span class="note">一句说明</span></div>', file)
  assert.deepEqual(codes(correct).filter((code) => code.startsWith('class-')), [])
})

test('类名完全没定义时给 class-unknown（旧课程里的 class="cap" 就是这种）', () => {
  const issues = lintHtml(assets + '<p class="cap">式 1 · 点积</p>', file)
  const unknown = find(issues, 'class-unknown')
  assert.equal(unknown.length, 1, JSON.stringify(issues))
  assert.equal(unknown[0].level, 'warn')
  assert.match(unknown[0].message, /\.cap/)
  assert.match(unknown[0].message, /course\.css/)
})

test('主语带标签的选择器也认：td.num 通过，p.num 报上下文缺失', () => {
  const cell = lintHtml(assets + '<table><tr><td class="num">2048</td></tr></table>', file)
  assert.deepEqual(codes(cell).filter((code) => code.startsWith('class-')), [])

  const paragraph = lintHtml(assets + '<p class="num">2048</p>', file)
  assert.ok(find(paragraph, 'class-context-missing').length >= 1, JSON.stringify(paragraph))
})

test('祖先链按真结构匹配：sidenav 里的 .label 通过，正文里的 .label 报缺失', () => {
  const inside = lintHtml(assets + '<aside class="sidenav"><p class="label">本课路线</p></aside>', file)
  assert.deepEqual(codes(inside).filter((code) => code.startsWith('class-')), [])

  const outside = lintHtml(assets + '<p class="label">本课路线</p>', file)
  assert.equal(find(outside, 'class-context-missing').length, 1, JSON.stringify(outside))
})

test('运行时类名（teach-* / md-* / is-* / verdict / ok / no）不查', () => {
  const issues = lintHtml(
    assets + '<div class="md-copy-host teach-widget is-current"><p class="verdict ok">对。</p><p class="no">x</p></div>',
    file
  )
  assert.deepEqual(codes(issues).filter((code) => code.startsWith('class-')), [], JSON.stringify(issues))
})

test('页面内联 <style> 里的类也算已定义', () => {
  const page = assets + '<style>.local-note{color:#666}</style><p class="local-note">说明</p>'
  const issues = lintHtml(page, file)
  assert.deepEqual(codes(issues).filter((code) => code.startsWith('class-')), [], JSON.stringify(issues))
})

test('没有样式表 / 样式表为空时不猜类名（临时目录与老课程不误报）', () => {
  const issues = lintHtml(assets + '<p class="totally-unknown">正文</p>', emptyFile)
  assert.deepEqual(codes(issues).filter((code) => code.startsWith('class-')), [], JSON.stringify(issues))
})

test('::before 的 content 被记下来（.goals 骨架检查靠它，不是猜）', () => {
  const issues = lintHtml(assets + '<div class="goals"><p>学完你能做到</p><ol><li>能算一遍</li></ol></div>', file)
  assert.ok(find(issues, 'goals-duplicate-title').length === 1, JSON.stringify(issues))
})
