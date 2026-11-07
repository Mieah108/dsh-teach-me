import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { parseHTML } from 'linkedom'

const course = fs.readFileSync(new URL('../../templates/course.js', import.meta.url), 'utf8')

/** 用真实 DOM 跑 course.js：判卷只看 .verdict 的文案与类名。 */
function browser(markup) {
  const { window, document } = parseHTML('<!doctype html><html><body>' + markup + '</body></html>')
  Object.defineProperty(document, 'readyState', { value: 'complete' })
  const copied = []
  const navigator = { clipboard: { writeText: (text) => { copied.push(text); return Promise.resolve() } } }
  const context = vm.createContext({ window, document, navigator, console, Map, Promise, Date, setTimeout: () => 1, clearTimeout: () => {} })
  vm.runInContext(course, context)
  const quiz = document.querySelector('.quiz')
  const check = quiz.querySelector('button')
  const verdict = () => quiz.querySelector('.verdict')
  // linkedom 里 :checked 只认属性；同时设 property，让多选的 .checked 读取也一致。
  const select = (values) => {
    for (const input of quiz.querySelectorAll('input')) {
      const on = values.includes(input.getAttribute('value'))
      input.checked = on
      if (on) input.setAttribute('checked', '')
      else input.removeAttribute('checked')
    }
  }
  return { window, document, quiz, check, verdict, select }
}

const multiQuiz = `<div class="quiz" data-multi="1" data-question-id="q-2" data-explain="两处都要：条件与口径。">
  <p class="q">哪些说法成立？</p>
  <label><input type="checkbox" name="q2" value="a" data-ok="1">说法一</label>
  <label><input type="checkbox" name="q2" value="b">说法二</label>
  <label><input type="checkbox" name="q2" value="c" data-ok="1">说法三</label>
  <button type="button">判卷</button><p class="verdict"></p>
</div>`

test('多选：选中集合与 data-ok 集合一致才算对，并记「已看过解答」', () => {
  const { quiz, check, verdict, select } = browser(multiQuiz)
  select(['a', 'c'])
  check.dispatchEvent(new (quiz.ownerDocument.defaultView.Event)('click', { bubbles: true }))
  assert.match(verdict().textContent, /^对。/)
  assert.match(verdict().textContent, /两处都要/)
  assert.equal(verdict().className, 'verdict ok')
  assert.equal(quiz.getAttribute('data-teach-showed-solution'), '1')
})

test('多选：只选一半、或连错项一起选，都算错', () => {
  const partial = browser(multiQuiz)
  partial.select(['a'])
  partial.check.dispatchEvent(new (partial.quiz.ownerDocument.defaultView.Event)('click', { bubbles: true }))
  assert.match(partial.verdict().textContent, /^不对。/)
  assert.equal(partial.verdict().className, 'verdict no')

  const extra = browser(multiQuiz)
  extra.select(['a', 'b', 'c'])
  extra.check.dispatchEvent(new (extra.quiz.ownerDocument.defaultView.Event)('click', { bubbles: true }))
  assert.match(extra.verdict().textContent, /^不对。/)
})

test('多选：一个都没勾时提示先选，不判对错', () => {
  const { quiz, check, verdict } = browser(multiQuiz)
  check.dispatchEvent(new (quiz.ownerDocument.defaultView.Event)('click', { bubbles: true }))
  assert.equal(verdict().textContent, '先选一个再判。')
  assert.equal(verdict().className, 'verdict')
})

test('既没有 radio 也没有 checkbox：改成「课堂里提交，本地不判卷」', () => {
  const markup = `<div class="quiz" data-question-id="q-3" data-explain="解释。">
  <p class="q">写一句你的判断。</p>
  <textarea name="q3"></textarea>
  <button type="button">判卷</button><p class="verdict"></p>
</div>`
  const { quiz, check, verdict } = browser(markup)
  check.dispatchEvent(new (quiz.ownerDocument.defaultView.Event)('click', { bubbles: true }))
  assert.equal(verdict().textContent, '这道题在课堂里提交，本地不判卷。')
})

test('单选行为不变：正确项 data-ok=1、错误项可用 data-why 解释', () => {
  const markup = `<div class="quiz" data-question-id="q-1" data-explain="因为约束不同。">
  <p class="q">哪一个方案满足约束？</p>
  <label><input type="radio" name="q1" value="a" data-why="它不满足第二条。">方案甲</label>
  <label><input type="radio" name="q1" value="b" data-ok="1">方案乙</label>
  <button type="button">判卷</button><p class="verdict"></p>
</div>`
  const right = browser(markup)
  right.select(['b'])
  right.check.dispatchEvent(new (right.quiz.ownerDocument.defaultView.Event)('click', { bubbles: true }))
  assert.match(right.verdict().textContent, /^对。/)
  assert.match(right.verdict().textContent, /因为约束不同/)

  const wrong = browser(markup)
  wrong.select(['a'])
  wrong.check.dispatchEvent(new (wrong.quiz.ownerDocument.defaultView.Event)('click', { bubbles: true }))
  assert.match(wrong.verdict().textContent, /^不对。/)
  assert.match(wrong.verdict().textContent, /它不满足第二条/)
})
