import assert from 'node:assert/strict'
import test from 'node:test'

/* 设置页（TeachSettingsSection）是纯 client.js 组件：没有构建产物，所以用最小
 * 的 React 桩把它渲染成元素树，钉住这几件会真正伤到用户的事：
 * 1) 每个控件都有可访问名与说明，且 label.htmlFor 与控件 id 对得上；
 * 2) 焦点环来自样式表而不是 outline:none（宿主里键盘焦点必须看得见）；
 * 3) 不可写 / 未加载时控件禁用，并且在页面上说清原因；
 * 4) 软性上限的解析不悄悄改写用户输入（12.5、5、601 都算无效）。 */

function fakeReact() {
  const noop = () => undefined
  return {
    createElement: (type, props, children) => ({ type, props: props || {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: noop,
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    Fragment: 'fragment'
  }
}

let clientExports
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      clientExports = entry.factory((name) => {
        assert.equal(name, 'react')
        return fakeReact()
      })
    }
  }
}

async function loadClient() {
  if (clientExports === undefined) await import('../../client.js')
  return clientExports
}

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.children, visit)
}

function collect(tree, predicate) {
  const hits = []
  walk(tree, (node) => {
    if (predicate(node)) hits.push(node)
  })
  return hits
}

function render(snapshot) {
  const client = clientExports
  return client.TeachSettingsSection({
    t: (key) => key,
    useConfig: () => snapshot,
    write: () => Promise.resolve(true)
  })
}

const ready = { status: 'ready', writable: true, value: { animation: { root: '/tmp/anim', softLimitSeconds: 120, missing: 'skip', staging: true } } }

test('软性上限解析：只有 10–600 的整数秒会写回', async () => {
  const { settingsLimits } = await loadClient()
  assert.deepEqual(settingsLimits.parse(''), { kind: 'empty' })
  assert.deepEqual(settingsLimits.parse('   '), { kind: 'empty' })
  assert.deepEqual(settingsLimits.parse('120'), { kind: 'ok', value: 120 })
  assert.deepEqual(settingsLimits.parse('10'), { kind: 'ok', value: 10 })
  assert.deepEqual(settingsLimits.parse('600'), { kind: 'ok', value: 600 })
  for (const bad of ['5', '601', '12.5', 'abc', '-120']) assert.deepEqual(settingsLimits.parse(bad), { kind: 'invalid' }, bad)
  assert.equal(settingsLimits.minSeconds, 10)
  assert.equal(settingsLimits.maxSeconds, 600)
})

test('渲染：四个控件都有名字、说明与对齐的 id', async () => {
  await loadClient()
  const tree = render(ready)
  const [section] = collect(tree, (n) => n.type === 'section')
  assert.equal(section.props.id, 'teach-me-settings')
  assert.equal(section.props['aria-labelledby'], 'teach-me-settings-title')
  assert.ok(collect(tree, (n) => n.type === 'h2' && n.props.id === 'teach-me-settings-title').length === 1)

  // 样式已收敛到作用域样式表，类名允许带修饰符（tsm-control tsm-control--mono）。
  const hasClass = (node, name) => typeof node.props.className === 'string' && node.props.className.split(' ').includes(name)
  const controls = collect(tree, (n) => hasClass(n, 'tsm-control') || hasClass(n, 'tsm-check'))
  assert.equal(controls.length, 4)
  for (const control of controls) assert.equal(control.props.disabled, false, control.props.id)

  const byId = new Map(controls.map((control) => [control.props.id, control]))
  assert.deepEqual([...byId.keys()].sort(), ['teach-me-animation-missing', 'teach-me-animation-root', 'teach-me-animation-staging', 'teach-me-soft-limit'])

  const labels = collect(tree, (n) => n.type === 'label')
  assert.equal(labels.length, 4)
  assert.deepEqual(labels.map((label) => label.props.htmlFor).sort(), [...byId.keys()].sort())

  // 说明必须真的指到存在的元素上，否则 aria-describedby 等于没有。
  const ids = new Set(collect(tree, (n) => typeof n.props.id === 'string').map((n) => n.props.id))
  for (const control of controls) {
    const describedBy = control.props['aria-describedby']
    assert.equal(typeof describedBy, 'string', control.props.id)
    for (const id of describedBy.split(' ')) assert.ok(ids.has(id), control.props.id + ' -> ' + id)
  }
})

