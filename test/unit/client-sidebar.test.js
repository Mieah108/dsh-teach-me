import assert from 'node:assert/strict'
import test from 'node:test'

/* 客户端半（client.js）是浏览器插件：没有构建产物、也没有类型，所以用最小的
 * __ModuleLoader__ 桩把它装起来，断言它到底注册了哪些侧栏 tab、认领哪些地址、
 * 能不能按 lessonId 开课。
 *
 * 这里钉住三件真实事故相关的事：
 * 1) 认领 pattern 必须是 dsh-resource://file/session/**（比 better-sidebar 的
 *    dsh-resource://file/** 长，按宿主排序规则稳定胜出，不再依赖加载顺序）；
 * 2) 选课列表是独立的 page kind，不带 patterns，所以不占位官方 HTML 预览；
 * 3) 发布后自动打开靠 openTab(kind, {params:{lessonId}})，与地址认领互不依赖。 */

function fakeReact() {
  const noop = () => undefined
  return {
    createElement: (type, props, children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: noop,
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    Fragment: 'fragment'
  }
}

/** client.js 在模块顶层就摸 window，所以桩必须在 import 之前装好。 */
let clientExports
globalThis.window = {
  __ModuleLoader__: {
    // client.js 末尾是 `load({ id, factory })`，factory 直接返回 module.exports。
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

function mount() {
  const tabs = []
  const fetches = []
  globalThis.fetch = (url, init) => {
    fetches.push({ url, method: init && init.method, body: init && init.body })
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, value: { lessons: [], initialized: false, openable: true } })
    })
  }
  const slots = []
  const locales = []
  const opened = []
  const rpcCalls = []
  const disposer = () => () => {}
  const ctx = {
    effect: (factory) => {
      const value = factory()
      return typeof value === 'function' ? value : disposer()
    },
    locale: {
      register: (namespace, dict) => {
        locales.push({ namespace, dict })
        return disposer()
      },
      // 插件的文案表是 { zh, en }，宿主按当前语言取一层；测试固定中文。
      bind: (namespace) => (key) => {
        const found = locales.find((entry) => entry.namespace === namespace)
        if (found === undefined) return key
        const table = found.dict.zh ?? found.dict
        return table[key] ?? key
      }
    },
    configForms: {
      get: () => ({ mutate: () => undefined, snapshot: () => ({ status: 'unavailable' }) }),
      whileServed: (_entries, factory) => factory()
    },
    slots: {
      inject: (_name, factory) => factory(),
      register: (definition, component) => {
        slots.push({ definition, component })
        return disposer()
      }
    },
    sidebarRightTabs: {
      register: (definition) => {
        tabs.push(definition)
        return disposer()
      }
    },
    sidebarRight: {
      openTab: (kind, options) => {
        opened.push({ kind, options })
      }
    },
    // 客户端不再走 connection.rpc：课堂回传是 fetch POST /teach-classroom/rpc/<endpoint>。
    fetch: undefined
  }
  return { ctx, tabs, slots, opened, fetches }
}

test('注册两个侧栏 tab：选课列表（page kind）与课堂页（窄认领）', async () => {
  const api = await loadClient()
  const { ctx, tabs } = mount()
  api.apply(ctx)

  assert.deepEqual(api.inject, ['slots', 'locale', 'configForms', 'sidebarRightTabs', 'sidebarRight'])

  const courses = tabs.find((tab) => tab.kind === 'teach-courses')
  assert.ok(courses !== undefined, '缺 teach-courses')
  assert.equal(courses.id, 'dsh-teach-me/courses')
  assert.equal(courses.patterns, undefined, '选课列表是 page type，不该认领任何地址')
  assert.equal(courses.guide.length, 1)
  assert.equal(courses.guide[0].id, 'teach-courses')
  assert.equal(courses.guide[0].title(), '教学模式 · 选课')

  const classroom = tabs.find((tab) => tab.kind === 'teach-classroom')
  assert.ok(classroom !== undefined, '缺 teach-classroom')
  assert.deepEqual(classroom.patterns, ['dsh-resource://file/session/**'])
  assert.equal(classroom.priority, 'extension')
})

