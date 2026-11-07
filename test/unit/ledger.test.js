import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  createLedger,
  looksLikeScriptWrite,
  registerReportTool,
  renderShapeLines,
  scanTouchedFiles
} from '../../lib/ledger.js'

/* 账本（ADR-0005）只做参考线，但它报出来的数字不能自相矛盾：
 *  1. 报表自己的调用还没结算时，要显示「进行中」，不是「成功 0」；
 *  2. 同一棵调用树里的嵌套失败与父 run_code 失败是一次事故，不能各记一次（实测 14 = 8 + 6）；
 *  3. 「目标形状」只在 still 全过、成片只渲一次时才能说；
 *  4. bash 里跑脚本改的文件要能看见（逐次归因做不到，用 mtime 补一张可能的清单）；
 *  5. auto 权限下被审查通道吞掉的调用要单独点名。
 */

const AGENT = { id: 'agent-1', session: { id: 'session-1' } }

function configOf({ ledger = {}, tools = {} } = {}) {
  return {
    ledger: { enabled: true, editBudget: 8, stepBudget: 120, ...ledger },
    tools: { report: true, ...tools }
  }
}

/**
 * 假上下文：只实现账本用到的 on / effect / get('tools')。
 * pre()/res() 直接调用注册进去的监听器，等价于宿主发事件。
 */
function harness({ config = configOf(), workspaceOf } = {}) {
  const getConfig = () => config
  const registered = []
  const listeners = new Map()
  const ctx = {
    get: (name) => (name === 'tools' ? { register: (definition) => { registered.push(definition); return () => {} } } : undefined),
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => {}
    },
    effect: (factory) => factory()
  }
  const ledger = createLedger(getConfig)
  ledger.attach(ctx)
  registerReportTool(ctx, getConfig, ledger, undefined, workspaceOf)
  const tool = registered.find((entry) => entry.name === 'teach_report')
  return {
    ctx,
    ledger,
    tool,
    config,
    pre: (execution) => listeners.get('tools/pre-execute')(execution, () => ({ kind: 'allow' })),
    res: (execution, result) => listeners.get('tools/result')(execution, result)
  }
}

/** 根调用（模型直达）：只有 callId，没有 parent。 */
const rootExec = (name, callId, extra = {}) => ({ callId, name, arguments: {}, agent: AGENT, ...extra })
/** 子派发（run_code 内部）：带 parent + 同一个 rootCallId。 */
const subExec = (name, callId, rootCallId, extra = {}) => ({
  callId,
  rootCallId,
  name,
  arguments: {},
  agent: AGENT,
  parent: Symbol('parent-token'),
  ...extra
})

const failed = (message = 'boom', info) => ({
  isError: true,
  error: { message, ...(info === undefined ? {} : { info }) },
  content: []
})

async function reportOf(built, exec = { agent: AGENT, callId: 'report-call' }) {
  const value = await built.tool.execute({}, exec)
  assert.equal(typeof value.text, 'string')
  assert.equal(typeof value.steps, 'number')
  return value
}

test('报表自己还在跑时显示「进行中」，不是「成功 0」', async () => {
  const built = harness()
  // 宿主先发 pre-execute，再进工具体；result 要等工具返回之后才有。
  built.pre(rootExec('teach_report', 'report-call'))
  const value = await reportOf(built)
  assert.match(value.text, /teach_report×1（成功 0、失败 0、进行中 1）/)
  assert.doesNotMatch(value.text, /teach_report×1（成功 0）/)
  assert.equal(value.steps, 1)
  // 结果落地之后就不再是进行中
  built.res(rootExec('teach_report', 'report-call'), { isError: false, value: {}, content: [] })
  const after = await reportOf(built, { agent: AGENT, callId: 'report-call-2' })
  assert.match(after.text, /teach_report×1（成功 1）/)
})

