import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TOKEN_BUCKETS,
  TOKEN_UNOBSERVABLE,
  createLedger,
  registerReportTool,
  tokenCostLine,
  tokenUsageOf,
  toolResultBytes
} from '../../lib/ledger.js'

/* A3：工具输出字节 / 轮次 / 失败与重试 / token 段。
 * 口径是硬的：字节一律 Buffer.byteLength(JSON.stringify(result), 'utf8')，
 * 中文与 emoji 必须按 UTF-8 计（不是 String.length）；token 读不到就逐字写「不可观测」，
 * 不猜、不换算；output.schema 不改（仍是 text + steps）。 */

const AGENT = { id: 'agent-bytes', session: { id: 'session-bytes' } }

function configOf({ ledger = {}, tools = {} } = {}) {
  return {
    ledger: { enabled: true, editBudget: 8, stepBudget: 120, ...ledger },
    tools: { report: true, ...tools }
  }
}

/**
 * 假上下文：tools.register / on / effect / get('sessionProjections')。
 * 与 test/unit/ledger.test.js 同构，多一个可注入的投影服务。
 */
function harness({ config = configOf(), projections } = {}) {
  const getConfig = () => config
  const registered = []
  const listeners = new Map()
  const ctx = {
    get: (name) => {
      if (name === 'tools') return { register: (definition) => { registered.push(definition); return () => {} } }
      if (name === 'sessionProjections') return projections
      return undefined
    },
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => {}
    },
    effect: (factory) => factory()
  }
  const ledger = createLedger(getConfig)
  ledger.attach(ctx)
  registerReportTool(ctx, getConfig, ledger, undefined, undefined)
  const tool = registered.find((entry) => entry.name === 'teach_report')
  return {
    ledger,
    tool,
    config,
    state: ledger.snapshot(AGENT.id),
    pre: (execution) => listeners.get('tools/pre-execute')(execution, () => ({ kind: 'allow' })),
    res: (execution, result) => listeners.get('tools/result')(execution, result)
  }
}

let callSeq = 0
/** 一次完整的调用 + 结果（根调用）。 */
function call(built, name, result, { args = {}, parent } = {}) {
  callSeq += 1
  const execution = {
    callId: 'bytes-' + callSeq,
    name,
    arguments: args,
    agent: AGENT,
    ...(parent === undefined ? {} : { parent: Symbol('parent-token'), rootCallId: 'root-bytes' })
  }
  built.pre(execution)
  built.res(execution, result)
  return execution
}

const ok = (value = {}) => ({ isError: false, value, content: [] })
const failed = (message = 'boom') => ({ isError: true, error: { message }, content: [] })

async function reportOf(built, exec = { agent: AGENT, callId: 'report-bytes' }) {
  const value = await built.tool.execute({}, exec)
  assert.equal(typeof value.text, 'string')
  assert.equal(typeof value.steps, 'number')
  return value
}

function top5Line(text) {
  const line = text.split('\n').find((entry) => entry.startsWith('- Top 5：'))
  assert.ok(line !== undefined, '报告里没有 Top 5 行：' + text)
  return line
}

test('字节按 UTF-8 计：中文与 emoji 用 Buffer.byteLength，不是 String.length', () => {
  const result = { isError: false, value: { text: '中文结论 😀 done' }, content: [] }
  const json = JSON.stringify(result)
  const utf8 = Buffer.byteLength(json, 'utf8')
  assert.ok(utf8 > json.length, 'UTF-8 字节应当大于 UTF-16 码元数：' + utf8 + ' vs ' + json.length)
  assert.equal(toolResultBytes(result), utf8)

  const built = harness()
  call(built, 'teach_status', result)
  assert.equal(built.state.outBytes.get('teach_status'), utf8)
  assert.equal(built.state.outResults.get('teach_status'), 1)
  // 明确钉住旧口径（String.length）会算小
  assert.notEqual(built.state.outBytes.get('teach_status'), json.length)
})

test('按工具名分组累加：同名多次相加，异名各记各的', () => {
  const built = harness()
  const first = { isError: false, value: { text: '第一条' }, content: [] }
  const second = { isError: false, value: { text: '第二条更长一点' }, content: [] }
  const other = { isError: false, value: { ok: true }, content: [] }
  call(built, 'teach_status', first)
  call(built, 'teach_status', second)
  call(built, 'lesson_lint', other)
  assert.equal(
    built.state.outBytes.get('teach_status'),
    Buffer.byteLength(JSON.stringify(first), 'utf8') + Buffer.byteLength(JSON.stringify(second), 'utf8')
  )
  assert.equal(built.state.outBytes.get('lesson_lint'), Buffer.byteLength(JSON.stringify(other), 'utf8'))
  assert.equal(built.state.outResults.get('teach_status'), 2)
  assert.equal(built.state.outResults.get('lesson_lint'), 1)
})

test('Top 5：只列前五，合计包含全部；报告写清字节口径', async () => {
  const built = harness()
  // 6 个工具，结果长度递增，最小的是 alpha
  for (const [name, filler] of [
    ['alpha', 'x'],
    ['bravo', 'x'.repeat(40)],
    ['charlie', 'x'.repeat(80)],
    ['delta', 'x'.repeat(120)],
    ['echo', 'x'.repeat(160)],
    ['foxtrot', 'x'.repeat(200)]
  ]) {
    call(built, name, { isError: false, value: { filler }, content: [] })
  }
  const value = await reportOf(built)
  const line = top5Line(value.text)
  for (const name of ['foxtrot', 'echo', 'delta', 'charlie', 'bravo']) assert.match(line, new RegExp(name), name + ' 应在 Top 5 里：' + line)
  assert.doesNotMatch(line, /alpha/, 'alpha 是第六大，不该出现在 Top 5：' + line)
  const total = [...built.state.outBytes.values()].reduce((sum, bytes) => sum + bytes, 0)
  assert.match(value.text, new RegExp('- 合计 ' + total + ' B，来自 6 次结果'))
  assert.match(value.text, /UTF-8 字节，口径 Buffer\.byteLength\(JSON\.stringify\(result\),'utf8'\)/)
})