test('课堂页的地址认领：只认 session 作用域下的 lessons/*.html', async () => {
  const api = await loadClient()
  const { ctx, tabs } = mount()
  api.apply(ctx)
  const classroom = tabs.find((tab) => tab.kind === 'teach-classroom')

  assert.equal(classroom.canOpen('dsh-resource://file/session/s1/teach-test/lessons/0001.html'), true)
  assert.equal(classroom.canOpen('dsh-resource://file/session/s1/lessons/x.htm'), true)
  // 工作区里别的 html 不被接管（这就是"不占用官方 HTML 预览"的边界）。
  assert.equal(classroom.canOpen('dsh-resource://file/session/s1/reference/glossary.html'), false)
  assert.equal(classroom.canOpen('dsh-resource://file/session/s1/lessons/notes.md'), false)
  // absolute 作用域不在 pattern 里，canOpen 也拒绝，避免跨工作区误抢。
  assert.equal(classroom.canOpen('dsh-resource://file/absolute/tmp/lessons/x.html'), false)
  assert.equal(classroom.canOpen('sidebar://guide'), false)
})

test('tab 主体按 kind 注册，并给出按 lessonId 开课 / 选课的能力', async () => {
  const api = await loadClient()
  const { ctx, slots, opened, fetches } = mount()
  api.apply(ctx)

  const classroomBody = slots.find((slot) => slot.definition.key === 'dsh-teach-me')
  const coursesBody = slots.find((slot) => slot.definition.key === 'dsh-teach-me/courses')
  assert.ok(classroomBody !== undefined && coursesBody !== undefined)
  assert.equal(classroomBody.definition.name, 'sidebar.right.pane.tab')
  assert.equal(coursesBody.definition.name, 'sidebar.right.pane.tab')

  const classroomProps = classroomBody.definition.inject('session-1')
  assert.equal(classroomProps.sessionId, 'session-1')
  await classroomProps.lesson('lesson-1')
  assert.equal(fetches.at(-1).url, '/teach-classroom/rpc/classroom/open')
  assert.equal(fetches.at(-1).method, 'POST')
  assert.deepEqual(JSON.parse(fetches.at(-1).body), { payload: { sessionId: 'session-1', lessonId: 'lesson-1' } })
  await classroomProps.address('dsh-resource://file/session/session-1/lessons/x.html')
  assert.deepEqual(JSON.parse(fetches.at(-1).body).payload, { sessionId: 'session-1', address: 'dsh-resource://file/session/session-1/lessons/x.html' })

  const coursesProps = coursesBody.definition.inject('session-1')
  coursesProps.openLessonById('lesson-1')
  assert.deepEqual(opened.at(-1), { kind: 'teach-classroom', options: { params: { lessonId: 'lesson-1' } } })
  classroomProps.openCourses()
  assert.deepEqual(opened.at(-1), { kind: 'teach-courses', options: undefined })
})

test('侧栏列不存在时 openTab 抛错不会炸掉点击（返回 false）', async () => {
  const api = await loadClient()
  const { ctx, slots } = mount()
  ctx.sidebarRight.openTab = () => {
    throw new Error('sidebarRight: no session surface is mounted')
  }
  api.apply(ctx)
  const classroomBody = slots.find((slot) => slot.definition.key === 'dsh-teach-me')
  const props = classroomBody.definition.inject('session-1')
  assert.equal(props.openCourses(), false)
})
test('教学设置与预设共用官方控制行，已开始会话保留顶栏入口，不占输入卡上方', async () => {
  const api = await loadClient()
  const { ctx, slots } = mount()
  api.apply(ctx)
  const entries = slots.filter((slot) => slot.definition.id === 'teach-settings')
  assert.deepEqual(entries.map((slot) => slot.definition.name), ['conversation.hero.options', 'conversation.session.header.actions'])
  assert.ok(!entries.some((slot) => slot.definition.name === 'conversation.input.dock'))
  const hero = entries[0].definition.inject('session-1')
  assert.equal(hero.sessionId, 'session-1')
  assert.equal(typeof hero.callRpc, 'function')
  assert.equal(entries[1].definition.inject('session-1').placement, 'active')
})
