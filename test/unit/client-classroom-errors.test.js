import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

/* 课堂页签（client.js 的 ClassroomTab）是浏览器插件组件：没有构建产物，所以用最小的
 * React 桩把真实组件渲染成元素树，再驱动真实的事件回调与课程页报文。这里钉住两类事：
 * 1) 错误路径：业务失败/传输异常都要回传 teach:error，提示分 error/info 两档，双活区分工；
 * 2) 重构后的结构：五态（载入/失败/无地址/就绪/忙碌）、常驻账目行，以及账目行从
 *    classroom/open、classroom/status 与提交/状态报文更新的真实行为。 */

/** 组件用到的文案：照 client.js 的 zh 表抄，缺哪一条就在这里失败，而不是界面上漏 key。 */
const labels = {
  classroomTab: '课堂',
  classroomBack: '‹ 选课',
  classroomLoading: '正在打开课堂…',
  classroomFailed: '课堂打不开',
  classroomExport: '导出离线页',
  classroomImport: '导入进度',
  classroomRefresh: '重新加载课堂',
  classroomOpenAgain: '重新打开',
  classroomSubmitted: '已提交',
  classroomReloaded: '课堂已重新加载',
  classroomFailedNext: '重新打开，或者回选课换一节。',
  classroomNoUrl: '课堂没有给出课程页地址。',
  coursesPick: '选课',
  coursesPickFailed: '打不开选课页签：宿主没有挂侧栏，重启后再试',
  ledgerQuestions: '{count} 题',
  ledgerAnswered: '已答 {count}',
  ledgerPending: '待批改 {count}',
  ledgerPendingOf: '其中待批改 {count}',
  ledgerNoAnswer: '尚未作答',
  ledgerAssessment: '最近评估：',
  'verdict.passed': '通过',
  'verdict.failed': '未通过',
  'verdict.needsPractice': '需练习',
  'verdict.needsReview': '待复核',
  'code.lesson-not-found': '这节课还没发布，或者已经不在课程清单里',
  'code.rate-limited': '操作太频繁，等一会儿再试'
}

/** 组件只认表里的键。码表那一路是「探测」语义（classroomErrorText 会试未登记的码），
 * 所以 code.* 允许留成键名，其余键缺失就直接炸。 */