test('失败回执同样计入字节；失败与重试分开计', async () => {
  const built = harness()
  const failure = failed('write failed')
  call(built, 'write', failure, { args: { file_path: 'lessons/one.html' } })
  call(built, 'write', failure, { args: { file_path: 'lessons/one.html' } })
  call(built, 'write', ok({ text: '写成' }), { args: { file_path: 'lessons/one.html' } })
  assert.equal(built.state.failures, 2)
  // 第 2、3 次都发生在失败之后 => 2 次重试
  assert.equal(built.state.retries, 2)
  assert.equal(built.state.retryByName.get('write'), 2)
  assert.equal(
    built.state.outBytes.get('write'),
    Buffer.byteLength(JSON.stringify(failure), 'utf8') * 2 + Buffer.byteLength(JSON.stringify(ok({ text: '写成' })), 'utf8')
  )
  const value = await reportOf(built)
  assert.match(value.text, /失败 2 次，失败后重试 2 次（write×2）/)
  assert.match(value.text, /决策步 \d+（根调用）\/ 子调用 \d+/)
})

test('token 读不到时逐字写固定文案，且不出现任何猜测数字', async () => {
  const built = harness()
  const value = await reportOf(built)
  assert.ok(value.text.includes(TOKEN_UNOBSERVABLE), '缺固定文案：' + value.text)
  assert.match(value.text, /^token：不可观测（宿主未向插件作用域暴露）$/m)
  assert.doesNotMatch(value.text, /未缓存输入/)
  assert.equal(tokenUsageOf(undefined, AGENT.session), undefined)
})

test('token 可读时四桶分开报（未缓存输入 / 输出 / 缓存读 / 缓存写）', async () => {
  const totals = { uncachedInputTokens: 1200, outputTokens: 345, cacheReadTokens: 5000, cacheWriteTokens: 700 }
  const built = harness({ projections: { stateOf: (session, key) => (key === 'tokenUsage' ? { totals, last: null } : undefined) } })
  const value = await reportOf(built)
  assert.doesNotMatch(value.text, /不可观测/)
  assert.ok(
    value.text.includes(
      'token：未缓存输入 1200 / 输出 345 / 缓存读 5000 / 缓存写 700'
    ),
    'token 段没按四桶写：' + value.text
  )
  assert.match(value.text, /token、字节、缓存、轮次是四类成本，不做换算/)
  assert.equal(tokenCostLine(totals).includes('缓存读 5000'), true)
})

test('stateOf 读不了时退回 snapshot 的 wire view；两个都读不到才算不可观测', () => {
  const totals = { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }
  const viaSnapshot = tokenUsageOf(
    {
      stateOf: () => {
        throw new Error('projection not registered')
      },
      snapshot: () => ({ values: { tokenUsage: totals } })
    },
    AGENT.session
  )
  assert.deepEqual(viaSnapshot, totals)

  const broken = tokenUsageOf(
    {
      stateOf: () => undefined,
      snapshot: () => ({ values: {} })
    },
    AGENT.session
  )
  assert.equal(broken, undefined)
  // 形状不对（缺桶 / 非数字）也不当作可观测
  assert.equal(tokenUsageOf({ stateOf: () => ({ totals: { uncachedInputTokens: 1 } }) }, AGENT.session), undefined)
})

test('没有会话或投影服务时 token 段安全降级，不影响报告其余部分', async () => {
  const built = harness({ projections: { stateOf: () => undefined } })
  const value = await reportOf(built, { callId: 'report-bytes' }) // 没有 agent.session
  assert.ok(value.text.includes(TOKEN_UNOBSERVABLE))
  assert.ok(value.text.includes('工具输出成本'))
})

test('结果无法 JSON 序列化时只跳过这一条字节，不抛错也不猜数字', async () => {
  const built = harness()
  const circular = { isError: false, value: { text: '圆形' }, content: [] }
  circular.value.self = circular
  assert.equal(toolResultBytes(circular), undefined)
  call(built, 'teach_status', circular)
  assert.equal(built.state.outBytes.has('teach_status'), false)
  const value = await reportOf(built)
  assert.match(value.text, /- 合计 0 B：还没有已结算的工具结果。/)
})

test('token 桶常量与 output.schema 不变：报告仍只回 text + steps', async () => {
  assert.deepEqual(TOKEN_BUCKETS, ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])
  const built = harness()
  const schema = built.tool.output.schema
  assert.deepEqual(schema.required, ['text', 'steps'])
  assert.deepEqual(Object.keys(schema.properties).sort(), ['steps', 'text'])
  assert.equal(schema.additionalProperties, false)
  const value = await reportOf(built)
  assert.deepEqual(Object.keys(value).sort(), ['steps', 'text'])
  // 未来若给 schema 加字段，这条会先红，提醒同步 tool-output-contract
  assert.equal(built.tool.parameters.additionalProperties, false)
})
