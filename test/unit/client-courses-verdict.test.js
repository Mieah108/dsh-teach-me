import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

/* 侧栏「教学模式 · 选课」这一面：catalog 给 lastVerdict（历史结论）+ lastVerdictStale/
 * lastVerdictStaleReason + lastSubmittedAt + missingPageIds/unmappedQuestionIds。重构后这一面要钉住：
 * 1) 一行只留一个状态词：失效时主线是「评估已过期」，历史结论降成灰字，不再用错误色抢焦点；
 * 2) 没有结论不等于没作答：已提交未评估、0 题、没提交各有各的说法；
 * 3) 日期说清是「作答」还是「评估」，取学习者最近一次动作；
 * 4) 两个方向的题号不一致分开说（missingPageIds 是页面写了没登记，unmappedQuestionIds 是登记了没排进页面）；
 * 5) 整行是按钮，可访问名是「打开 <课程名>，N 题」，题量与行尾箭头常驻；
 * 6) 载入是骨架条 + 一句只给读屏的文案；空态说清发生了什么、下一步在哪，且不出现内部工具名。 */

/** 组件用到的文案：照 client.js 的 zh 表抄，缺哪一条就在这里失败。 */
const labels = {
  coursesTab: '教学模式 · 选课',
  coursesCount: '{count} 节课',
  coursesRefresh: '刷新',
  coursesRetry: '重试',
  coursesLoading: '正在读课程…',
  coursesEmptyTitle: '还没有发布的课程',
  coursesEmpty: '让导师发布一节课，发布后会出现在这里。',
  coursesNoArchiveTitle: '还没有学习档案',
  coursesNoArchive: '发布第一节课、或第一次提交作答之后，档案会在这里建起来。',
  coursesFailed: '课程列表读不到：',
  coursesOpen: '打开',
  coursesPick: '选课',
  coursesOpenName: '打开 {title}，{count} 题',
  coursesAnsweredOn: '作答 {day}',
  coursesVerdictAt: '评估 {day}',
  coursesVerdictStale: '评估已过期',
  coursesVerdictHistory: '上次 {word}',
  coursesQuestionless: '本课没有练习题',
  coursesSubmittedNoVerdict: '已提交，暂无结论',
  coursesNotSubmitted: '尚未提交作答',
  coursesGapUnregistered: '{count} 题还没登记进档案',
  coursesUnshown: '{count} 题没排进页面',
  coursesOpenFailed: '打不开这节课：宿主没有挂课堂页签，重启后再试',
  ledgerQuestions: '{count} 题',
  'verdict.passed': '通过',
  'verdict.failed': '未通过',
  'verdict.needsPractice': '需练习',
  'verdict.needsReview': '待复核',
  'code.workspace-mismatch': '这个工作区对不上',
  listSep: '、',
  staleReasonWrap: '（{reason}）'
}

/** code.* 是「探测」语义（classroomErrorText 会试未登记的码），其余键必须真的在表里。 */
const t = (key) => {
  if (String(key).startsWith('code.')) return labels[key] ?? key
  assert.ok(key in labels, 't 桩里缺这条文案：' + key)
  return labels[key]
}