const t = (key) => {
  if (String(key).startsWith('code.')) return labels[key] ?? key
  assert.ok(key in labels, 't 桩里缺这条文案：' + key)
  return labels[key]
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function classroom(callRpc, options = {}) {
  const effects = []
  const notices = []
  const messages = []
  const listeners = {}
  const slots = []
  const contentWindow = { postMessage: (message) => messages.push(message) }
  const frame = { contentWindow }
  const value = options.value ?? { lessonId: 'l1', revision: 1, nonce: 'nonce', url: '/lesson', title: '课' }
  // hook 顺序与 ClassroomTab 一致：5 个 useState（view/notice/frameSeq/busy/ledger），
  // 然后 4 个 useRef（iframe/nonce/file/alive）。位置敏感，别调换。
  const hookKeys = ['view', 'notice', 'frameSeq', 'busy', 'ledger', 'reloadSeq', 'reading', 'readingPending']
  const store = {
    view: options.loading === true ? { status: 'loading' } : { status: 'ready', value },
    notice: { tone: 'info', text: '' },
    frameSeq: 0,
    busy: false,
    ledger: { questions: null, answered: 0, pending: 0, verdict: '' },
    reloadSeq: 0, reading: null, readingPending: false
  }
  // 组件只在打开成功时写 nonce；多数用例直接挂「已就绪」，这里预置同一串（等价于刚打开过）。
  const refs = [{ current: frame }, { current: 'nonce' }, { current: null }, { current: true }, { current: null }, { current: null }]
  let hookIndex = 0
  let refIndex = 0
  let effectIndex = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
    useState: () => {
      const key = hookKeys[hookIndex++]
      return [store[key], (next) => {
        store[key] = typeof next === 'function' ? next(store[key]) : next
        if (key === 'notice') notices.push(store[key].text)
      }]
    },
    useRef: () => refs[refIndex++],
    useEffect: (effect) => { effects[effectIndex++] = effect }
  }
  let api
  const window = {
    __ModuleLoader__: { load: (entry) => { api = entry.factory(() => react) } },
    addEventListener: (type, listener) => { listeners[type] = listener },
    removeEventListener: () => {}
  }
  // 侧栏没挂上时 openTab 抛错（宿主就是这么报的），openCourses 会折成 false。
  const sidebarRight = {
    openTab: () => { if (options.sidebarMounted === false) throw new Error('sidebarRight: no session surface is mounted') }
  }
  vm.runInNewContext(fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8'), { window, Promise, Error })
  api.apply({
    effect: (factory) => factory(),
    locale: { register: () => {}, bind: () => (key) => key },
    configForms: { get: () => ({}), whileServed: () => {} },
    slots: { inject: (_name, factory) => factory(), register: (definition, component) => slots.push({ definition, component }) },
    sidebarRightTabs: { register: () => {} },
    sidebarRight
  })
  const component = slots.find((slot) => slot.definition.key === 'dsh-teach-me' && slot.definition.name === 'sidebar.right.pane.tab').component
  // 与 apply 里 classroom 页签的 inject 同形：两条入口都落到 classroom/open，选课走 openTab。
  const props = {
    useTabInfo: () => ({ tab: { navigation: { address: '', params: { lessonId: 'l1' } } } }),
    t,
    sessionId: 's1',
    callRpc,
    lesson: (lessonId) => callRpc('classroom/open', { sessionId: 's1', lessonId }),
    address: (address) => callRpc('classroom/open', { sessionId: 's1', address }),
    openCourses: () => {
      try {
        sidebarRight.openTab('teach-courses')
        return true
      } catch {
        return false
      }
    }
  }
  /** 重渲染：刷新会 setView/setFrameSeq/setLedger，树要按最新 state 再算一遍才看得到新 key。 */
  const render = () => {
    hookIndex = 0
    refIndex = 0
    effectIndex = 0
    return component(props)
  }
  const tree = render()
  // 只有就绪态才画 iframe，第二个 effect 才会真的挂上 message handler。
  if (store.view.status === 'ready') effects[1]()
  return {
    tree, store, notices, messages, render,
    /** 走真实的打开流程：open 请求 → settle → 按新 state 重渲染 → 挂 message 监听。 */
    mountOpen: async () => {
      effects[0]()
      await flush()
      const next = render()
      effects[1]()
      return next
    },
    refresh: () => keyOf(tree, 'refresh').props.onClick(),
    send: (type = 'submit') => listeners.message({ source: frame.contentWindow, data: { source: 'teach-classroom', nonce: 'nonce', type, requestId: 'req1', questionId: 'q1', questionRevision: 2, rawAnswer: 'b' } })
  }
}

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  const kids = Array.isArray(node.children) ? node.children : []
  for (const kid of kids) walk(kid, visit)
}
/** 按 key 找节点：树的结构会随布局调整，用例不该跟着换下标。 */
const keyOf = (tree, key) => {
  let hit
  walk(tree, (node) => {
    if (hit === undefined && node.props && node.props.key === key) hit = node
  })
  return hit
}
const iframeOf = (tree) => tree.children.find((node) => node && node.type === 'iframe')
const liveOf = (tree, role) => tree.children.find((node) => node && node.props && node.props.role === role && node.type === 'span')
/** 一棵（子）树的全部可见/可播报文本；账目行这类精确文案用空串拼，不要空格。 */
const textOf = (node) => {
  const parts = []
  walk(node, (entry) => {
    const kids = Array.isArray(entry.children) ? entry.children : [entry.children]
    for (const kid of kids) if (typeof kid === 'string' && kid !== '') parts.push(kid)
  })
  return parts.join('')
}
const classNames = (tree) => {
  const names = []
  walk(tree, (node) => {
    if (node.props && typeof node.props.className === 'string') names.push(node.props.className)
  })
  return names
}

