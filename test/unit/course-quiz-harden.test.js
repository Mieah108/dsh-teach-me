import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { parseHTML } from 'linkedom'

const course = fs.readFileSync(new URL('../../templates/course.js', import.meta.url), 'utf8')

/** 用真实 DOM 跑 course.js：这里只关心判卷结论与可访问性补齐。 */
function browser(markup) {
  const { window, document } = parseHTML('<!doctype html><html><body>' + markup + '</body></html>')
  Object.defineProperty(document, 'readyState', { value: 'complete' })
  const navigator = { clipboard: { writeText: () => Promise.resolve() } }
  const context = vm.createContext({ window, document, navigator, console, Map, Promise, Date, setTimeout: () => 1, clearTimeout: () => {} })
  vm.runInContext(course, context)
  return { window, document, quiz: document.querySelector('.quiz') }
}

const page = `<div class="shell"><aside class="sidenav"><nav><a href="#s1">一</a></nav></aside>
<main class="wrap"><div class="quiz" data-question-id="q-1" data-explain="解释。">
  <p class="q"><span class="tag">自测</span>题干？</p>
  <label><input type="radio" name="q1" value="a"> 选项一</label>
  <label><input type="radio" name="q1" value="b" data-ok="1"> 选项二</label>
  <button type="button">判卷</button><p class="verdict"></p>
</div></main></div>`

const pick = (quiz, value) => {
  const input = quiz.querySelector('input[value="' + value + '"]')
  input.checked = true
  input.setAttribute('checked', '')
  return input
}
const fire = (window, input) => input.dispatchEvent(new window.Event('change', { bubbles: true }))
const click = (window, el) => el.dispatchEvent(new window.Event('click', { bubbles: true }))

test('判卷结论是 live region：role=status、polite、atomic', () => {
  const { quiz } = browser(page)
  const out = quiz.querySelector('.verdict')
  assert.equal(out.getAttribute('role'), 'status')
  assert.equal(out.getAttribute('aria-live'), 'polite')
  assert.equal(out.getAttribute('aria-atomic'), 'true')
})

test('选项被包进 radiogroup，题干成为组名', () => {
  const { quiz } = browser(page)
  const group = quiz.querySelector('[role="radiogroup"]')
  assert.ok(group, '应当补齐 radiogroup')
  assert.equal(group.getAttribute('aria-labelledby'), quiz.querySelector('.q').id)
  assert.equal(group.querySelectorAll('input[type=radio]').length, 2)
  assert.ok(quiz.querySelector('.q').id)
})

test('主内容与跳转链接自动补齐', () => {
  const { document } = browser(page)
  const main = document.querySelector('main')
  assert.equal(main.id, 'main')
  const skip = document.querySelector('.skip-link')
  assert.ok(skip, '应当有跳转链接')
  assert.equal(skip.getAttribute('href'), '#main')
  assert.equal(document.querySelector('.sidenav nav').getAttribute('aria-label'), '本课路线')
})

test('改选项后旧结论作废，重新判卷才给新结论', () => {
  const { window, quiz } = browser(page)
  const out = quiz.querySelector('.verdict')
  const btn = quiz.querySelector('button')

  pick(quiz, 'b')
  click(window, btn)
  assert.match(out.textContent, /^对。/)
  assert.equal(out.className, 'verdict ok')
  assert.equal(quiz.getAttribute('data-teach-judged'), '1')
  assert.equal(btn.textContent, '重新判卷')

  const wrong = pick(quiz, 'a')
  fire(window, wrong)
  assert.equal(out.textContent, '选项已更改，请重新判卷。')
  assert.equal(out.className, 'verdict is-stale')
  assert.equal(quiz.getAttribute('data-teach-judged'), null)

  click(window, btn)
  assert.match(out.textContent, /^不对。/)
  assert.equal(out.className, 'verdict no')
})

test('还没判过时改选项不写过期文案', () => {
  const { window, quiz } = browser(page)
  const out = quiz.querySelector('.verdict')
  fire(window, pick(quiz, 'a'))
  assert.equal(out.textContent, '')
  assert.equal(out.className, 'verdict')
})
