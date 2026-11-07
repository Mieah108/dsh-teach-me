import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { lintHtml } from '../../lib/lint.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-lint-restate-'))
fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
for (const name of ['assets/course.css', 'assets/course.js']) fs.writeFileSync(path.join(dir, name), '')
// 放在 lessons/ 下：课程页专属检查（复述题、课中出力）按这个作用域跑。
const assets = '<link rel="stylesheet" href="../assets/course.css"><script src="../assets/course.js"></script>'
const lessons = path.join(dir, 'lessons')
fs.mkdirSync(lessons, { recursive: true })
const find = (issues, code) => issues.filter((issue) => issue.code === code)

function page(name, body) {
  const target = path.join(lessons, name)
  fs.writeFileSync(target, '<!doctype html><html><head>' + assets + '</head><body>' + body + '</body></html>')
  return target
}

function quiz({ explain, options, name = 'q1' }) {
  return (
    '<div class="quiz" data-question-id="q-1" data-explain="' + explain + '" data-scope="口径：按定义算。">' +
    '<p class="q">题干。</p>' +
    options
      .map((option, index) => '<label><input type="radio" name="' + name + '" value="' + index + '"' + (option.ok ? ' data-ok="1"' : '') + '>' + option.text + '</label>')
      .join('') +
    '<button type="button">判卷</button><p class="verdict"></p></div>'
  )
}

// 真实页面（Signal-processing 第一课）§05 的正文：满量程单音的位宽推导。
const BODY_FIXED_POINT =
  '<section id="s5"><h2>05 定点账</h2><p>单个满量程正弦并不需要 28 位：最坏那个 bin 上是 32767×2048=67 106 816，而 2^26=67 108 864 刚好比它大，27 位就够。28 位是按满精度界给的。</p></section>'

test('验收题的解释与正确项数字全在正文里：提醒是复述题', () => {
  const target = page(
    'restate.html',
    BODY_FIXED_POINT +
      '<section id="check"><h2>07 验收</h2>' +
      quiz({
        explain: '|X[k]| = 32767×2048 = 67 106 816，而 2^26 = 67 108 864 刚好比它大，所以 27 位有符号就够。',
        options: [
          { text: '26 位' },
          { text: '27 位', ok: true },
          { text: '28 位' }
        ]
      }) +
      '</section>'
  )
  const issues = find(lintHtml(fs.readFileSync(target, 'utf8'), target), 'quiz-restates-body')
  assert.equal(issues.length, 1, JSON.stringify(lintHtml(fs.readFileSync(target, 'utf8'), target)))
  assert.equal(issues[0].level, 'warn')
  assert.match(issues[0].message, /正文/)
  assert.match(issues[0].message, /换情境/)
})

test('换了参数/情境的验收题不报（正文 30/34，题问 200/216）', () => {
  const target = page(
    'fresh.html',
    '<section id="s1"><h2>01 间隔</h2><p>信号是 30 Hz 与 34 Hz 两条谱线，间隔 4 Hz，包络谱落在 4 Hz。</p></section>' +
      '<section id="check"><h2>07 验收</h2>' +
      quiz({
        explain: '包络是 2|cos(2π·8n/4096)|，主谱线落在 |200−216|=16 Hz。',
        options: [{ text: '16 Hz', ok: true }, { text: '8 Hz' }, { text: '208 Hz' }]
      }) +
      '</section>'
  )
  assert.equal(find(lintHtml(fs.readFileSync(target, 'utf8'), target), 'quiz-restates-body').length, 0)
})

test('数字 token 太少时不判（避免把参数复用当复述）', () => {
  const target = page(
    'few.html',
    '<section id="s1"><p>N=4096。</p></section><section id="check">' +
      quiz({ explain: '答案 27 位。', options: [{ text: '27 位', ok: true }, { text: '28 位' }] }) +
      '</section>'
  )
  assert.equal(find(lintHtml(fs.readFileSync(target, 'utf8'), target), 'quiz-restates-body').length, 0)
})

test('只查验收区：课中自测与正文数字重合不算复述', () => {
  const target = page(
    'mid.html',
    BODY_FIXED_POINT
      .replace('</section>', '</section>')
      .replace('<section id="s5">', '<section id="s5">') +
      '<section id="s4">' +
      quiz({
        explain: '|X[k]| = 32767×2048 = 67 106 816，2^26 = 67 108 864，27 位就够。',
        options: [{ text: '27 位', ok: true }, { text: '28 位' }]
      }) +
      '</section>' +
      '<section id="check">' +
      quiz({
        explain: '换个情境：Q15 满量程 ±32768，平方和上界 2^31，32 位有符号差 1 个 LSB。',
        options: [{ text: '32 位够' }, { text: '要 33 位', ok: true }]
      }) +
      '</section>'
  )
  assert.equal(find(lintHtml(fs.readFileSync(target, 'utf8'), target), 'quiz-restates-body').length, 0)
})

test('没有 section#check 的页面不跑复述检查', () => {
  const target = page('no-check.html', BODY_FIXED_POINT + quiz({ explain: '32767×2048 = 67 106 816，2^26 = 67 108 864，27 位。', options: [{ text: '27 位', ok: true }] }))
  assert.equal(find(lintHtml(fs.readFileSync(target, 'utf8'), target), 'quiz-restates-body').length, 0)
})
