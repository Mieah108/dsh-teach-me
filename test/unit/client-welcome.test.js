import assert from 'node:assert/strict'
import test from 'node:test'

/* 首次安装的欢迎页（client.js 的 TeachWelcome / TeachWelcomeBody / 判定函数）。
 *
 * 这里钉住三件会真正伤到用户的事：
 * 1) 「只出现一次」必须真的成立：关一次要写 welcome.seen=true，之后任何浏览器都不再出现；
 *    写回被拒时也不能每次刷新再来一遍（浏览器兜底标记）。
 * 2) 不该弹的时候一个像素都不出现：配置没读完、只读 profile、已经看过。
 * 3) 页面文案里必须写明「只会出现一次」，并指出恢复入口，中英一致。
 *
 * client.js 是浏览器单文件模块，这里用最小 React 桩把它装起来（useState/useEffect 带真状态与
 * 依赖比较，能测「点关闭 → 收起」）；primitives 用可变对象，方便验证「宿主没有 Modal 时跳过」。 */

const localStorageStub = () => {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size }
  }
}

/** 可变 primitives：测试会临时摘掉 Modal 验证降级路径。 */
const primitivesStub = { Modal: function Modal() {}, Button: function Button() {} }

let clientExports
globalThis.window = {
  localStorage: localStorageStub(),
  __ModuleLoader__: {
    load: (entry) => {
      clientExports = entry.factory((name) => {
        if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitivesStub
        assert.equal(name, 'react')
        return reactStub
      })
    }
  }
}

/** hook 单元按「调用顺序」存放：顺序在组件里是固定的，所以不需要组件身份。 */
let cells = []
let cursor = 0
let pendingEffects = []
let dirty = false

const reactStub = {
  createElement: (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  }),
  useState: (initial) => {
    const index = cursor++
    if (!(index in cells)) cells[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    const cell = cells[index]
    return [cell.value, (next) => {
      const value = typeof next === 'function' ? next(cell.value) : next
      if (value === cell.value) return
      cell.value = value
      dirty = true
    }]
  },
  useEffect: (effect, deps) => {
    const index = cursor++
    if (!(index in cells)) cells[index] = { kind: 'effect', deps: undefined }
    const cell = cells[index]
    const changed = cell.deps === undefined || !Array.isArray(deps) || cell.deps.length !== deps.length || deps.some((dep, i) => !Object.is(dep, cell.deps[i]))
    if (!changed) return
    cell.deps = Array.isArray(deps) ? [...deps] : undefined
    pendingEffects.push(effect)
  },
  useRef: (initial) => {
    const index = cursor++
    if (!(index in cells)) cells[index] = { current: initial }
    return cells[index]
  },
  useCallback: (fn) => { cursor += 1; return fn },
  useId: () => ':r' + cursor++ + ':',
  Fragment: 'fragment'
}

/** 渲染一轮到稳定：跑队列里的 effect，若它们改了 state 再画一遍（与 React 的提交顺序一致）。 */
function draw(client, snapshot, options) {
  for (let pass = 0; pass < 4; pass += 1) {
    cursor = 0
    pendingEffects = []
    dirty = false
    const tree = client.TeachWelcome({
      t: (key) => key,
      useConfig: (selector) => selector(snapshot),
      write: options.write || (() => Promise.resolve(true))
    })
    for (const effect of pendingEffects) effect()
    if (!dirty) return tree
  }
  throw new Error('渲染没有收敛（effect 里反复改 state）')
}

/** 从头挂载：清空 hook 单元。 */
function mount(client, snapshot, options = {}) {
  cells = []
  return draw(client, snapshot, options)
}

/** 保持 hook 单元、只重置读取位置：模拟一次重渲染。 */
function redraw(client, snapshot, options = {}) {
  return draw(client, snapshot, options)
}

