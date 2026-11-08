import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { readingBridge } from '../../lib/classroom/reading-bridge.js'

/* 课堂顶栏覆盖在 iframe 上时，宿主通过 nonce 桥下发顶栏高度；课程页桥在 body 最前面
 * 插一段透明空白。这里用假 DOM 跑真实的 readingBridge，钉住四件事：
 * 1) 收到 teach:top-inset 后插入 div[data-teach-host-inset]，高度就是 px；
 * 2) 已在中段阅读时改高度，用 scrollBy 保住当前内容位置；顶部保持 0；
 * 3) 重复同高度不重复插入、不重复滚动；
 * 4) 当前小节判定按顶栏下沿算，不把顶栏下面的内容误判成当前小节。 */

function makeHarness() {
  const listeners = {}
  const sends = []
  const spacer = {
    tagName: 'DIV',
    style: { cssText: '', height: '' },
    parentNode: null,
    attrs: {},
    setAttribute(name) { this.attrs[name] = '' }
  }
  const body = {
    firstChild: null,
    insertBefore(node, before) {
      node.parentNode = body
      if (before === this.firstChild) this.firstChild = node
      else this.firstChild = node
    }
  }
  const section = {
    id: 's1',
    offsetHeight: 100,
    getBoundingClientRect: () => ({ top: 100 })
  }
  const document = {
    readyState: 'complete',
    documentElement: { scrollHeight: 1000, style: {} },
    body,
    visibilityState: 'visible',
    querySelectorAll: () => [section],
    getElementById: () => null,
    createElement: () => spacer,
    addEventListener: (type, listener) => { listeners['document:' + type] = listener },
    hasFocus: () => true
  }
  const window = {
    innerHeight: 600,
    scrollY: 0,
    addEventListener: (type, listener) => { listeners[type] = listener },
    removeEventListener: () => {},
    scrollTo: (x, y) => { window.scrollY = y },
    scrollBy: (x, y) => { window.scrollY += y }
  }
  const parent = {}
  const sandbox = {
    boot: { tracking: true, nonce: 'n1', reading: null },
    send: (type, payload) => sends.push({ type, payload }),
    parent,
    window,
    document,
    innerHeight: 600,
    requestAnimationFrame: (callback) => { callback(); callback() },
    setTimeout: () => 0,
    clearTimeout: () => {},
    Date,
    Math,
    Number,
    String,
    Array
  }
  vm.runInNewContext('(' + readingBridge.toString() + ')()', sandbox)
  const message = (data) => listeners.message({ source: parent, data })
  return { body, spacer, section, window, sends, message, listeners }
}

const inset = (harness, px) => harness.message({ source: 'teach-host', type: 'teach:top-inset', nonce: 'n1', px })

test('收到顶栏高度后插入透明空白，顶部保持 0，不遮住课程页第一行', () => {
  const harness = makeHarness()
  inset(harness, 120)
  assert.equal(harness.body.firstChild, harness.spacer, '空白块要插在 body 最前面')
  assert.equal(harness.spacer.style.height, '120px')
  assert.equal(harness.spacer.attrs['data-teach-host-inset'], '')
  assert.equal(harness.window.scrollY, 0, '首屏不能因为插入空白而滚走')
})

test('已在中段阅读时改高度：scrollBy 保住内容位置；同高度不重复滚动', () => {
  const harness = makeHarness()
  inset(harness, 120)
  harness.window.scrollY = 300
  inset(harness, 160)
  assert.equal(harness.spacer.style.height, '160px')
  assert.equal(harness.window.scrollY, 340, '高度增加 40，滚动位置也要 +40')
  inset(harness, 160)
  assert.equal(harness.window.scrollY, 340, '同高度不应再滚动')
})

test('当前小节按顶栏下沿判定：顶栏下的第一节不会被误判', async () => {
  const harness = makeHarness()
  inset(harness, 160)
  harness.message({ source: 'teach-host', type: 'teach:visibility', nonce: 'n1', active: true })
  // 假小节 top=100：inset=160 时阈值 240，算当前；inset=0 时阈值 80，不算。
  harness.listeners.wheel({ isTrusted: true })
  const preview = harness.sends.filter((entry) => entry.type === 'reading-preview').at(-1)
  assert.equal(preview.payload.position.section, 's1')
  // 切回没有顶栏 inset 的宿主：同一小节不再算当前。
  harness.window.scrollY = 0
  inset(harness, 0)
  await new Promise((resolve) => setTimeout(resolve, 150))
  harness.listeners.wheel({ isTrusted: true })
  const noInset = harness.sends.filter((entry) => entry.type === 'reading-preview').at(-1)
  assert.equal(noInset.payload.position.section, '')
})
