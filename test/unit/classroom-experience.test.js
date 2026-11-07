import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { parseHTML } from 'linkedom'
import { injectClassroomHtml } from '../../lib/classroom/assets.js'
import { inlineLessonAssets, buildOffline } from '../../lib/classroom/offline.js'
import { publishLesson, readArchiveState } from '../../lib/archive/operations.js'

const course = fs.readFileSync(new URL('../../templates/course.js', import.meta.url), 'utf8')
const quizMarkup = `<div class="quiz" data-question-id="q1" data-explain="解释：因为约束不同。">
  <p class="q">哪一个方案满足约束？</p>
  <label><input type="radio" name="answer" value="a">方案甲</label>
  <label><input type="radio" name="answer" value="b" data-ok="1">方案乙</label>
  <button type="button">判卷</button><p class="verdict"></p>
  <details data-teach-hint><summary>提示</summary>先看约束。</details>
  <details data-teach-solution><summary>解答</summary>方案乙。</details>
</div>`

function browser(markup = '', { classroom = false, clipboard } = {}) {
  let html = '<!doctype html><html><head><title>机制课</title></head><body>' + markup + '</body></html>'
  if (classroom) html = injectClassroomHtml(html, { baseHref: '/', bootstrap: { nonce: 'n', lessonId: 'l1', revision: 2, questions: [{ id: 'q1', revision: 3 }] } })
  const { window, document } = parseHTML(html)
  Object.defineProperty(document, 'readyState', { value: 'complete' })
  window.getComputedStyle = (element) => ({ display: element.style?.display || '', visibility: element.style?.visibility || '' })
  window.HTMLTextAreaElement.prototype.select = () => {}
  window.HTMLTextAreaElement.prototype.setSelectionRange = () => {}
  const copied = []
  const navigator = { clipboard: { writeText: clipboard || ((text) => { copied.push(text); return Promise.resolve() }) } }
  const posted = []
  const context = vm.createContext({ window, document, navigator, parent: { postMessage: (message) => posted.push(message) }, console, Map, Promise, Date, setTimeout: () => 1, clearTimeout: () => {} })
  vm.runInContext(course, context)
  if (classroom) vm.runInContext(document.getElementById('teach-classroom-bridge').textContent, context)
  const click = (element) => element.dispatchEvent(new window.Event('click', { bubbles: true }))
  const ready = () => document.dispatchEvent(new window.CustomEvent('teach:components-ready'))
  return { window, document, copied, posted, click, ready }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('真实 DOM：空选项不揭晓，看到解析后保留解答使用标记', () => {
  const { document, click, window } = browser(quizMarkup)
  const quiz = document.querySelector('.quiz')
  const check = quiz.querySelector('button')
  click(check)
  assert.equal(quiz.querySelector('.verdict').textContent, '先选一个再判。')
  assert.equal(quiz.getAttribute('data-teach-showed-solution'), null)
  quiz.querySelector('input[value="a"]').setAttribute('checked', '')
  click(check)
  assert.match(quiz.querySelector('.verdict').textContent, /不对。解释/)
  assert.equal(quiz.getAttribute('data-teach-showed-solution'), '1')
  const hint = quiz.querySelector('[data-teach-hint]')
  hint.open = true
  hint.dispatchEvent(new window.Event('toggle', { bubbles: true }))
  assert.equal(quiz.getAttribute('data-teach-hints-used'), '1')
  quiz.querySelector('input[value="a"]').removeAttribute('checked')
  quiz.querySelector('input[value="b"]').setAttribute('checked', '')
  click(check)
  assert.equal(quiz.getAttribute('data-teach-showed-solution'), '1')
})

test('真实 DOM：异步挂载后显式就绪可重复调用，不重复挂复制或课堂提交按钮', () => {
  const { document, ready } = browser('', { classroom: true })
  document.body.insertAdjacentHTML('beforeend', quizMarkup)
  ready()
  ready()
  assert.equal(document.querySelectorAll('[data-teach-copy-context]').length, 1)
  assert.equal(document.querySelectorAll('[data-teach-submit]').length, 1)
})

test('真实 DOM：页面自己写的「提交到课堂」被桥认领，一道题只剩一个提交按钮，且并进动作行', () => {
  // 真实事故复现（Signal-processing 0001 课）：作者手写了一只提交按钮，桥又补一只，页面上出现两个。
  const markup = `<div class="quiz" data-question-id="q1" data-explain="解释。" data-scope="口径：两三句话。">
  <p class="q">用两三句话说清这件事。</p>
  <textarea name="q1" rows="3"></textarea>
  <button type="button">提交到课堂</button>
</div>`
  const { document } = browser(markup, { classroom: true })
  const quiz = document.querySelector('.quiz')
  const submits = quiz.querySelectorAll('[data-teach-submit]')
  assert.equal(submits.length, 1, '一道题只能有一个提交按钮')
  assert.equal(submits[0].getAttribute('data-teach-adopted'), '1', '手写按钮应被认领，而不是再补一只')
  assert.equal(submits[0].textContent.trim(), '提交到课堂')
  const actions = quiz.querySelector('.teach-context-actions')
  assert.ok(actions !== null, 'course.js 的动作行存在')
  assert.ok(actions.contains(submits[0]), '提交按钮要并进动作行，和「复制当前状态」同一处')
  assert.ok(actions.querySelector('.teach-context-copy') !== null, '复制当前状态仍在同一行')
  assert.equal(actions.firstElementChild, submits[0], '主操作（提交）排在复制之前')
})

test('真实 DOM：没有手写按钮时仍自动补一只（行为不变）', () => {
  const markup = `<div class="quiz" data-question-id="q1" data-explain="解释。" data-scope="口径：x">
  <p class="q">选一个。</p>
  <label><input type="radio" name="a" value="a" data-ok="1">甲</label>
  <p class="verdict"></p>
</div>`
  const { document } = browser(markup, { classroom: true })
  const quiz = document.querySelector('.quiz')
  assert.equal(quiz.querySelectorAll('[data-teach-submit]').length, 1)
  assert.equal(quiz.querySelectorAll('[data-teach-auto]').length, 1, '自动补的仍带 data-teach-auto')
})

test('真实 DOM：作者自己挂了 data-teach-submit 时桥不重复挂、也不认领第二只', () => {
  const markup = `<div class="quiz" data-question-id="q1" data-explain="解释。" data-scope="口径：x">
  <p class="q">选一个。</p>
  <label><input type="radio" name="a" value="a" data-ok="1">甲</label>
  <div class="teach-context-actions"><button type="button" data-teach-submit data-question-id="q1">交卷</button></div>
</div>`
  const { document } = browser(markup, { classroom: true })
  const submits = document.querySelectorAll('[data-teach-submit]')
  assert.equal(submits.length, 1)
  assert.equal(submits[0].textContent.trim(), '交卷', '作者的文案不被改写')
})

test('真实 DOM：复制仅包含显式当前状态，不泄露隐藏背面、配置或标准答案', async () => {
  const markup = `<div data-teach-context="状态实验" data-teach-hints-used="true" data-teach-showed-solution="true">
    <script type="application/json">{"back":"尚未揭晓的秘密答案"}</script>
    <p data-teach-state>当前卡 1/3，正面。</p>
    <p data-teach-state hidden>隐藏状态答案</p>
    <p hidden>另一份秘密</p>
    <input aria-label="参数" value="8"><input type="hidden" value="标准答案">
  </div>`
  const { document, copied, click } = browser(markup)
  click(document.querySelector('[data-teach-copy-context]'))
  await flush()
  assert.match(copied[0], /当前卡 1\/3，正面/)
  assert.match(copied[0], /参数：8/)
  assert.match(copied[0], /活动：状态实验/)
  assert.match(copied[0], /已使用提示\n已看过解答/)
  assert.doesNotMatch(copied[0], /秘密|隐藏状态|标准答案|application\/json|data-ok/)
  assert.match(copied[0], /不是正式提交/)
})

test('真实 DOM：剪贴板不可用时显示可手工选择的快照，不使复制按钮失效', async () => {
  const { document, window, click } = browser('<div data-teach-context><p data-teach-state>cycle 3</p></div>', { clipboard: () => Promise.reject(new Error('denied')) })
  document.execCommand = () => false
  document.createRange = () => ({ selectNodeContents: () => {} })
  window.getSelection = () => ({ removeAllRanges: () => {}, addRange: () => {} })
  click(document.querySelector('[data-teach-copy-context]'))
  await flush()
  assert.match(document.querySelector('.md-src pre').textContent, /cycle 3/)
  assert.equal(document.querySelector('[data-teach-copy-context]').disabled, false)
})

test('真实 DOM：正式提交拒绝空答，携带实际揭晓标记，成功和失败共用一条反馈', async () => {
  const { document, window, click } = browser(quizMarkup, { classroom: true })
  const quiz = document.querySelector('.quiz')
  const button = quiz.querySelector('[data-teach-submit]')
  const submitted = []
  window.teachClassroom.submit = (...args) => { submitted.push(args); return Promise.resolve({ verdict: 'passed' }) }
  click(button)
  assert.equal(submitted.length, 0)
  assert.match(quiz.querySelector('.teach-classroom-result').textContent, /请先作答/)
  quiz.querySelector('input[value="b"]').setAttribute('checked', '')
  click(quiz.querySelector('button'))
  quiz.setAttribute('data-teach-hints-used', '1')
  click(button)
  await flush()
  assert.equal(submitted[0][0], 'q1')
  assert.equal(submitted[0][1], 'b')
  assert.deepEqual({ ...submitted[0][2] }, { hintsUsed: true, showedSolution: true })
  assert.match(quiz.querySelector('.teach-classroom-result').textContent, /评估通过/)
  // 错误回调透出服务端 message（例如「题目已改版，刷新课堂后再提交」）
  window.teachClassroom.submit = () => Promise.reject(new Error('题目已改版，刷新课堂后再提交'))
  click(button)
  await flush()
  assert.equal(quiz.querySelectorAll('.teach-classroom-result').length, 1)
  assert.match(quiz.querySelector('.teach-classroom-result').textContent, /题目已改版，刷新课堂后再提交/)
  assert.equal(button.disabled, false)
  // 只有没有 message 时才用兜底文案
  window.teachClassroom.submit = () => Promise.reject({ code: 'rpc-failed' })
  click(button)
  await flush()
  assert.match(quiz.querySelector('.teach-classroom-result').textContent, /请重试/)
})

test('组件静态资源与poster可离线内联，发布后同长度改写仍拒绝导出', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-offline-components-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'assets/components'), { recursive: true })
  fs.mkdirSync(path.join(root, 'lessons'))
  fs.writeFileSync(path.join(root, 'assets/components/teach-components.js'), 'window.component=true;')
  fs.writeFileSync(path.join(root, 'assets/components/teach-components.css'), '.flash{color:red}')
  fs.writeFileSync(path.join(root, 'assets/poster.png'), 'png')
  const html = '<html><link rel="stylesheet" href="../assets/components/teach-components.css"><script src="../assets/components/teach-components.js" defer></script><video poster="../assets/poster.png"></video></html>'
  fs.writeFileSync(path.join(root, 'lessons/one.html'), html)
  publishLesson(root, { lessonId: 'l1', title: '组件课', path: 'lessons/one.html' })
  const state = readArchiveState(root)
  const lesson = state.lessons.l1
  const offline = inlineLessonAssets(html, root, lesson)
  assert.match(offline, /src="data:text\/javascript|src="data:application\/javascript/)
  assert.match(offline, /href="data:text\/css/)
  assert.match(offline, /poster="data:image\/png/)
  assert.doesNotMatch(offline, /\.\.\/assets/)
  const example = '<script type="application/json">{"example":"<img src=\"../assets/poster.png\">"}</script><!-- <img src="../assets/poster.png"> -->'
  assert.equal(inlineLessonAssets(example, root, lesson), example)
  for (const tag of ['textarea', 'style', 'title', 'xmp']) {
    const raw = '<' + tag + '><img src="../assets/poster.png"><script src="../assets/components/teach-components.js"></script></' + tag + '>'
    assert.equal(inlineLessonAssets(raw, root, lesson), raw, tag + ' content is text, not resource tags')
  }
  const file = path.join(root, 'assets/components/teach-components.js')
  fs.writeFileSync(file, 'window.component=9999;')
  assert.throws(() => buildOffline(root, state, lesson), /asset-hash-mismatch/)
})