test('课堂业务失败也回传 teach:error，让桥能解除按钮禁用', async () => {
  const view = classroom(async () => ({ ok: false, error: { message: '题目已改版' } }))
  view.send()
  await flush()
  assert.equal(view.messages[0]?.type, 'teach:error')
  assert.match(view.messages[0].error.message, /题目已改版/)
  assert.match(view.notices.at(-1), /题目已改版/)
})

test('课堂传输异常回传错误；成功回传结果并携带题目 revision', async () => {
  const failed = classroom(async () => { throw new Error('离线') })
  failed.send()
  await flush()
  assert.equal(failed.messages[0].type, 'teach:error')
  let submitted
  const ready = classroom(async (endpoint, payload) => {
    if (endpoint === 'classroom/submit') submitted = payload
    return { ok: true, value: { verdict: 'passed' } }
  })
  ready.send()
  await flush()
  assert.equal(submitted.questionRevision, 2)
  assert.equal(ready.messages[0].type, 'teach:result')
  assert.deepEqual(ready.messages[0].value, { verdict: 'passed' })
})

test('刷新状态同时重开课堂与读状态：换 iframe key；账目行更新，状态行只说已刷新', async () => {
  const calls = []
  const reopened = { lessonId: 'l1', revision: 2, nonce: 'nonce-2', url: '/lesson-2', title: '课' }
  const view = classroom(async (endpoint) => {
    calls.push(endpoint)
    if (endpoint === 'classroom/open') return { ok: true, value: reopened }
    return {
      ok: true,
      value: {
        questions: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }, { id: 'q4' }],
        pending: [{ submissionId: 's1', questionId: 'q1' }],
        pendingCount: 1,
        submissions: [
          { id: 's1', questionId: 'q1', verdict: null, effectiveVerdict: null, verdictAt: null },
          { id: 's2', questionId: 'q2', verdict: 'passed', effectiveVerdict: 'passed', verdictAt: '2026-01-02T00:00:00.000Z' },
          { id: 's3', questionId: 'q3', verdict: 'needs_practice', effectiveVerdict: 'needs_practice', verdictAt: '2026-01-01T00:00:00.000Z' }
        ]
      }
    }
  })
  const before = iframeOf(view.tree)
  assert.ok(before !== undefined, '缺课程页 iframe')
  view.refresh()
  await flush()
  assert.deepEqual(calls, ['classroom/open', 'classroom/status'])
  // open 成功：整页重挂（key 变），并换上新的 nonce 与课程 revision
  const tree = view.render()
  assert.equal(iframeOf(tree).props.key, 'frame-1')
  assert.notEqual(iframeOf(tree).props.key, before.props.key)
  assert.equal(view.store.view.value.revision, 2)
  // 账目行常驻在头部：一行计数，一句「最近评估」（按 verdictAt 取最新，且只说这是最近一次）
  const ledger = keyOf(tree, 'ledger')
  assert.ok(ledger !== undefined, '缺常驻账目行')
  assert.equal(ledger.props.className, 'tsm-ledger')
  assert.equal(textOf(keyOf(ledger, 'counts')), '4 题 · 已答 3 · 其中待批改 1')
  assert.equal(textOf(keyOf(ledger, 'assessment')), '最近评估：通过 · 01-02')
  assert.doesNotMatch(textOf(ledger), /needs_practice|需练习/)
  // 结论不能接在计数后面冒充整课结论（U02）
  assert.doesNotMatch(textOf(keyOf(ledger, 'counts')), /通过/)
  // 状态行只报「刚做过什么」：计数已经搬进账目行，不许在提示里再印一遍。
  const notice = view.store.notice
  assert.equal(notice.tone, 'info')
  assert.equal(notice.text, '课堂已重新加载')
  assert.doesNotMatch(notice.text, /题|已答|待批改/)
})