function renderCourses(catalog, options = {}) {
  const effects = []
  const slots = []
  // hook 顺序与 CoursesTab 一致：view / notice / tick。
  const hookKeys = ['view', 'notice', 'tick']
  const store = {
    view: options.view ?? { status: 'ready', value: catalog },
    notice: { tone: 'info', text: '' },
    tick: 0
  }
  let hookIndex = 0
  let effectIndex = 0
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: () => {
      const key = hookKeys[hookIndex++]
      return [store[key], (next) => { store[key] = typeof next === 'function' ? next(store[key]) : next }]
    },
    useEffect: (effect) => { effects[effectIndex++] = effect }
  }
  let api
  const window = {
    __ModuleLoader__: { load: (entry) => { api = entry.factory(() => react) } },
    addEventListener: () => {},
    removeEventListener: () => {}
  }
  vm.runInNewContext(fs.readFileSync(new URL('../../client.js', import.meta.url), 'utf8'), { window, Promise, Error })
  api.apply({
    effect: (factory) => factory(),
    locale: { register: () => {}, bind: () => (key) => key },
    configForms: { get: () => ({}), whileServed: () => {} },
    slots: { inject: (_name, factory) => factory(), register: (definition, component) => slots.push({ definition, component }) },
    sidebarRightTabs: { register: () => {} },
    sidebarRight: { openTab: () => {} }
  })
  const component = slots.find((slot) => slot.definition.key === 'dsh-teach-me/courses').component
  const props = {
    t,
    sessionId: 's1',
    callRpc: options.callRpc ?? (async () => ({ ok: true, value: catalog })),
    openLessonById: options.openLessonById ?? (() => true)
  }
  const render = () => {
    hookIndex = 0
    effectIndex = 0
    return component(props)
  }
  const tree = render()
  return { tree, render, store, run: (index) => effects[index]() }
}

const walk = (node, visit) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  visit(node)
  const kids = Array.isArray(node.children) ? node.children : []
  for (const kid of kids) walk(kid, visit)
}
/** 按 key 或类名找节点：版式还会调，用例不该跟着换下标。 */
const keyOf = (tree, key) => {
  let hit
  walk(tree, (node) => {
    if (hit === undefined && node.props && node.props.key === key) hit = node
  })
  return hit
}
const classOf = (node, name) => {
  let hit
  walk(node, (entry) => {
    if (hit === undefined && entry.props && typeof entry.props.className === 'string' && entry.props.className.split(' ').includes(name)) hit = entry
  })
  return hit
}
const allOfClass = (node, name) => {
  const hits = []
  walk(node, (entry) => {
    if (entry.props && typeof entry.props.className === 'string' && entry.props.className.split(' ').includes(name)) hits.push(entry)
  })
  return hits
}
const textOf = (node, sep = '') => {
  const parts = []
  walk(node, (entry) => {
    const kids = Array.isArray(entry.children) ? entry.children : [entry.children]
    for (const kid of kids) if (typeof kid === 'string' && kid !== '') parts.push(kid)
  })
  return parts.join(sep)
}

const listOf = (tree) => keyOf(tree, 'list')
/** 列表里每一行：一行就是一课（整行是按钮），第二行（.tsm-lessonmeta）是状态/日期/失效。 */
const rowsOf = (tree) => listOf(tree).children
const rowOf = (tree, index) => rowsOf(tree)[index]
const metaOf = (row) => classOf(row, 'tsm-lessonmeta')
const metaText = (row) => textOf(metaOf(row), ' ')
const verdictOf = (row) => classOf(metaOf(row), 'tsm-verdict')

const base = { id: 'l1', title: '第一课', revision: 3, questionCount: 2, publishedAt: '2026-10-01T00:00:00.000Z' }

test('失效的结论：主线换成「评估已过期」，历史结论降成灰字，不再用错误色', () => {
  const stale = renderCourses({
    initialized: true,
    lessons: [{ ...base, lastVerdict: 'failed', lastVerdictAt: '2026-10-02T00:00:00.000Z', lastVerdictStale: true, lastVerdictStaleReason: '题目已改版（评估 v1，现在 v2）' }]
  })
  const row = rowOf(stale.tree, 0)
  const line = metaText(row)
  // 协议枚举不进界面：failed 要印成「未通过」
  assert.match(line, /未通过/)
  assert.doesNotMatch(line, /failed/)
  // 失效是这一行唯一被强调的东西；历史结论仍然可见，但只是灰字
  assert.equal(textOf(classOf(row, 'tsm-stale')), '评估已过期')
  assert.equal(textOf(classOf(row, 'tsm-history')), '上次 未通过')
  // 不再有一条红字把一条已经不能信的结论推到视觉中心
  assert.equal(verdictOf(row), undefined, '失效时历史结论不该再挂错误色')
  assert.equal(allOfClass(row, 'tsm-verdict--bad').length, 0)
  assert.match(line, /题目已改版（评估 v1，现在 v2）/)
  // 没有作答时间时退回结论时间，并说清这是「评估」不是「作答」
  assert.match(line, /评估 10-02/)
})

