import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { lintHtml } from '../../lib/lint.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-lint-qid-'))
fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
for (const name of ['course.css', 'course.js']) fs.writeFileSync(path.join(dir, 'assets', name), '')
const file = path.join(dir, '0002-demo.html')
const assets = '<link rel="stylesheet" href="assets/course.css"><script src="assets/course.js"></script>'
const warnings = (issues) => issues.filter((issue) => issue.level === 'warn')
const codes = (issues) => new Set(issues.map((issue) => issue.code))

/** 一道德育...一道结构完整的自测题；questionId 省略时不写 data-question-id。 */
function quiz(questionId) {
  const id = questionId === undefined ? '' : ' data-question-id="' + questionId + '"'
  return (
    '<div class="quiz"' + id + ' data-explain="解释" data-scope="口径：按定义算。">' +
    '<p class="q"><span class="tag">自测</span>题干。</p>' +
    '<label><input type="radio" name="q1">选项一</label>' +
    '<label><input type="radio" name="q1" data-ok="1">选项二</label>' +
    '<button type="button">判卷</button><p class="verdict"></p></div>'
  )
}

test('quiz 没有 data-question-id 时给一条提醒（不是硬伤），有属性时不提醒', () => {
  const without = lintHtml(assets + quiz(), file)
  const reminder = warnings(without).filter((issue) => issue.code === 'quiz-question-id')
  assert.equal(reminder.length, 1)
  assert.match(reminder[0].message, /课堂提交不会挂上/)
  // 提醒里的顺序要和课堂挂点的真实顺序一致：核对 id → 登记 → 正式 publish，登记后不重发
  assert.match(reminder[0].message, /dryRun/)
  assert.match(reminder[0].message, /teach_question_register/)
  assert.match(reminder[0].message, /不要重新发布/)
  assert.equal(without.filter((issue) => issue.level === 'error').length, 0, JSON.stringify(without))

  const withId = lintHtml(assets + quiz('q-1'), file)
  assert.equal(codes(withId).has('quiz-question-id'), false)

  // 两种引号都认
  const single = lintHtml(assets + "<div class=\"quiz\" data-question-id='q-2' data-explain='x' data-scope='口径'>" +
    '<input type="radio" name="q1" data-ok="1"><button type="button">判卷</button></div>', file)
  assert.equal(codes(single).has('quiz-question-id'), false)
})

test('题数说法认中文数字：「三题」「四题」「十二题」都要和实际 quiz 数比', () => {
  // 三题 + 三道 quiz：对得上
  const match = lintHtml(assets + '<p>本课三题，做完再看解释。</p>' + quiz('q-1') + quiz('q-2') + quiz('q-3'), file)
  assert.equal(codes(match).has('quiz-count-claim'), false, JSON.stringify(match))

  // 说四题、实际三题：要报
  const mismatch = lintHtml(assets + '<p>本课四题。</p>' + quiz('q-1') + quiz('q-2') + quiz('q-3'), file)
  const claim = warnings(mismatch).find((issue) => issue.code === 'quiz-count-claim')
  assert.ok(claim !== undefined, JSON.stringify(mismatch))
  assert.match(claim.message, /「四题」/)
  assert.match(claim.message, /实际有 3 道/)

  // 说三题、实际两题：也要报
  const fewer = lintHtml(assets + '<p>这一课三题。</p>' + quiz('q-1') + quiz('q-2'), file)
  assert.ok(warnings(fewer).some((issue) => issue.code === 'quiz-count-claim'))

  // 两位数的中文数字
  const dozen = lintHtml(assets + '<p>本课十二题。</p>' + quiz('q-1'), file)
  assert.ok(warnings(dozen).some((issue) => issue.code === 'quiz-count-claim'))
})

test('题数说法不误报：带「道」的旧写法、「第一题」这类序号、「再来一题」这类短语', () => {
  const withUnit = lintHtml(assets + '<p>本课共 3 道自测题。</p>' + quiz('q-1') + quiz('q-2') + quiz('q-3'), file)
  assert.equal(codes(withUnit).has('quiz-count-claim'), false, JSON.stringify(withUnit))

  const ordinal = lintHtml(assets + '<p>回到第一题再看一遍，再看第二题。</p>' + quiz('q-1') + quiz('q-2') + quiz('q-3'), file)
  assert.equal(codes(ordinal).has('quiz-count-claim'), false, JSON.stringify(ordinal))

  const phrase = lintHtml(assets + '<p>做完这一题再来一题。</p>' + quiz('q-1') + quiz('q-2'), file)
  assert.equal(codes(phrase).has('quiz-count-claim'), false, JSON.stringify(phrase))
})