test('刷新失败仍显示服务端错误文案，且不凭空造账目行', async () => {
  const calls = []
  const view = classroom(async (endpoint) => {
    calls.push(endpoint)
    return { ok: false, error: { message: '无法刷新' } }
  })
  view.refresh()
  await flush()
  assert.deepEqual(calls, ['classroom/open', 'classroom/status'])
  assert.equal(view.store.notice.tone, 'error')
  assert.match(view.store.notice.text, /无法刷新/)
  // 没读到状态就没有事实可印：账目行整行不画，而不是画一句「尚未作答」。
  assert.equal(keyOf(view.render(), 'ledger'), undefined)
})

test('失败提示是 error 档：红字 + assertive 活区，成功仍是 polite', async () => {
  const view = classroom(async () => ({ ok: false, error: { code: 'rate-limited', message: '太频繁' } }))
  view.send()
  await flush()
  const tree = view.render()
  assert.equal(view.store.notice.tone, 'error')
  // 给人看的一行只有文字，不带 role（role 交给两条隐藏活区分工）
  const visible = keyOf(tree, 'notice')
  assert.equal(visible.type, 'p')
  assert.equal(visible.props.role, undefined)
  assert.equal(visible.props['aria-live'], undefined)
  assert.match(visible.props.className, /tsm-noticeline--error/)
  // 失败走 assertive 那一行，polite 那一行必须空着，否则同一句话会被播两遍
  assert.equal(liveOf(tree, 'alert').children.join(''), view.store.notice.text)
  assert.equal(liveOf(tree, 'status').children.join(''), '')
})

test('成功提示走 polite，assertive 那行留空', async () => {
  const view = classroom(async () => ({ ok: true, value: { verdict: 'passed' } }))
  view.send()
  await flush()
  const tree = view.render()
  assert.equal(view.store.notice.tone, 'info')
  assert.doesNotMatch(keyOf(tree, 'notice').props.className, /--error/)
  assert.equal(liveOf(tree, 'status').children.join(''), view.store.notice.text)
  assert.equal(liveOf(tree, 'alert').children.join(''), '')
})

test('请求在飞时按钮禁用，连点不会发出第二份请求', async () => {
  const calls = []
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const view = classroom(async (endpoint) => {
    calls.push(endpoint)
    await pending
    return { ok: true, value: { lessonId: 'l1', revision: 2, nonce: 'n2', url: '/lesson-2', title: '课' } }
  })
  view.refresh()
  await flush()
  assert.equal(view.store.busy, true)
  // 重渲染后按钮带上 disabled，第二次点击直接返回，不会再排一次请求
  const tree = view.render()
  const refresh = keyOf(tree, 'refresh')
  assert.equal(refresh.props.className, 'tsm-btn')
  assert.equal(refresh.props.disabled, true)
  keyOf(tree, 'refresh').props.onClick()
  assert.deepEqual(calls, ['classroom/open', 'classroom/status'])
  release()
  await flush()
  await flush()
  assert.equal(view.store.busy, false)
})

test('载入态是骨架行 + 一句只给读屏的话；旧结构的类名一个不留', () => {
  const view = classroom(async () => ({ ok: true, value: {} }), { loading: true })
  const tree = view.tree
  assert.equal(tree.props.role, 'status')
  assert.equal(tree.props.className, 'tsm-surface tsm-pane')
  // 载入不是一句裸文本：头部与整帧两块骨架，数据落下时版面不跳
  assert.equal(keyOf(tree, 'skeleton-head').props.className, 'tsm-skeleton')
  assert.equal(keyOf(tree, 'skeleton-head').children.length, 2)
  const state = keyOf(tree, 'state')
  assert.equal(state.props.className, 'tsm-sr')
  assert.equal(textOf(state), '正在打开课堂…')
  for (const name of classNames(tree)) {
    assert.doesNotMatch(name, /\btsm-(state|bar|grow|rowname)\b/, '旧的布局类名不该还在：' + name)
  }
})