async function loadClient() {
  if (clientExports === undefined) await import('../../client.js')
  return clientExports
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function collect(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const item of node) collect(item, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  collect(node.children, visit)
}

const ready = (welcome) => ({ status: 'ready', writable: true, value: welcome === undefined ? {} : { welcome } })

test('判定真值表：只有「读到了 + 可写 + 没看过」才点头', async () => {
  const { welcomeHelpers } = await loadClient()
  const decide = welcomeHelpers.decide
  assert.equal(decide(ready({ seen: false }), false), true)
  assert.equal(decide(ready(undefined), false), true, '字段缺失（从老版本升上来）按没看过处理')
  assert.equal(decide(ready({ seen: true }), false), false)
  assert.equal(decide(ready({ seen: false }), true), false, '浏览器兜底标记优先')
  assert.equal(decide({ status: 'loading' }, false), false)
  assert.equal(decide({ status: 'unavailable', writable: false, value: {} }, false), false)
  assert.equal(decide({ status: 'ready', writable: false, value: {} }, false), false, '只读 profile 没地方记住「已看过」')
  assert.equal(decide(undefined, false), false)
  assert.equal(decide(null, false), false)
})

test('该弹时挂出宿主 Modal：标题、关闭名、正文与页脚齐全', async () => {
  const client = await loadClient()
  window.localStorage.clear()
  const tree = mount(client, ready({ seen: false }))
  assert.equal(tree.type, primitivesStub.Modal, '外层必须复用宿主 Modal，不自己造弹层')
  assert.equal(tree.props.open, true)
  assert.equal(tree.props.title, 'welcomeTitle')
  assert.equal(tree.props.closeLabel, 'welcomeClose')
  assert.equal(tree.props.className, 'tsm-welcome-modal')
  assert.equal(tree.props.children.type, client.TeachWelcomeBody, '正文是独立组件（bench 也渲染它）')
  assert.equal(tree.props.footer.type, primitivesStub.Button)
  assert.equal(tree.props.footer.props['data-modal-autofocus'], true, '打开时焦点要落在主按钮上')
  assert.equal(tree.props.footer.children, 'welcomeStart')
})

test('不该弹的时候一个像素都不出现', async () => {
  const client = await loadClient()
  window.localStorage.clear()
  assert.equal(mount(client, ready({ seen: true })), null, '已经看过')
  assert.equal(mount(client, { status: 'loading' }), null, '配置还没读完')
  assert.equal(mount(client, { status: 'unavailable', writable: false, value: {} }), null, '设置行不在')
  assert.equal(mount(client, { status: 'ready', writable: false, value: {} }), null, '只读 profile')
})

test('宿主没有 Modal 时安静跳过，不抛错', async () => {
  const client = await loadClient()
  window.localStorage.clear()
  const Modal = primitivesStub.Modal
  delete primitivesStub.Modal
  try {
    assert.equal(mount(client, ready({ seen: false })), null)
  } finally {
    primitivesStub.Modal = Modal
  }
})

test('关闭 = 写 welcome.seen=true，并在本地立刻收起', async () => {
  const client = await loadClient()
  window.localStorage.clear()
  const writes = []
  const write = (path, value) => { writes.push({ path, value }); return Promise.resolve(true) }
  const tree = mount(client, ready({ seen: false }), { write })
  tree.props.footer.props.onClick()
  assert.deepEqual(writes, [{ path: ['welcome', 'seen'], value: true }])
  assert.equal(redraw(client, ready({ seen: false }), { write }), null, '写完之前也不该再画一帧欢迎页')
  assert.equal(window.localStorage.getItem(client.welcomeHelpers.markKey), null, '写回成功时不写浏览器兜底标记')
})

test('写回被拒时用浏览器标记兜底：本浏览器不再出现，换浏览器仍会再弹一次', async () => {
  const client = await loadClient()
  window.localStorage.clear()
  const tree = mount(client, ready({ seen: false }), { write: () => Promise.resolve(false) })
  tree.props.footer.props.onClick()
  await flush()
  assert.equal(window.localStorage.getItem(client.welcomeHelpers.markKey), '1', '写不进去也要记一笔，否则每次刷新都来一遍')
  assert.equal(mount(client, ready({ seen: false })), null, '兜底标记生效')
  // 兜底标记只属于这个浏览器：清掉它、配置里仍没写过，就会再出现一次。
  window.localStorage.clear()
  assert.notEqual(mount(client, ready({ seen: false })), null)
})

test('写回抛错时同样兜底，不把异常抛给界面', async () => {
  const client = await loadClient()
  window.localStorage.clear()
  const tree = mount(client, ready({ seen: false }), { write: () => Promise.reject(new Error('offline')) })
  tree.props.footer.props.onClick()
  await flush()
  assert.equal(window.localStorage.getItem(client.welcomeHelpers.markKey), '1')
})

test('设置页把 seen 写回 false 之后，弹层能当场再开', async () => {
  const client = await loadClient()
  window.localStorage.clear()
  const unseen = ready({ seen: false })
  const seen = ready({ seen: true })
  const tree = mount(client, unseen)
  tree.props.footer.props.onClick()
  assert.equal(redraw(client, unseen), null, '已收起')
  assert.equal(redraw(client, seen), null, '已看过的快照不出现')
  assert.notEqual(redraw(client, unseen), null, '判定值变回 false 后重新出现')
})

test('正文：眉行带品牌标记、三步、两处设置、动画说明，缺一不可', async () => {
  const client = await loadClient()
  const body = client.TeachWelcomeBody({ t: (key) => key })
  assert.equal(body.props.className, 'tsm-surface tsm-welcome')
  const nodes = []
  collect(body, (node) => nodes.push(node))
  const classes = nodes.map((node) => (typeof node.props.className === 'string' ? node.props.className : ''))
  assert.ok(classes.includes('tsm-welcome-kicker'))
  assert.ok(classes.includes('tsm-welcome-lede'))
  assert.ok(classes.includes('tsm-welcome-once'))
  const steps = nodes.filter((node) => node.type === 'li' && node.props.className === 'tsm-welcome-step')
  assert.equal(steps.length, 3)
  assert.equal(steps[0].children[0].children, '1', '步骤序号是真实文本，不靠 CSS 计数')
  assert.equal(steps[0].children[0].props['aria-hidden'], 'true')
  const groups = nodes.filter((node) => node.props.className === 'tsm-welcome-group')
  assert.equal(groups.length, 2, '「另外两处设置」与「教学动画」各一组')
  const headings = nodes.filter((node) => node.type === 'h3').map((node) => node.children)
  assert.deepEqual(headings, ['welcomeSettingsTitle', 'welcomeAnimationTitle'])
  const kicker = nodes.find((node) => node.props.className === 'tsm-welcome-kicker')
  assert.equal(kicker.children[0].type, client.brandMark, '品牌标记在眉行里，不另起图标体系')
})

test('文案：中英两表都写明「只出现一次」并指出恢复入口', async () => {
  const client = await loadClient()
  const { zh, en } = client.copy
  assert.match(zh.welcomeOnce, /只会出现一次/)
  assert.match(en.welcomeOnce, /only once/i)
  assert.match(zh.welcomeOnce, /重新显示欢迎页/)
  assert.match(en.welcomeOnce, /Show the welcome page/)
  for (const key of ['welcomeKicker', 'welcomeTitle', 'welcomeLede', 'welcomeStart', 'welcomeClose', 'welcomeSection', 'welcomeReopen', 'welcomeReopenHint', 'welcomeAnimationBody', 'welcomeAnimationBody2']) {
    assert.equal(typeof zh[key], 'string', 'zh 缺 ' + key)
    assert.equal(typeof en[key], 'string', 'en 缺 ' + key)
  }
  // Remotion 的用法必须出现在正文里（这是加欢迎页的主要理由之一）。
  assert.match(zh.welcomeAnimationBody, /Remotion/)
  assert.match(zh.welcomeAnimationBody, /绝对路径/)
  assert.match(en.welcomeAnimationBody, /Remotion/)
  assert.match(en.welcomeAnimationBody, /absolute path/i)
})