test('失败按树去重：14 次报错 = 8 棵树（6 次嵌套 + 父调用各记一次）', async () => {
  const built = harness()
  for (let index = 0; index < 8; index += 1) {
    const rootCallId = `root-${index}`
    built.pre(rootExec('run_code', rootCallId))
    if (index < 6) {
      const sub = subExec('write', `${rootCallId}:ptc:1`, rootCallId, { arguments: { file_path: `lessons/${index}.html` } })
      built.pre(sub)
      built.res(sub, failed('write failed'))
      built.res(rootExec('run_code', rootCallId), failed('program threw: write failed'))
    } else {
      built.res(rootExec('run_code', rootCallId), failed('program threw'))
    }
  }
  const value = await reportOf(built)
  assert.match(value.text, /其中 14 次调用报错\/被拒，来自 8 棵树（同一次事故的嵌套与父调用算一棵）/)
  // 每棵树只记第一次失败的工具名：6 棵先死在嵌套 write，2 棵先死在 run_code
  assert.match(value.text, /最先失败的是：write×6、run_code×2/)
  assert.match(value.text, /run_code×8（成功 0、失败 8、进行中 0）/)
  assert.match(value.text, /write×6（成功 0、失败 6、进行中 0）/)
  // 步与子调用的分法不变：8 次根调用 + 6 次子派发
  assert.equal(value.steps, 8)
  assert.match(value.text, /8 步（根调用）· 6 个子调用/)
})

test('被 auto 审查拒掉的调用没进 calls，但失败仍要算，且 pending 不能变成负数', async () => {
  const built = harness()
  // pre-execute 在 auto-review 里就被拒了：账本没看到这次调用，但 result 会来。
  built.res(
    { callId: 'never-seen', rootCallId: 'root-x', name: 'write', arguments: {}, agent: AGENT },
    failed('Auto review of tool "write" failed; its body was not executed: TLS reset')
  )
  const value = await reportOf(built)
  assert.match(value.text, /来自 1 棵树/)
  assert.match(value.text, /最先失败的是：write×1/)
  // 没有调用记录的失败要单独说明，免得「调用分布」看起来自相矛盾
  assert.match(value.text, /另有 1 次失败没有对应的调用记录（pre-execute 就被拒了：auto 审查或闸门）/)
  assert.doesNotMatch(value.text, /进行中 -/)
  assert.doesNotMatch(value.text, /失败 -/)
})

