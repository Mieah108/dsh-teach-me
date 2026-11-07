import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { injectClassroomHtml } from '../../lib/classroom/assets.js'

function bridge() {
  const messages = []
  const listeners = {}
  const created = []
  const boot = { nonce: 'nonce', lessonId: 'l1', revision: 1, questions: [{ id: 'q1', revision: 3 }] }
  const html = injectClassroomHtml('<html><body></body></html>', { baseHref: '/', bootstrap: boot })
  const script = /<script id="teach-classroom-bridge">([\s\S]*?)<\/script>/.exec(html)[1]
  const document = {
    readyState: 'loading',
    getElementById: () => ({ textContent: JSON.stringify(boot) }),
    addEventListener: (type, handler) => { listeners[type] = handler },
    createElement: (tag) => {
      const node = { tag, textContent: '', className: '', style: {}, setAttribute() {} }
      created.push(node)
      return node
    },
    querySelectorAll: () => []
  }
  const window = { addEventListener: () => {} }
  vm.runInNewContext(script, { window, document, parent: { postMessage: (message) => messages.push(message) }, Map, Promise, Date })
  return { window, messages, listeners, created }
}

function quizStub({ radio = null, boxes = [], select = null, free = null } = {}) {
  return {
    querySelector: (selector) => {
      if (selector.includes('radio')) return radio
      if (selector.includes('select')) return select
      return free
    },
    querySelectorAll: (selector) => (selector.includes('checkbox') ? boxes : [])
  }
}

/** 点一次提交按钮，返回桥实际交出去的答案。 */
async function submitAnswer(quiz) {
  const { window, listeners, created } = bridge()
  let answer
  window.teachClassroom.submit = (_id, raw) => { answer = raw; return Promise.reject(new Error('test')) }
  const line = { textContent: '', className: '', setAttribute() {} }
  let feedback = null
  const holder = {
    querySelector: () => feedback,
    insertBefore: (node) => { feedback = node }
  }
  const button = {
    disabled: false,
    parentNode: holder,
    closest: () => quiz,
    getAttribute: () => 'q1',
    setAttribute() {}
  }
  listeners.click({ target: { closest: () => button } })
  await Promise.resolve()
  await Promise.resolve()
  return { answer, created, line, feedback }
}

test('桥提交携带实际打开时的题目 revision 与提示标记', () => {
  const { window, messages } = bridge()
  window.teachClassroom.submit('q1', 'b', { hintsUsed: true, showedSolution: true })
  const submit = messages.at(-1)
  assert.equal(submit.questionRevision, 3)
  assert.equal(submit.hintsUsed, true)
  assert.equal(submit.showedSolution, true)
})

test('radio 未设 value 时使用 data-value，不提交浏览器默认的 on', async () => {
  const { window, listeners } = bridge()
  let answer
  window.teachClassroom.submit = (_id, raw) => { answer = raw; return Promise.reject(new Error('test')) }
  const quiz = { querySelector: () => ({ value: 'on', id: '', getAttribute: (key) => key === 'data-value' ? 'b' : null }) }
  const button = { closest: () => quiz, getAttribute: () => 'q1' }
  listeners.click({ target: { closest: () => button } })
  await Promise.resolve()
  assert.equal(answer, 'b')
  assert.equal(button.disabled, false)
})

test('取值协议：checkbox 全选中项用英文逗号连接', async () => {
  const checked = (value) => ({ getAttribute: (key) => (key === 'value' ? value : null) })
  const { answer } = await submitAnswer(quizStub({ boxes: [checked('a'), checked('c')] }))
  assert.equal(answer, 'a,c')
})

test('取值协议：select 与 number 输入取 value', async () => {
  const viaSelect = await submitAnswer(quizStub({ select: { value: 'b' } }))
  assert.equal(viaSelect.answer, 'b')
  const viaNumber = await submitAnswer(quizStub({ free: { value: '42' } }))
  assert.equal(viaNumber.answer, '42')
})

test('取值协议：空白答案仍按 trim 判定为空，不提交', async () => {
  const { answer, feedback } = await submitAnswer(quizStub({ free: { value: '   ' } }))
  assert.equal(answer, undefined)
  assert.match(feedback.textContent, /请先作答/)
})

test('随包选择题模板为每个 radio 提供与档案选项匹配的 value', () => {
  for (const name of ['lesson.html', 'FORMATS.md']) {
    const text = fs.readFileSync(new URL('../../templates/' + name, import.meta.url), 'utf8')
    const radios = [...text.matchAll(/<input\b[^>]*type="radio"[^>]*>/g)]
    assert.equal(radios.length, 3)
    assert.deepEqual(radios.map(([tag]) => /value="([^"]+)"/.exec(tag)?.[1]), ['a', 'b', 'c'])
  }
})