test('渲染：焦点环与命中高度写在样式表里，而不是 outline:none', async () => {
  await loadClient()
  const tree = render(ready)
  const [style] = collect(tree, (n) => n.type === 'style')
  const css = style.props.dangerouslySetInnerHTML.__html
  assert.match(css, /:focus-visible/)
  assert.match(css, /--dsw-focus-ring-color/)
  assert.match(css, /pointer:coarse/)
  assert.match(css, /prefers-reduced-motion/)
  const inlineOutlines = collect(tree, (n) => n.props && n.props.style && n.props.style.outline === 'none')
  assert.deepEqual(inlineOutlines, [])
})

test('配置没读完就不下结论：不印「不做动画」，也不画字段组', async () => {
  await loadClient()
  for (const snapshot of [
    { status: 'loading' },
    { status: 'unavailable', writable: false, value: {} }
  ]) {
    const tree = render(snapshot)
    const paragraphs = collect(tree, (n) => n.type === 'p').map((node) => node.children)
    // 读不到配置时说「这一版不做动画」是在编事实
    assert.equal(paragraphs.includes('stateOff'), false, snapshot.status)
    assert.equal(paragraphs.includes('stateOn'), false, snapshot.status)
    // 没配置就不画禁用控件：默认值会被看成已选值
    assert.deepEqual(collect(tree, (n) => typeof n.props.className === 'string' && n.props.className === 'tsm-group'), [])
  }
})

test('不可写与未加载：控件禁用并说明原因', async () => {
  await loadClient()
  const unavailable = render({ status: 'unavailable', writable: false, value: {} })
  for (const control of collect(unavailable, (n) => typeof n.props.className === 'string' && /tsm-(control|check)/.test(n.props.className))) {
    assert.equal(control.props.disabled, true, control.props.id)
  }
  const paragraphs = collect(unavailable, (n) => n.type === 'p')
  assert.ok(paragraphs.some((node) => node.children === 'unavailable'), '页面上要说明为什么改不了')

  const readonly = render({ status: 'ready', writable: false, value: { animation: {} } })
  assert.ok(collect(readonly, (n) => n.type === 'p' && n.children === 'readonly').length === 1)
})

test('只有一个读屏活区，字段旁的保存结果不重复播报', async () => {
  await loadClient()
  const tree = render(ready)
  const live = collect(tree, (n) => n.props.role === 'status' && n.props['aria-live'] === 'polite')
  assert.equal(live.length, 1)
  assert.match(live[0].props.className, /tsm-sr/)
  assert.deepEqual(collect(tree, (n) => n.props['aria-live'] === 'polite' && n !== live[0]), [])
})

test('开关行：方框在名字左边紧挨着，不推到行尾（V03）', async () => {
  await loadClient()
  const tree = render(ready)
  const [row] = collect(tree, (n) => typeof n.props.className === 'string' && n.props.className === 'tsm-switchrow')
  assert.ok(row !== undefined, '缺开关行')
  const kinds = row.children.map((node) => {
    if (node && node.type === 'input') return 'input'
    if (node && typeof node.props.className === 'string' && node.props.className === 'tsm-labelrow') return 'labelrow'
    return String(node && node.type)
  })
  assert.deepEqual(kinds, ['input', 'labelrow'], '方框要排在名字前面')
  // 行不再把控件推到右端：间距由样式表统一给 8px
  assert.equal(row.props.className, 'tsm-switchrow')
})

test('勾选框跟随配置：未显式关闭时默认勾上', async () => {
  await loadClient()
  const on = collect(render(ready), (n) => n.props.className === 'tsm-check')
  assert.equal(on[0].props.checked, true)
  const off = collect(render({ status: 'ready', writable: true, value: { animation: { staging: false } } }), (n) => n.props.className === 'tsm-check')
  assert.equal(off[0].props.checked, false)
})

test('保存值本身就超出范围时：标成无效并说明原因', async () => {
  await loadClient()
  const tree = render({ status: 'ready', writable: true, value: { animation: { softLimitSeconds: 900 } } })
  const [input] = collect(tree, (n) => n.props.id === 'teach-me-soft-limit')
  assert.equal(input.props['aria-invalid'], 'true')
  assert.match(input.props['aria-describedby'], /teach-me-soft-limit-error/)
  const [error] = collect(tree, (n) => n.props.id === 'teach-me-soft-limit-error')
  assert.equal(error.children, 'invalidSaved')
})

test('范围外的数字在渲染时就标成无效，并把错误挂进说明', async () => {
  await loadClient()
  const tree = render({ status: 'ready', writable: true, value: { animation: { softLimitSeconds: 120 } } })
  const [input] = collect(tree, (n) => n.props.id === 'teach-me-soft-limit')
  assert.equal(input.props['aria-invalid'], 'false')
  assert.equal(input.props['aria-describedby'], 'teach-me-soft-limit-hint')
  assert.equal(input.props.min, 10)
  assert.equal(input.props.max, 600)
})
