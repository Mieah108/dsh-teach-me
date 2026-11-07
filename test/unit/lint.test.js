import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { lintHtml, lintMarkdown, lintOutsideWorkspaceRefs } from '../../lib/lint.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-lint-'))
fs.mkdirSync(path.join(dir, 'assets/mathjax'), { recursive: true })
for (const name of ['course.css', 'course.js', 'mathjax/tex-svg.js']) fs.writeFileSync(path.join(dir, 'assets', name), '')
const file = path.join(dir, '0001-demo.html')
const markdown = path.join(dir, '0001-demo.md')
const assets = '<link rel="stylesheet" href="assets/course.css"><script src="assets/course.js"></script>'
const errors = (issues) => issues.filter((issue) => issue.level === 'error')
const codes = (issues) => new Set(issues.map((issue) => issue.code))

test('TAB 吃掉的 \\theta 被认成公式损坏，而不是普通缩进', () => {
  const tab = String.fromCharCode(9)
  assert.ok(errors(lintMarkdown('公式 $' + tab + 'heta_i$。', markdown)).some((issue) => issue.code === 'escaped-latex'))
  assert.equal(errors(lintMarkdown('\t缩进的一段代码\n\n正文。', markdown)).length, 0)
})

test('行内公式没有闭合会被指出来，货币写法不误报', () => {
  assert.ok(errors(lintMarkdown('公式 $x + y 还没写完。', markdown)).some((issue) => issue.code === 'unbalanced-inline'))
  assert.equal(errors(lintMarkdown('价格 $5 和 $10，都在预算内。', markdown)).length, 0)
})

test('资源名只写在注释里不算引入', () => {
  const found = codes(lintHtml('<!-- course.css course.js tex-svg.js -->', file))
  assert.ok(found.has('no-course-js'))
  assert.ok(found.has('no-course-css'))
})

test('页面自己写「提交到课堂」按钮要提醒（桥会自动补一只，手写那只默认不生效）', () => {
  const handWritten = assets + '<div class="quiz" data-question-id="q1"><textarea></textarea><button type="button">提交到课堂</button></div>'
  const issues = lintHtml(handWritten, file)
  assert.equal(issues.filter((issue) => issue.level === 'error').length, 0, '这是提醒不是硬伤')
  const warned = issues.filter((issue) => issue.code === 'quiz-manual-submit')
  assert.equal(warned.length, 1)
  assert.equal(warned[0].level, 'warn')
  // 作者自己挂 data-teach-submit（桥接管这一只）就不提醒
  const wired = assets + '<div class="quiz" data-question-id="q1"><textarea></textarea><button type="button" data-teach-submit>交卷</button></div>'
  assert.equal(lintHtml(wired, file).filter((issue) => issue.code === 'quiz-manual-submit').length, 0)
})

test('公式里被多转义一层（双反斜杠 + 字母）要报硬伤：MathJax 会把双反斜杠当换行', () => {
  const bs = String.fromCharCode(92)
  const twice = assets + '<p>公式 $' + bs + bs + 'mathbf{a}$。</p>'
  const once = assets + '<p>公式 $' + bs + 'mathbf{a}$。</p>'
  assert.ok(
    errors(lintHtml(twice, file)).some((issue) => issue.code === 'double-escaped-latex'),
    '多转义一层必须报出来（否则页面看起来 0 硬伤、公式却全废）'
  )
  assert.equal(errors(lintHtml(once, file)).some((issue) => issue.code === 'double-escaped-latex'), false)
  // aligned 的换行（双反斜杠后跟换行）是合法写法，不能误报
  const rowBreak = bs + bs + '\n'
  const aligned = assets + '<p>$$' + bs + 'begin{aligned}a&=1' + rowBreak + 'b&=2' + rowBreak + bs + 'end{aligned}$$</p>'
  assert.equal(errors(lintHtml(aligned, file)).some((issue) => issue.code === 'double-escaped-latex'), false)
})

test('引用了本地依赖就必须真的存在', () => {
  const found = codes(lintHtml('<link rel="stylesheet" href="missing/course.css"><script src="missing/course.js"></script>', file))
  assert.ok(found.has('script-missing'))
  assert.ok(found.has('link-missing'))
})

test('正确标记必须落在 radio 上', () => {
  const issues = lintHtml(
    assets +
      '<div class="quiz" data-explain="why" data-scope="test"><p>Question</p><span data-ok="1">not an answer</span><label><input type="radio" name="q1">wrong</label><button>check</button><p class="verdict"></p></div>',
    file
  )
  assert.ok(errors(issues).some((issue) => issue.code === 'quiz-correct-target'))
})

test('单引号写的 quiz 也会检查正确答案', () => {
  const issues = lintHtml(assets + "<div class='quiz'><input type='radio' name='q1'><button>check</button><p class='verdict'></p></div>", file)
  assert.ok(errors(issues).some((issue) => issue.code === 'quiz-correct'))
})

test('嵌套 div 的有效 quiz 不误报', () => {
  const issues = lintHtml(
    assets +
      '<div class="quiz" data-explain="why" data-scope="test"><div>Question</div><input type="radio" name="q1" data-ok="1"><button>check</button><p class="verdict"></p></div>',
    file
  )
  assert.equal(errors(issues).length, 0, JSON.stringify(issues))
})