test('打不开时：说明原因，并给一条回选课的路（侧栏没挂上要说出来）', async () => {
  const view = classroom(async () => ({ ok: false, error: { code: 'lesson-not-found', message: '这个地址不在已发布课程清单里' } }), { loading: true, sidebarMounted: false })
  const tree = await view.mountOpen()
  // 一个活区：容器不带 role，内层那块才是 role=alert（免得嵌套播报两遍）。
  assert.equal(tree.props.role, undefined)
  const state = keyOf(tree, 'state')
  assert.equal(state.props.className, 'tsm-empty')
  // 一个活区只包文字：按钮不能落在 alert 里，否则读屏会把控件名一起念出来
  assert.equal(state.props.role, undefined)
  assert.equal(keyOf(tree, 'alert').props.role, 'alert')
  assert.equal(textOf(keyOf(tree, 'why')), '课堂打不开')
  // 认识的错误码翻成界面上的话，不印服务端原句
  assert.equal(textOf(keyOf(tree, 'why-text')), '这节课还没发布，或者已经不在课程清单里')
  // 失败态要给出下一步：一句话 + 两个动作（重新打开 / 回选课）
  assert.equal(textOf(keyOf(tree, 'next')), '重新打开，或者回选课换一节。')
  const reopen = keyOf(tree, 'reopen')
  assert.equal(reopen.type, 'button')
  assert.equal(reopen.props.className, 'tsm-btn')
  assert.equal(textOf(reopen), '重新打开')
  // 失败态也保留导航：离开的路在头部，不在正文里当按钮
  const pick = keyOf(tree, 'pick')
  assert.equal(pick.type, 'button')
  assert.equal(pick.props.className, 'tsm-back')
  assert.equal(textOf(pick), '‹ 选课')
  pick.props.onClick()
  assert.equal(view.store.notice.tone, 'error')
  assert.equal(view.store.notice.text, '打不开选课页签：宿主没有挂侧栏，重启后再试')
  // 失败态也要把这句话画出来：否则「‹ 选课」点了没声音。
  assert.equal(textOf(view.render()).includes('打不开选课页签'), true)
})

test('打开时补不上状态：账目行只降级成题量，不编造已答/待批改/结论', async () => {
  const calls = []
  const view = classroom(async (endpoint) => {
    calls.push(endpoint)
    if (endpoint === 'classroom/open') {
      return { ok: true, value: { lessonId: 'l1', revision: 1, nonce: 'nonce', url: '/lesson', title: '课', questions: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }, { id: 'q4' }] } }
    }
    return { ok: false, error: { code: 'transport', message: '课堂接口请求失败：离线' } }
  }, { loading: true })
  const tree = await view.mountOpen()
  // open 拿题量，status 是 best-effort 的补读（失败静默）
  assert.deepEqual(calls, ['classroom/open', 'classroom/status'])
  assert.equal(view.store.notice.text, '')
  const ledger = keyOf(tree, 'ledger')
  assert.ok(ledger !== undefined, '账目行必须常驻，哪怕只有题量')
  // 没读到 status 就是「不知道」：只印题量，不把「一题没答」当成事实说出来。
  assert.equal(textOf(ledger), '4 题')
  assert.doesNotMatch(textOf(ledger), /已答|待批改|通过|未通过|尚未作答/)
})

