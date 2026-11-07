import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { lintHtml } from '../../lib/lint.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-lint-structure-'))
fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
fs.writeFileSync(path.join(dir, 'assets/course.js'), '')
fs.writeFileSync(
  path.join(dir, 'assets/course.css'),
  [
    '.shell{display:grid}',
    '.shell .wrap{margin:0}',
    '.wrap{margin:0}',
    '.sidenav{position:sticky}',
    '.sidenav .label{display:block}',
    'nav.toc{margin:0}',
    '.goals{margin:0}',
    '.goals::before{content:"学完你能做到"}',
    '.quiz{display:block}',
    '.quiz .q{margin:0}',
    '.verdict{margin:0}',
    '.callout{padding:1rem}',
    '.formula{margin:0}',
    '.formula .note{display:block}'
  ].join('\n')
)

const assets = '<link rel="stylesheet" href="../assets/course.css"><script src="../assets/course.js"></script>'
const codes = (issues) => issues.map((issue) => issue.code)
const find = (issues, code) => issues.filter((issue) => issue.code === code)

function writePage(name, body, { folder = 'lessons' } = {}) {
  const root = path.join(dir, folder)
  fs.mkdirSync(root, { recursive: true })
  const target = path.join(root, name)
  fs.writeFileSync(target, '<!doctype html><html><head>' + assets + '</head><body>' + body + '</body></html>')
  return target
}

const quiz =
  '<div class="quiz" data-question-id="q-1" data-explain="解释。" data-scope="口径：按定义算。">' +
  '<p class="q">题干。</p>' +
  '<label><input type="radio" name="q1" value="a">选项一</label>' +
  '<label><input type="radio" name="q1" value="b" data-ok="1">选项二</label>' +
  '<button type="button">判卷</button><p class="verdict"></p></div>'

const toc = (items) => '<nav class="toc"><p>本课路线</p><ol>' + items + '</ol></nav>'
const sidenav = (items) => '<aside class="sidenav"><p class="label">本课路线</p><nav><ol>' + items + '</ol></nav></aside>'
const link = (id, text) => '<li><a href="#' + id + '">' + text + '</a></li>'

test('.goals 里重复写 CSS ::before 的标题是硬伤；没有那一行就不报', () => {
  const duplicate = writePage(
    'goals-bad.html',
    '<div class="goals"><p>学完你能做到</p><ol><li>能算一遍</li></ol></div>'
  )
  const issues = lintHtml(fs.readFileSync(duplicate, 'utf8'), duplicate)
  const errors = find(issues, 'goals-duplicate-title')
  assert.equal(errors.length, 1, JSON.stringify(issues))
  assert.equal(errors[0].level, 'error')
  assert.equal(errors[0].line, 1)

  const clean = writePage('goals-good.html', '<div class="goals"><ol><li>能算一遍</li></ol></div>')
  assert.deepEqual(codes(lintHtml(fs.readFileSync(clean, 'utf8'), clean)).filter((code) => code.startsWith('goals-')), [])
})

test('div.shell 缺 aside.sidenav 是硬伤；补上就不报；放错位置只是提醒', () => {
  const broken = writePage('shell-bad.html', '<div class="shell"><div class="wrap"><p>正文</p></div></div>')
  const missing = find(lintHtml(fs.readFileSync(broken, 'utf8'), broken), 'shell-without-sidenav')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].level, 'error')
  assert.match(missing[0].message, /13\.5rem/)

  const good = writePage('shell-good.html', '<div class="shell">' + sidenav(link('s1', '第一节')) + '<div class="wrap"><p>正文</p></div></div>')
  assert.deepEqual(
    codes(lintHtml(fs.readFileSync(good, 'utf8'), good)).filter((code) => code.startsWith('shell-') || code === 'sidenav-not-first'),
    []
  )

  const late = writePage('shell-late.html', '<div class="shell"><div class="wrap"><p>正文</p></div>' + sidenav(link('s1', '第一节')) + '</div>')
  const notFirst = find(lintHtml(fs.readFileSync(late, 'utf8'), late), 'sidenav-not-first')
  assert.equal(notFirst.length, 1)
  assert.equal(notFirst[0].level, 'warn')
})

