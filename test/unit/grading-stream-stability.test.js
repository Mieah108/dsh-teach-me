import assert from 'node:assert/strict'
import test from 'node:test'
import { callGradingModel, GRADING_MAX_REPLY_CHARS } from '../../lib/archive/grading.js'
const route = { provider: 'test', model: 'test' }

test('模型流忽略 signal 时仍按整体超时返回', async () => {
  const result = await Promise.race([
    callGradingModel({ route, timeoutMs: 20, llm: { stream: () => ({ [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}) }) } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('grading stuck')), 150))
  ])
  assert.equal(result.code, 'llm-timeout')
})

test('调用方取消可打断不响应 signal 的模型流', async () => {
  const controller = new AbortController()
  const done = callGradingModel({ route, timeoutMs: 200, signal: controller.signal, llm: { stream: () => ({ [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}) }) } })
  controller.abort()
  const result = await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('cancel stuck')), 100))])
  assert.equal(result.code, 'llm-aborted')
})

test('输出超过上限即停止消费，不等无限流结束', async () => {
  let reads = 0
  const result = await callGradingModel({ route, llm: { async *stream() {
    reads += 1
    yield { type: 'text-delta', text: 'x'.repeat(GRADING_MAX_REPLY_CHARS + 1) }
    reads += 1
    yield { type: 'text-delta', text: 'end' }
  } } })
  assert.equal(result.code, 'llm-too-long')
  assert.equal(reads, 1)
})
