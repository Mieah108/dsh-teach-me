import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/* 文案表与错误码表是「界面能不能说人话」的契约，最容易在改动里悄悄漏一条：
 * 中文加了、英文没加；代码里 t("x") 用了、表里没有；错误码换了没人翻。
 * 这里用导出的 copy / classroomHelpers 把这三件事钉住，不靠人肉读代码。 */

let clientExports
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      clientExports = entry.factory((name) => {
        if (name !== 'react') throw new Error('unexpected require: ' + name)
        return {}
      })
    }
  }
}

async function loadClient() {
  if (clientExports === undefined) await import('../../client.js')
  return clientExports
}

const sourcePath = new URL('../../client.js', import.meta.url)

test('中英文案表键集完全一致（漏一条翻译就是英文界面里的乱码）', async () => {
  const { copy } = await loadClient()
  const zh = Object.keys(copy.zh).sort()
  const en = Object.keys(copy.en).sort()
  assert.deepEqual(en, zh)
})

test('代码里 t("…") 用到的每个键都在两张表里', async () => {
  const { copy } = await loadClient()
  const source = fs.readFileSync(sourcePath, 'utf8')
  // 注释里也会出现 t("...") 这种举例写法，跳过整行注释再扫。
  const code = source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
    })
    .join('\n')
  const used = new Set()
  for (const match of code.matchAll(/\b(?:t|tr)\("([^"]+)"\)/g)) used.add(match[1])
  // 页面标题、页签指南这类文案走 ctx.locale.bind(NS)("key")：只扫 t() 会漏掉它们。
  for (const match of code.matchAll(/\bbind\([^)]*\)\("([^"]+)"\)/g)) used.add(match[1])
  assert.ok(used.size > 20, '没扫到足够多的取词调用，正则可能失效了')
  assert.ok(used.has('coursesIntro'), 'bind(NS)("…") 那一路没被扫到')
  const missing = [...used].filter((key) => !(key in copy.zh) || !(key in copy.en))
  assert.deepEqual(missing, [], '这些键在代码里用了，文案表里没有：' + missing.join(', '))
})

test('错误码表的每条说明都是完整的一句话，不是占位符', async () => {
  const { copy } = await loadClient()
  for (const [table, name] of [[copy.zh, 'zh'], [copy.en, 'en']]) {
    const codes = Object.keys(table).filter((key) => key.startsWith('code.'))
    assert.ok(codes.length >= 15, `${name} 表里的错误码太少，码表可能没落进来`)
    for (const key of codes) {
      const value = table[key]
      assert.equal(typeof value, 'string')
      assert.ok(value.trim().length >= 4, `${name}.${key} 太短：${value}`)
      assert.doesNotMatch(value, /TODO|FIXME|键/, `${name}.${key} 是占位符：${value}`)
    }
  }
})

test('fill：只换认得的占位符，未知的原样留着', async () => {
  const { classroomHelpers } = await loadClient()
  const { fill } = classroomHelpers
  assert.equal(fill('HTTP {status}', { status: 401 }), 'HTTP 401')
  assert.equal(fill('新增 {imported}，跳过 {skipped}', { imported: 3, skipped: 1 }), '新增 3，跳过 1')
  assert.equal(fill('{a} 和 {b}', { a: 'x' }), 'x 和 {b}')
  assert.equal(fill('{a}', null), '{a}')
  assert.equal(fill('没有占位符', { a: 1 }), '没有占位符')
})

test('classroomErrorText：认识的码翻成当前语言，不认识的码保住真实原因', async () => {
  const { classroomHelpers, copy } = await loadClient()
  const { errorText } = classroomHelpers
  const t = (key) => copy.zh[key] ?? key

  // 认识的码：走码表，不把服务端的中文句子直接抛给用户
  assert.equal(errorText(t, { code: 'lesson-not-found', message: '这个地址不在已发布课程清单里' }), copy.zh['code.lesson-not-found'])
  assert.equal(errorText(t, { code: 'import-too-many', message: '一次最多导入 200 条' }), copy.zh['code.import-too-many'])

  // 不认识的码：宁可读到原始消息，也不要丢掉真实原因
  const unknown = (key) => (key === 'code.weird-code' ? key : copy.zh[key] ?? key)
  assert.equal(errorText(unknown, { code: 'weird-code', message: '服务端原话' }), '服务端原话')

  // 连消息都没有：退回码本身，再退回字符串
  assert.equal(errorText(unknown, { code: 'weird-code' }), 'weird-code')
  assert.equal(errorText(t, null), 'null')
})

test('文案表里没有残留的硬编码中文标点拼接', async () => {
  const source = fs.readFileSync(sourcePath, 'utf8')
  // 「已刷新：题目 4 · 待批改 1」这类拼接允许用 ▸ 与 · ，但中文全角冒号只应出现在文案表里
  const offenders = source
    .split('\n')
    .map((line, index) => ({ line: line.trim(), index: index + 1 }))
    .filter((entry) => /\+ "：|"："/.test(entry.line))
  assert.deepEqual(offenders, [])
  assert.ok(path.basename(sourcePath.pathname) === 'client.js')
})