test('同一道题的 radio 必须同组', () => {
  const found = codes(lintHtml(assets + '<div class="quiz" data-explain="x"><input type="radio" name="a"><input type="radio" name="b" data-ok="1"></div>', file))
  assert.ok(found.has('quiz-radio-group'))
})

test('data-multi="1"：正确项可以有多条，写在 checkbox 上也认；无 radio 只是提醒', () => {
  const issues = lintHtml(
    assets +
      '<div class="quiz" data-multi="1" data-explain="why" data-scope="口径：按定义算。"><p>Question</p>' +
      '<label><input type="checkbox" name="q1" value="a" data-ok="1">a</label>' +
      '<label><input type="checkbox" name="q1" value="b">b</label>' +
      '<label><input type="checkbox" name="q1" value="c" data-ok="1">c</label>' +
      '<button type="button">判卷</button><p class="verdict"></p></div>',
    file
  )
  assert.equal(errors(issues).length, 0, JSON.stringify(issues))
  const noRadio = issues.filter((issue) => issue.code === 'quiz-no-radio')
  assert.equal(noRadio.length, 1)
  assert.equal(noRadio[0].level, 'warn')
  assert.match(noRadio[0].message, /data-multi/)
})

test('data-multi="1" 一个正确项都没有仍是硬伤', () => {
  const issues = lintHtml(
    assets +
      '<div class="quiz" data-multi="1" data-explain="x" data-scope="口径"><p>Q</p>' +
      '<input type="checkbox" name="q1" value="a"><input type="checkbox" name="q1" value="b">' +
      '<button>check</button><p class="verdict"></p></div>',
    file
  )
  assert.ok(errors(issues).some((issue) => issue.code === 'quiz-correct'))
})

test('非多选的 checkbox 带 data-ok 会被点名（单选正确项必须落在 radio）', () => {
  const issues = lintHtml(
    assets +
      '<div class="quiz" data-explain="x" data-scope="口径"><p>Q</p>' +
      '<label><input type="checkbox" name="q1" value="a" data-ok="1">a</label>' +
      '<label><input type="checkbox" name="q1" value="b">b</label>' +
      '<button>check</button><p class="verdict"></p></div>',
    file
  )
  assert.ok(errors(issues).some((issue) => issue.code === 'quiz-correct-target'))
})

test('没有 radio 但有可取值控件：只提醒「课堂能提交、本地不判分」，不当硬伤', () => {
  for (const control of [
    '<select name="q1"><option value="a">a</option></select>',
    '<textarea name="q1"></textarea>',
    '<input type="text" name="q1">',
    '<input type="number" name="q1">',
    '<input name="q1">'
  ]) {
    const issues = lintHtml(assets + '<div class="quiz" data-explain="x" data-scope="口径"><p>Q</p>' + control + '<button>check</button><p class="verdict"></p></div>', file)
    assert.equal(errors(issues).length, 0, control + ' -> ' + JSON.stringify(issues))
    const noRadio = issues.filter((issue) => issue.code === 'quiz-no-radio')
    assert.equal(noRadio.length, 1, control)
    assert.equal(noRadio[0].level, 'warn')
    assert.match(noRadio[0].message, /课堂里可以提交/)
    assert.match(noRadio[0].message, /本地 course\.js 不判分/)
  }
})

test('一个可取值控件都没有才是硬伤', () => {
  const issues = lintHtml(assets + '<div class="quiz" data-explain="x" data-scope="口径"><p>Q</p><button>check</button><p class="verdict"></p></div>', file)
  const noRadio = errors(issues).filter((issue) => issue.code === 'quiz-no-radio')
  assert.equal(noRadio.length, 1)
  assert.match(noRadio[0].message, /没有任何可取值控件/)
})

test('样式表为空时不猜类名：临时目录与老课程不会因为类名被报硬伤', () => {
  const issues = lintHtml(assets + '<p class="any-old-class">正文</p>', file)
  assert.equal(errors(issues).length, 0, JSON.stringify(issues))
  assert.equal(codes(issues).has('class-unknown'), false)
  assert.equal(codes(issues).has('class-context-missing'), false)
})
test('页面引用越出工作区时 lint 报硬伤：与 teach_commit 的资源边界同一判定', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-lint-outside-'))
  try {
    const ws = path.join(base, 'course')
    fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
    fs.writeFileSync(path.join(base, 'outside.png'), 'x')
    const page = path.join(ws, 'lessons', '0001.html')
    const html = '<img src="../../outside.png" alt="越界">'
    const issues = lintOutsideWorkspaceRefs(html, page, ws)
    assert.equal(issues.length, 1)
    assert.equal(issues[0].level, 'error')
    assert.equal(issues[0].code, 'ref-outside-workspace')

    // 工作区内缺失只算缺失（由 img-missing 报），不升级成越界；越界但也不存在的交给缺失那条，不重复报。
    assert.equal(lintOutsideWorkspaceRefs('<img src="../assets/missing.png" alt="x">', page, ws).length, 0)
    assert.equal(lintOutsideWorkspaceRefs('<img src="../../nope.png" alt="x">', page, ws).length, 0)
    assert.equal(lintOutsideWorkspaceRefs('<a href="https://example.org/x">x</a><a href="#s1">s</a>', page, ws).length, 0)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
