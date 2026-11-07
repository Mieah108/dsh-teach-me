import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { transform } from 'esbuild'
import { parseData } from '../../ui/data.mjs'

const chartData = { title: '示例', type: 'column', data: { labels: ['A', 'B'], legends: ['用时'], series: [[40, 70]] } }

test('闪卡保留文字而不解释HTML，空题与空答案不能悄悄变成可用练习', () => {
  const data = parseData('flashcards', JSON.stringify({ cards: [{ front: '<b>问题</b>', back: '答案', hint: '先回想' }] }))
  assert.equal(data.cards[0].front, '<b>问题</b>')
  assert.throws(() => parseData('flashcards', '{"cards":[]}'), /闪卡/)
  assert.throws(() => parseData('flashcards', '{"cards":[{"front":"问题","back":""}]}'), /答案/)
  assert.throws(() => parseData('flashcards', 'not json'), SyntaxError)
})

test('时间线按作者给定顺序保留日期与说明，不推断事件次序', () => {
  const data = parseData('timeline', JSON.stringify({ events: [{ date: '第二步', title: '观察' }, { date: '第一步', title: '预测', description: '先想再看' }] }))
  assert.deepEqual(data.events.map((item) => item.title), ['观察', '预测'])
  assert.equal(data.events[0].description, '')
  assert.throws(() => parseData('timeline', '{"events":[null]}'), /标题/)
})

test('图表数据需有限且等长，控件必须对应实际数据并处于范围内', () => {
  assert.deepEqual(parseData('chart', JSON.stringify(chartData)).data.series, [[40, 70]])
  assert.throws(() => parseData('chart', JSON.stringify({ ...chartData, data: { ...chartData.data, series: [[40]] } })), /等长/)
  assert.throws(() => parseData('chart', JSON.stringify({ ...chartData, controls: [{ label: '值', min: 1, max: 10, dataIndex: 5 }] })), /位置/)
  assert.throws(() => parseData('chart', JSON.stringify({ ...chartData, controls: [{ label: '值', min: 1, max: 10, value: 20 }] })), /范围/)
  assert.throws(() => parseData('chart', JSON.stringify({ ...chartData, type: 'script' })), /类型/)
})

test('控件配置不能把任意字符串表达式送入图表执行', () => {
  const data = parseData('chart', JSON.stringify({ ...chartData, importedStyle: { series: [{ pointImages: { 0: 'https://example.invalid/image' } }] }, controls: [{ label: 'B', min: 20, max: 100, dataIndex: 1 }] }))
  assert.equal(data.importedStyle, undefined)
  assert.equal(data.controls[0].value, 70)
  assert.throws(() => parseData('chart', JSON.stringify({ ...chartData, controls: [{ label: 'B', min: 20, max: 100, dataIndex: 1, value: 'alert(1)' }] })), /范围/)
})

test('图表只接受其实际呈现的数据组，避免表格或控件更新了图中不存在的系列', () => {
  const more = { labels: ['A', 'B'], legends: ['甲', '乙', '丙'], series: [[1, 2], [2, 3], [3, 4]] }
  for (const type of ['pie', 'ring']) {
    assert.throws(() => parseData('chart', JSON.stringify({ type, data: more })), /只能有一组/)
    assert.throws(() => parseData('chart', JSON.stringify({ type, data: { labels: ['A'], legends: ['占比'], series: [[-1]] } })), /非负/)
    assert.throws(() => parseData('chart', JSON.stringify({ type, data: { labels: ['A'], legends: ['占比'], series: [[0]] } })), /大于零/)
    assert.throws(() => parseData('chart', JSON.stringify({ type, data: { labels: ['A'], legends: ['占比'], series: [[1]] }, controls: [{ label: 'A', min: -1, max: 2, value: 1 }] })), /负数/)
  }
  assert.throws(() => parseData('chart', JSON.stringify({ type: 'scatter', data: more })), /两组数据/)
  assert.throws(() => parseData('chart', JSON.stringify({ ...chartData, type: 'scatter' })), /两组数据/)
  const xy = parseData('chart', JSON.stringify({ type: 'scatter', data: { labels: ['点 A', '点 B'], legends: ['x', 'y'], series: [[1, 2], [3, 4]] } }))
  assert.deepEqual(xy.data.series, [[1, 2], [3, 4]])
})

test('滑块初始值遵守步长且一项数据只配置一个控件', () => {
  const control = { label: '值', min: 0, max: 10, step: 3, value: 10 }
  assert.throws(() => parseData('chart', JSON.stringify({ ...chartData, controls: [control] })), /步长对齐/)
  const aligned = { ...control, value: 9 }
  assert.throws(() => parseData('chart', JSON.stringify({ ...chartData, controls: [aligned, aligned] })), /重复配置/)
  const decimal = parseData('chart', JSON.stringify({ ...chartData, controls: [{ label: '小数', min: 0, max: 1, step: 0.1, value: 0.3 }] }))
  assert.equal(decimal.controls[0].value, 0.3)
})

test('OpenMAIC原件直接产生图表选项，百分比堆叠保留各序列比例', async () => {
  const source = fs.readFileSync(new URL('../../ui/upstream/openmaic/chartOption.ts', import.meta.url), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm' })
  const { getChartOption } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
  const ordinary = getChartOption({ ...chartData, type: 'bar', themeColors: ['#9c3524'] })
  assert.equal(ordinary.series[0].type, 'bar')
  assert.equal(ordinary.xAxis.data[1], 'B')
  const stacked = getChartOption({ type: 'column', data: { labels: ['A'], legends: ['甲', '乙'], series: [[3], [1]] }, themeColors: ['#9c3524'], stack: true, percentStack: true })
  assert.deepEqual(stacked.series.map((item) => item.data[0]), [0.75, 0.25])
  assert.equal(getChartOption({ type: 'invalid', data: chartData.data, themeColors: [] }), null)
})

test('来源原件具备固定提交、许可与可核验哈希，运行包附依赖声明', () => {
  const root = new URL('../../', import.meta.url)
  const manifest = JSON.parse(fs.readFileSync(new URL('ui/upstream/SOURCES.json', root)))
  assert.equal(manifest.assets.length, 6)
  for (const asset of manifest.assets) {
    assert.match(asset.commit, /^[a-f0-9]{40}$/)
    assert.ok(['Apache-2.0', 'MIT'].includes(asset.license))
    const bytes = fs.readFileSync(new URL(asset.local, root))
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
  }
  const notices = fs.readFileSync(new URL('templates/components/THIRD_PARTY_NOTICES.txt', root), 'utf8')
  for (const name of ['DeepTutor', 'OpenMAIC', 'react@', 'react-dom@', 'scheduler@', 'echarts@', 'zrender@', 'tslib@']) assert.ok(notices.includes(name), name)
})