test('侧栏与顶部目录：条目缺失与文案漂移都只提醒', () => {
  const drift = writePage(
    'toc-drift.html',
    '<div class="shell">' +
      sidenav(link('s1', '01 · 掩模') + link('s2', '02 · 定点账')) +
      '<div class="wrap">' +
      toc(link('s1', '01 · 掩模：解析信号') + link('s2', '02 · 定点账')) +
      '</div></div>'
  )
  const issues = lintHtml(fs.readFileSync(drift, 'utf8'), drift)
  const labelDrift = find(issues, 'toc-label-drift')
  assert.equal(labelDrift.length, 1, JSON.stringify(issues))
  assert.equal(labelDrift[0].level, 'warn')
  assert.match(labelDrift[0].message, /掩模/)

  const missing = writePage(
    'toc-missing.html',
    '<div class="shell">' + sidenav(link('s1', '第一节')) + '<div class="wrap">' + toc(link('s2', '第二节')) + '</div></div>'
  )
  const mismatched = find(lintHtml(fs.readFileSync(missing, 'utf8'), missing), 'toc-entry-mismatch')
  assert.ok(mismatched.length >= 2, JSON.stringify(mismatched))
  assert.ok(mismatched.every((issue) => issue.level === 'warn'))
})

test('推荐一手资源却没有外链：提醒；补一条 https 就消', () => {
  const claim =
    '<section id="read"><h2>08 先去读这个</h2><p>一手资源，按你现在的方向挑一个：Randall &amp; Antoni 2011。</p></section>'
  const warned = writePage('read-no-link.html', claim)
  const issues = find(lintHtml(fs.readFileSync(warned, 'utf8'), warned), 'resources-without-link')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].level, 'warn')

  const linked = writePage(
    'read-link.html',
    claim.replace('Randall', '<a href="https://example.org/paper.pdf">Randall</a>')
  )
  assert.equal(find(lintHtml(fs.readFileSync(linked, 'utf8'), linked), 'resources-without-link').length, 0)
})

test('课中没有让他先出力的地方：提醒；课中自测或折叠揭晓都能消', () => {
  const onlyCheck = writePage('output-none.html', '<section id="check"><h2>07 验收</h2>' + quiz + '</section>')
  const warned = find(lintHtml(fs.readFileSync(onlyCheck, 'utf8'), onlyCheck), 'no-student-output')
  assert.equal(warned.length, 1)
  assert.equal(warned[0].level, 'warn')

  const midQuiz = writePage('output-quiz.html', '<section id="s1">' + quiz + '</section><section id="check">' + quiz + '</section>')
  assert.equal(find(lintHtml(fs.readFileSync(midQuiz, 'utf8'), midQuiz), 'no-student-output').length, 0)

  const details = writePage(
    'output-details.html',
    '<section id="s1"><details><summary>先猜一下再点开</summary><p>答案。</p></details></section><section id="check">' + quiz + '</section>'
  )
  assert.equal(find(lintHtml(fs.readFileSync(details, 'utf8'), details), 'no-student-output').length, 0)

  const hint = writePage(
    'output-hint.html',
    '<section id="s1"><p>先自己算一遍再往下看。</p></section><section id="check">' + quiz + '</section>'
  )
  assert.equal(find(lintHtml(fs.readFileSync(hint, 'utf8'), hint), 'no-student-output').length, 0)
})

test('参考页不套课程页专属检查（reference/ 里没有 #check 也不报课中出力）', () => {
  const reference = writePage('glossary.html', '<p>一手资源见别处。</p>', { folder: 'reference' })
  const issues = lintHtml(fs.readFileSync(reference, 'utf8'), reference)
  assert.equal(find(issues, 'no-student-output').length, 0, JSON.stringify(issues))
  assert.equal(find(issues, 'resources-without-link').length, 0, JSON.stringify(issues))

  const brokenShell = writePage('glossary-shell.html', '<div class="shell"><div class="wrap"><p>术语</p></div></div>', {
    folder: 'reference'
  })
  assert.equal(find(lintHtml(fs.readFileSync(brokenShell, 'utf8'), brokenShell), 'shell-without-sidenav').length, 1)
})