test('仍然有效的结论用错误色标出要动手的那一条；日期取最近作答', () => {
  const valid = renderCourses({
    initialized: true,
    lessons: [{ ...base, lastVerdict: 'needs_practice', lastSubmittedAt: '2026-10-30T00:00:00.000Z', lastVerdictAt: '2026-10-02T00:00:00.000Z', lastVerdictStale: false }]
  })
  const row = rowOf(valid.tree, 0)
  const line = metaText(row)
  assert.match(line, /需练习/)
  assert.doesNotMatch(line, /needs_practice/)
  assert.match(line, /作答 10-30/)
  assert.doesNotMatch(line, /10-02/)
  assert.equal(classOf(row, 'tsm-stale'), undefined)
  assert.equal(verdictOf(row).props.className, 'tsm-verdict tsm-verdict--bad')
})

test('没有结论不是「尚未作答」：已提交说已提交，0 题说 0 题，没提交才说没提交', () => {
  const submitted = renderCourses({
    initialized: true,
    lessons: [{ ...base, lastSubmittedAt: '2026-10-30T00:00:00.000Z' }]
  })
  const submittedLine = metaText(rowOf(submitted.tree, 0))
  assert.match(submittedLine, /已提交，暂无结论/)
  // 已提交的行不能同时说「尚未提交」——那是自相矛盾的两个事实
  assert.doesNotMatch(submittedLine, /尚未/)
  assert.match(submittedLine, /作答 10-30/)

  const untouched = renderCourses({ initialized: true, lessons: [{ ...base }] })
  const untouchedLine = metaText(rowOf(untouched.tree, 0))
  assert.match(untouchedLine, /尚未提交作答/)
  assert.doesNotMatch(untouchedLine, /通过|需练习|待复核|未通过/)

  const questionless = renderCourses({ initialized: true, lessons: [{ ...base, questionCount: 0 }] })
  const questionlessLine = metaText(rowOf(questionless.tree, 0))
  assert.match(questionlessLine, /本课没有练习题/)
  assert.doesNotMatch(questionlessLine, /尚未/)
})

test('两个方向的题号不一致分开说，行里只说数量，具体题号进 title', () => {
  const view = renderCourses({
    initialized: true,
    lessons: [
      { ...base, id: 'l-missing', missingPageIds: ['q3', 'q4'], unmappedQuestionIds: ['q9'] },
      { ...base, id: 'l-unmapped', missingPageIds: [], unmappedQuestionIds: ['q5'] }
    ]
  })
  const gap = classOf(rowOf(view.tree, 0), 'tsm-gap')
  assert.ok(gap !== undefined, '题号对不上要有一行说明')
  // 两个方向各说各的，别混成一句「页面缺」把方向说反（10.2）
  assert.equal(textOf(gap), '2 题还没登记进档案 · 1 题没排进页面')
  // 内部题号不上正文：只在 title 里留给需要的人
  assert.equal(gap.props.title, 'q3、q4、q9')
  // aria-label 会盖住整行内容，所以这一行必须挂在 describedby 上，否则读屏听不到
  assert.equal(rowOf(view.tree, 0).props['aria-describedby'], metaOf(rowOf(view.tree, 0)).props.id + ' ' + gap.props.id)
  assert.equal(gap.props.id, 'teach-me-lesson-0-meta-gap')
  const second = classOf(rowOf(view.tree, 1), 'tsm-gap')
  assert.equal(textOf(second), '1 题没排进页面')
  assert.equal(second.props.title, 'q5')
  // 两件事都没有的课不画这一行
  assert.equal(classOf(rowOf(renderCourses({ initialized: true, lessons: [base] }).tree, 0), 'tsm-gap'), undefined)
})