test('课程页发来的状态报文与提交各自把账目行更新到最新', async () => {
  const statuses = [
    {
      questions: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }],
      pendingCount: 1,
      submissions: [
        { questionId: 'q1', effectiveVerdict: 'passed', verdictAt: '2026-01-05T00:00:00.000Z' },
        { questionId: 'q2', effectiveVerdict: null }
      ]
    },
    {
      questions: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }],
      pendingCount: 0,
      submissions: [
        { questionId: 'q1', effectiveVerdict: 'passed', verdictAt: '2026-01-05T00:00:00.000Z' },
        { questionId: 'q2', effectiveVerdict: 'needs_practice', verdictAt: '2026-01-06T00:00:00.000Z' },
        { questionId: 'q3', effectiveVerdict: 'needs_practice', verdictAt: '2026-01-06T00:00:00.000Z' }
      ]
    }
  ]
  const view = classroom(async (endpoint) => {
    if (endpoint === 'classroom/status') return { ok: true, value: statuses.shift() }
    return { ok: true, value: { verdict: 'passed' } }
  })
  // 课程页自己发 status：账目行跟着变，且不打扰状态行
  view.send('status')
  await flush()
  const first = keyOf(view.render(), 'ledger')
  assert.equal(textOf(keyOf(first, 'counts')), '3 题 · 已答 2 · 其中待批改 1')
  assert.equal(textOf(keyOf(first, 'assessment')), '最近评估：通过 · 01-05')
  assert.equal(view.store.notice.text, '')
  assert.equal(view.messages.at(-1).type, 'teach:result')
  // 交一题：先确认已提交，再补读一次 status 让账目行落到新状态
  view.send('submit')
  await flush()
  await flush()
  const second = keyOf(view.render(), 'ledger')
  assert.equal(textOf(keyOf(second, 'counts')), '3 题 · 已答 3')
  assert.equal(textOf(keyOf(second, 'assessment')), '最近评估：需练习 · 01-06')
  assert.equal(view.messages.at(-1).type, 'teach:result')
  assert.equal(view.notices.at(-1), '已提交')
})

test('就绪但没给课程页地址：不进 iframe，直接说明', () => {
  const view = classroom(async () => ({ ok: true, value: {} }), { value: { lessonId: 'l1', revision: 1, nonce: 'nonce', url: '', title: '课' } })
  const tree = view.tree
  assert.equal(iframeOf(tree), undefined)
  assert.equal(tree.props.role, undefined)
  assert.equal(keyOf(tree, 'alert').props.role, 'alert')
  const state = keyOf(tree, 'state')
  assert.equal(state.props.className, 'tsm-empty')
  assert.equal(textOf(keyOf(tree, 'why')), '课堂没有给出课程页地址。')
  // 缺地址不是死路：同一条 classroom/open 可以再试一次，也能回选课
  assert.equal(textOf(keyOf(tree, 'reopen')), '重新打开')
  assert.equal(textOf(keyOf(tree, 'pick')), '‹ 选课')
})

test('失败态的「重新打开」真的再走一次 classroom/open，不是画个按钮', async () => {
  let attempt = 0
  const calls = []
  const view = classroom(async (endpoint) => {
    calls.push(endpoint)
    if (attempt === 0) {
      attempt += 1
      return { ok: false, error: { code: 'lesson-not-found' } }
    }
    return { ok: true, value: { lessonId: 'l1', revision: 1, nonce: 'n2', url: '/lesson', title: '课', questions: [{ id: 'q1' }] } }
  }, { loading: true })
  const failed = await view.mountOpen()
  assert.equal(view.store.view.status, 'failed')
  keyOf(failed, 'reopen').props.onClick()
  // 点下去先回到载入态，并让打开请求重跑一次（reloadSeq 是 effect 的依赖）
  assert.equal(view.store.view.status, 'loading')
  assert.equal(view.store.reloadSeq, 1)
  const ready = await view.mountOpen()
  assert.equal(view.store.view.status, 'ready')
  assert.ok(iframeOf(ready) !== undefined, '重开成功后要真的挂上课程页')
  assert.deepEqual(calls, ['classroom/open', 'classroom/open', 'classroom/status'])
})