test('同一文件被绝对路径与相对路径各写过时，表里只有一行（次数相加）', async () => {
  const ws = tempWorkspace()
  try {
    const built = harness({ workspaceOf: () => ws })
    const calls = [
      { callId: 'w1', name: 'write', arguments: { file_path: path.join(ws, 'lessons/one.html') } },
      { callId: 'w2', name: 'write', arguments: { file_path: 'lessons/one.html' } },
      { callId: 'e1', name: 'edit', arguments: { file_path: 'lessons/one.html' } }
    ]
    for (const call of calls) {
      built.pre({ ...call, agent: AGENT })
      built.res({ ...call, agent: AGENT }, { isError: false, value: {}, content: [] })
    }
    const past = new Date(Date.now() - 3600_000)
    for (const relative of ['assets/course.css', 'NOTES.md', 'notes-old.md']) {
      fs.utimesSync(path.join(ws, relative), past, past)
    }
    const value = await reportOf(built)
    assert.match(value.text, /lessons\/one\.html：写 2 次、改 1 次/)
    assert.equal(value.text.split('lessons/one.html：').length - 1, 1)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('auto 审查通道的失败/拒绝单独点名', async () => {
  const built = harness()
  built.pre(rootExec('run_code', 'r1'))
  const writeExec = subExec('write', 'r1:ptc:1', 'r1')
  built.pre(writeExec)
  built.res(writeExec, failed('Auto review of tool "write" failed; its body was not executed: TLS handshake timeout'))
  const bashExec = subExec('bash', 'r1:ptc:2', 'r1')
  built.pre(bashExec)
  built.res(
    bashExec,
    failed('Auto review rejected tool "bash"; its body was not executed', { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' })
  )
  built.res(rootExec('run_code', 'r1'), failed('program threw'))
  const value = await reportOf(built)
  assert.match(value.text, /其中 3 次调用报错\/被拒，来自 1 棵树/)
  assert.match(value.text, /其中 2 次是 auto 权限的审查通道吞掉\/拒绝的（不是你写错）/)
  assert.match(value.text, /\/permission/)
})

test('目标形状四象限：只有「成片 1 次且成功 + still 全过」才配这句话', () => {
  const none = renderShapeLines({ renders: 0, renderOk: 0, stills: 0, stillOk: 0 }).join('\n')
  assert.match(none, /没有渲染或 still 记录/)
  assert.doesNotMatch(none, /目标形状/)

  // 渲一次但没有 still 预检：盲渲
  const noStill = renderShapeLines({ renders: 1, renderOk: 1, stills: 0, stillOk: 0 }).join('\n')
  assert.match(noStill, /没有 still 预检记录/)
  assert.doesNotMatch(noStill, /目标形状/)

  // 渲一次但 still 9/10：不能说目标形状
  const stillFailed = renderShapeLines({ renders: 1, renderOk: 1, stills: 10, stillOk: 9 }).join('\n')
  assert.match(stillFailed, /still 有失败：尝试 10 次、成功 9 次/)
  assert.doesNotMatch(stillFailed, /目标形状/)

  // 重渲
  const reRender = renderShapeLines({ renders: 3, renderOk: 2, stills: 4, stillOk: 4 }).join('\n')
  assert.match(reRender, /重渲了 3 次/)
  assert.doesNotMatch(reRender, /目标形状/)

  // 渲一次但失败
  const renderFailed = renderShapeLines({ renders: 1, renderOk: 0, stills: 2, stillOk: 2 }).join('\n')
  assert.match(renderFailed, /渲染了一次但没成功/)
  assert.doesNotMatch(renderFailed, /目标形状/)

  // 只有 still、还没成片
  const stillOnly = renderShapeLines({ renders: 0, renderOk: 0, stills: 5, stillOk: 5 }).join('\n')
  assert.match(stillOnly, /还没有渲成片/)
  assert.doesNotMatch(stillOnly, /目标形状/)

  // 唯一的「目标形状」
  const target = renderShapeLines({ renders: 1, renderOk: 1, stills: 4, stillOk: 4 }).join('\n')
  assert.match(target, /这就是目标形状/)
})

test('looksLikeScriptWrite：认脚本/重定向/原地改文件，不把只读命令算成改动', () => {
  for (const command of [
    'python3 /tmp/build_lesson.py',
    'python /tmp/x.py --out lessons/one.html',
    'node scripts/gen.mjs',
    'bash push.sh',
    "sed -i '' 's/a/b/' lessons/one.html",
    'echo hi > lessons/one.html',
    'cat a.html >> lessons/one.html',
    'cat a | tee lessons/one.html',
    'cp assets/a.css assets/b.css',
    'mv old.html lessons/new.html',
    'rm lessons/tmp.html'
  ]) {
    assert.equal(looksLikeScriptWrite(command), true, command)
  }
  for (const command of [
    'ls -la',
    'git status',
    'grep -n foo lessons/one.html',
    'sed -n 1,5p lessons/one.html',
    'cat lessons/one.html',
    'echo hi > /dev/null',
    'python3 -c "print(1)"',
    'node --version'
  ]) {
    assert.equal(looksLikeScriptWrite(command), false, command)
  }
})

function tempWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-ledger-'))
  for (const dir of ['lessons', 'assets', '.dsh-teach-me/archive', 'node_modules/pkg']) {
    fs.mkdirSync(path.join(ws, dir), { recursive: true })
  }
  const files = {
    'lessons/one.html': 'one',
    'assets/course.css': 'css',
    'NOTES.md': '# notes',
    'notes-old.md': '# old',
    '.dsh-teach-me/archive/index.json': '{}',
    'node_modules/pkg/index.js': 'x'
  }
  for (const [relative, content] of Object.entries(files)) fs.writeFileSync(path.join(ws, relative), content)
  return ws
}

test('scanTouchedFiles：只收会话内改过、非点号目录、非依赖目录的普通文件', () => {
  const ws = tempWorkspace()
  try {
    const past = Date.now() - 3600_000
    for (const relative of ['notes-old.md']) {
      fs.utimesSync(path.join(ws, relative), new Date(past), new Date(past))
    }
    const touched = scanTouchedFiles(ws, Date.now() - 60_000)
    assert.deepEqual(touched, ['NOTES.md', 'assets/course.css', 'lessons/one.html'])
    // 早于会话开始的文件不算
    assert.equal(scanTouchedFiles(ws, Date.now() + 60_000).length, 0)
    // 目录不存在时不抛
    assert.deepEqual(scanTouchedFiles(path.join(ws, 'no-such-dir'), 0), [])
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('脚本改动：数 bash 里的脚本调用，并用 mtime 把「哪些文件被改过」补进同一张表', async () => {
  const ws = tempWorkspace()
  try {
    const built = harness({ workspaceOf: () => ws })
    const pre = built.pre
    const res = built.res
    // 一次正常 write + 一次跑脚本的 bash（脚本本身在 /tmp，改的是工作区里的文件）
    pre({ callId: 'w1', name: 'write', arguments: { file_path: path.join(ws, 'lessons/one.html') }, agent: AGENT })
    res({ callId: 'w1', name: 'write', arguments: { file_path: path.join(ws, 'lessons/one.html') }, agent: AGENT }, { isError: false, value: {}, content: [] })
    pre({ callId: 'b1', name: 'bash', arguments: { command: 'python3 /tmp/build_lesson.py' }, agent: AGENT })
    res(
      { callId: 'b1', name: 'bash', arguments: { command: 'python3 /tmp/build_lesson.py' }, agent: AGENT },
      { isError: false, value: {}, content: [] }
    )
    // 明确 mtime：脚本确实改了这两个文件；notes-old.md 是上一课的、lessons/one.html 已用 write 记过，
    // 都设成过去，确保归因只来自这次脚本。
    const future = new Date(Date.now() + 5000)
    const past = new Date(Date.now() - 3600_000)
    for (const relative of ['assets/course.css', 'NOTES.md']) fs.utimesSync(path.join(ws, relative), future, future)
    for (const relative of ['notes-old.md', 'lessons/one.html']) fs.utimesSync(path.join(ws, relative), past, past)
    const value = await reportOf(built)
    assert.match(value.text, /另 1 次在 bash 里跑脚本\/重定向改文件/)
    // 已经用 write 记过的文件不重复出现成「脚本改过」
    assert.match(value.text, /lessons\/one\.html：写 1 次、改 0 次/)
    assert.match(value.text, /assets\/course\.css：写 0 次、改 0 次（脚本改过，次数未知，按 mtime 归因）/)
    assert.match(value.text, /NOTES\.md：写 0 次、改 0 次（脚本改过/)
    assert.equal(value.text.includes('notes-old.md'), false)
    assert.equal(value.text.includes('node_modules'), false)
    assert.equal(value.text.includes('.dsh-teach-me'), false)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('editBudget 参考线：已知次数超标要点名，脚本归因按「至少 1 次」参与', async () => {
  const ws = tempWorkspace()
  try {
    const built = harness({ config: configOf({ ledger: { editBudget: 1 } }), workspaceOf: () => ws })
    const pagePath = path.join(ws, 'lessons/one.html')
    for (const callId of ['w1', 'w2']) {
      built.pre({ callId, name: 'write', arguments: { file_path: pagePath }, agent: AGENT })
      built.res({ callId, name: 'write', arguments: { file_path: pagePath }, agent: AGENT }, { isError: false, value: {}, content: [] })
    }
    built.pre({ callId: 'b1', name: 'bash', arguments: { command: 'sed -i s/a/b/ assets/course.css' }, agent: AGENT })
    built.res({ callId: 'b1', name: 'bash', arguments: { command: 'sed -i s/a/b/ assets/course.css' }, agent: AGENT }, { isError: false, value: {}, content: [] })
    const future = new Date(Date.now() + 5000)
    const past = new Date(Date.now() - 3600_000)
    fs.utimesSync(path.join(ws, 'assets/course.css'), future, future)
    for (const relative of ['NOTES.md', 'notes-old.md']) fs.utimesSync(path.join(ws, relative), past, past)
    const value = await reportOf(built)
    assert.match(value.text, /超过单文件 1 次参考线：lessons\/one\.html\(2\)（脚本改过的文件按至少 1 次算）/)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('只有脚本改动、没有超标的单文件：明确说「次数偏低」，不假装账本很干净', async () => {
  const ws = tempWorkspace()
  try {
    const built = harness({ workspaceOf: () => ws })
    built.pre({ callId: 'b1', name: 'bash', arguments: { command: 'python3 /tmp/build.py' }, agent: AGENT })
    built.res({ callId: 'b1', name: 'bash', arguments: { command: 'python3 /tmp/build.py' }, agent: AGENT }, { isError: false, value: {}, content: [] })
    const future = new Date(Date.now() + 5000)
    const past = new Date(Date.now() - 3600_000)
    for (const relative of ['assets/course.css', 'NOTES.md']) fs.utimesSync(path.join(ws, relative), future, future)
    for (const relative of ['lessons/one.html', 'notes-old.md']) fs.utimesSync(path.join(ws, relative), past, past)
    const value = await reportOf(built)
    assert.match(value.text, /单文件都没过 8 次参考线；但上表有文件没被 write\/edit 记过（次数未知）/)
    assert.doesNotMatch(value.text, /超过单文件/)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('拿不到教学根时脚本改动仍计数，但明确说「没做 mtime 归因」', async () => {
  const built = harness({
    workspaceOf: () => {
      throw new Error('no workspace')
    }
  })
  built.pre({ callId: 'b1', name: 'bash', arguments: { command: 'python3 /tmp/x.py' }, agent: AGENT })
  built.res({ callId: 'b1', name: 'bash', arguments: { command: 'python3 /tmp/x.py' }, agent: AGENT }, { isError: false, value: {}, content: [] })
  const value = await reportOf(built)
  assert.match(value.text, /另 1 次在 bash 里跑脚本/)
  assert.match(value.text, /这次也没拿到教学根做 mtime 对照/)
})

test('渲染/still 计数沿用原口径：teach_animation_render 与 bash 里的 remotion 都算', async () => {
  const built = harness()
  const stillCall = { callId: 'a1', name: 'teach_animation_render', arguments: { mode: 'still', frame: 90 }, agent: AGENT }
  built.pre(stillCall)
  built.res(stillCall, { isError: false, value: {}, content: [] })
  const renderCall = { callId: 'a2', name: 'teach_animation_render', arguments: { mode: 'render' }, agent: AGENT }
  built.pre(renderCall)
  built.res(renderCall, { isError: false, value: {}, content: [] })
  const value = await reportOf(built)
  assert.match(value.text, /渲染 1 次（成功 1），still 预检 1 次（成功 1） —— 这就是目标形状/)
})

test('关了账本就不注册监听（attach 直接返回）', () => {
  const config = configOf({ ledger: { enabled: false } })
  const registered = []
  const listeners = []
  const ledger = createLedger(() => config)
  ledger.attach({
    on: (event) => {
      listeners.push(event)
      return () => {}
    },
    get: () => ({ register: (definition) => { registered.push(definition); return () => {} } }),
    effect: (factory) => factory()
  })
  assert.deepEqual(listeners, [])
})