test('结论词：failed 与 needs_practice 走错误档，未知枚举原样印出（不猜一个词）', () => {
  const view = renderCourses({
    initialized: true,
    lessons: [
      { ...base, id: 'l-passed', lastVerdict: 'passed' },
      { ...base, id: 'l-failed', lastVerdict: 'failed' },
      { ...base, id: 'l-review', lastVerdict: 'needs_review' },
      { ...base, id: 'l-unknown', lastVerdict: 'excellent' }
    ]
  })
  assert.equal(textOf(verdictOf(rowOf(view.tree, 0))), '通过')
  assert.equal(verdictOf(rowOf(view.tree, 0)).props.className, 'tsm-verdict')
  assert.equal(textOf(verdictOf(rowOf(view.tree, 1))), '未通过')
  assert.equal(verdictOf(rowOf(view.tree, 1)).props.className, 'tsm-verdict tsm-verdict--bad')
  assert.equal(textOf(verdictOf(rowOf(view.tree, 2))), '待复核')
  assert.equal(verdictOf(rowOf(view.tree, 2)).props.className, 'tsm-verdict')
  // 没登记的枚举：宁可让人读到原码，也不要猜一个中文词
  assert.equal(textOf(verdictOf(rowOf(view.tree, 3))), 'excellent')
  assert.equal(verdictOf(rowOf(view.tree, 3)).props.className, 'tsm-verdict')
})

test('载入态：三条骨架条 + 一句只给读屏的「正在读课程…」，不印空态句', () => {
  const view = renderCourses(null, { view: { status: 'loading' } })
  const skeletons = listOf(view.tree).children
  assert.equal(skeletons.length, 3, '骨架条要凑够真实行高，数据落下时不跳高')
  for (const skeleton of skeletons) {
    assert.equal(skeleton.props.className, 'tsm-skeleton')
    assert.equal(skeleton.props['aria-hidden'], 'true')
  }
  const loading = view.tree.children.find((node) => node && node.props && node.props.role === 'status')
  assert.ok(loading !== undefined, '载入要有可播报的状态')
  assert.equal(textOf(loading), '正在读课程…')
  assert.match(loading.props.className, /(^|\s)tsm-sr(\s|$)/, '这句话只给读屏，不占版面')
  // 载入不是空态：空态/失败各自的那句话一个都不能提前出现
  const flat = textOf(view.tree)
  assert.equal(flat.includes('还没有发布的课程'), false)
  assert.equal(flat.includes('还没有学习档案'), false)
  assert.equal(view.tree.children.some((node) => node && node.props && node.props.className === 'tsm-empty'), false)
})

test('空态：标题 + 下一步，归档与否分开说，且不出现内部工具名', () => {
  const noArchive = renderCourses({ initialized: false, lessons: [] })
  const archiveEmpty = classOf(noArchive.tree, 'tsm-empty')
  assert.equal(archiveEmpty.props.role, 'status')
  assert.equal(textOf(keyOf(noArchive.tree, 'title')), '还没有学习档案')
  assert.equal(textOf(keyOf(noArchive.tree, 'next')), '发布第一节课、或第一次提交作答之后，档案会在这里建起来。')

  const published = renderCourses({ initialized: true, lessons: [] })
  assert.equal(textOf(keyOf(published.tree, 'title')), '还没有发布的课程')
  assert.equal(textOf(keyOf(published.tree, 'next')), '让导师发布一节课，发布后会出现在这里。')
  // 界面上不该出现 teach_lesson_publish 这类内部工具名
  assert.doesNotMatch(textOf(published.tree), /teach_lesson_publish|classroom/)
})

