import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { lintFile, lintMarkdown } from '../../lib/lint.js'

// 固定「今天」：规则本身按当前年月判断，测试不能跟着系统时钟漂。
const TODAY = new Date(2026, 9, 27) // 2026-10-27（本地时区，不受 UTC 偏移影响）
const NOTES = path.join('/tmp', 'workspace', 'NOTES.md')
const RECORD = path.join('/tmp', 'workspace', 'learning-records', '0001-prior-knowledge.md')
const LESSON = path.join('/tmp', 'workspace', 'lessons', '0001-demo.md')
const find = (issues, code) => issues.filter((issue) => issue.code === code)

test('学习记录里年份写错一年：提醒（诊断为 2026-10 的记录写成 2025-10）', () => {
  const text = '# 学习者画像\n\n## 学习者画像（2025-10 首次诊断）\n\n复数稳、DFT 只有印象。\n'
  const issues = lintMarkdown(text, NOTES, { today: TODAY })
  const drift = find(issues, 'date-year-drift')
  assert.equal(drift.length, 1, JSON.stringify(issues))
  assert.equal(drift[0].level, 'warn')
  assert.equal(drift[0].line, 3)
  assert.match(drift[0].message, /2025-10/)
  assert.match(drift[0].message, /2026-10/)
})

test('learning-records/ 下的记录同样查', () => {
  const text = '2025-10 首次诊断（三层问诊，一批问完）。\n'
  assert.equal(find(lintMarkdown(text, RECORD, { today: TODAY }), 'date-year-drift').length, 1)
})

test('日期是对的就不报：同年、引用年份、月份差得远、没写线索词', () => {
  const current = '## 第一课的落地决定（2026-10）\n'
  assert.equal(find(lintMarkdown(current, NOTES, { today: TODAY }), 'date-year-drift').length, 0)

  const citation = 'Randall & Antoni, MSSP 25 (2011) 485–520，本轮记录已核。\n'
  assert.equal(find(lintMarkdown(citation, NOTES, { today: TODAY }), 'date-year-drift').length, 0)

  const farMonth = '## 记录（2025-03）\n'
  assert.equal(find(lintMarkdown(farMonth, NOTES, { today: TODAY }), 'date-year-drift').length, 0)

  const noCue = '2025-10 天气不错。\n'
  assert.equal(find(lintMarkdown(noCue, NOTES, { today: TODAY }), 'date-year-drift').length, 0)
})

test('不是记录文件就不查日期（课程笔记里的年份可能真是历史）', () => {
  assert.equal(find(lintMarkdown('2025-10 首次诊断。\n', LESSON, { today: TODAY }), 'date-year-drift').length, 0)
})

test('lintFile 把 options 继续传下去', () => {
  const text = '2025-10 首次诊断。\n'
  assert.equal(find(lintFile(text, NOTES, { today: TODAY }), 'date-year-drift').length, 1)
  // 不传 options 时按真实时钟判断，不抛错即可
  assert.ok(Array.isArray(lintFile(text, NOTES)))
})

test('控制字符检查不回归（学习记录里的 \\theta 被吃掉）', () => {
  const tab = String.fromCharCode(9)
  const issues = lintMarkdown('公式 $' + tab + 'heta_i$。\n', RECORD, { today: TODAY })
  assert.ok(issues.some((issue) => issue.code === 'escaped-latex'), JSON.stringify(issues))
})