test('顶部只有数量与刷新，不再重复页签名', () => {
  const view = renderCourses({ initialized: true, lessons: [base, { ...base, id: 'l2', title: '第二课' }] })
  const toolbar = keyOf(view.tree, 'bar')
  assert.equal(toolbar.props.className, 'tsm-toolbar')
  assert.equal(textOf(keyOf(view.tree, 'count')), '2 节课')
  const refresh = keyOf(view.tree, 'refresh')
  assert.equal(refresh.type, 'button')
  assert.equal(refresh.props.className, 'tsm-quiet')
  assert.equal(textOf(refresh), '刷新')
  // 宿主页签已经写着「教学模式 · 选课」，列表里不再印一遍
  assert.equal(textOf(view.tree).includes('教学模式 · 选课'), false)
})

test('整行是按钮：可访问名是「打开 <课程名>，N 题」，题量与行尾箭头常驻', () => {
  const view = renderCourses({ initialized: true, lessons: [{ ...base, lastVerdict: 'failed' }] })
  const row = rowOf(view.tree, 0)
  assert.equal(row.type, 'button')
  assert.equal(row.props.className, 'tsm-lesson')
  assert.equal(row.props['aria-label'], '打开 第一课，2 题')
  // 可访问名只点出动作与课程：结论、日期这些元信息不能再串进名字里
  assert.doesNotMatch(row.props['aria-label'], /未通过|作答/)
  assert.equal(row.props.title, '第一课')
  const meta = metaOf(row)
  assert.equal(meta.props.id, 'teach-me-lesson-0-meta')
  assert.equal(row.props['aria-describedby'], meta.props.id)
  const line1 = classOf(row, 'tsm-lessonline')
  // 题量不再是「悬停才看得见」的东西
  assert.equal(textOf(classOf(line1, 'tsm-figure')), '2 题')
  const caret = classOf(line1, 'tsm-caret')
  assert.equal(caret.props['aria-hidden'], 'true')
  assert.equal(textOf(caret), '›')
  assert.equal(classOf(line1, 'tsm-open'), undefined, '旧的悬停提示已经删掉')
})

test('点「打开」但宿主没挂课堂页签：不许静默失败，要说出来', () => {
  // openLessonById 返回 false（宿主侧不抛），旧实现把这个 false 丢掉了，点击等于什么都没发生。
  const { tree, render, store } = renderCourses({ initialized: true, lessons: [base] }, { openLessonById: () => false })
  rowOf(tree, 0).props.onClick()
  assert.equal(store.notice.tone, 'error')
  assert.match(store.notice.text, /打不开这节课/)
  // 失败走 assertive 活区，polite 那行留空
  const liveAlert = render().children.find((node) => node.props && node.props.role === 'alert')
  const livePolite = render().children.find((node) => node.props && node.props.role === 'status')
  assert.equal(String(liveAlert.children), store.notice.text)
  assert.equal(String(livePolite.children), '')
})

test('打开成功时不留错误提示', () => {
  const { tree, render, store } = renderCourses({ initialized: true, lessons: [base] }, { openLessonById: () => true })
  rowOf(tree, 0).props.onClick()
  assert.equal(store.notice.tone, 'info')
  assert.equal(store.notice.text, '')
  assert.equal(String(render().children.find((node) => node.props && node.props.role === 'alert').children), '')
})

test('刷新失败不吞掉已经画出来的列表：错误只落在提示行（U06）', async () => {
  const view = renderCourses({ initialized: true, lessons: [base] }, {
    callRpc: async () => ({ ok: false, error: { code: 'workspace-mismatch' } })
  })
  // 重跑一次取数：失败时保留原有列表，而不是把版面换成错误块
  view.run(0)
  await new Promise((resolve) => setImmediate(resolve))
  const tree = view.render()
  assert.equal(view.store.notice.tone, 'error')
  assert.ok(keyOf(tree, 'list') !== undefined, '列表不能因为一次刷新失败就消失')
  assert.equal(rowsOf(tree).length, 1)
  assert.ok(textOf(tree).includes('这个工作区对不上'), '失败原因要说在提示行里')
})
