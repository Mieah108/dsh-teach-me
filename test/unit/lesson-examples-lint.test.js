import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { lintFile } from '../../lib/lint.js'

// 随包例课是「新规则不许误报」的护栏：它们是拿来直接打开看的，必须零硬伤零提醒。
const examples = new URL('../../templates/examples/lessons/', import.meta.url)
const skeleton = new URL('../../templates/lesson.html', import.meta.url)

const lintOf = (url) => {
  const file = decodeURIComponent(url.pathname)
  return lintFile(fs.readFileSync(url, 'utf8'), file)
}

for (const name of ['components.html', 'reuse.html']) {
  test(`随包例课 ${name} 零硬伤零提醒`, () => {
    const issues = lintOf(new URL(name, examples))
    assert.deepEqual(
      issues.map((issue) => `${issue.line} ${issue.level} ${issue.code}`),
      [],
      JSON.stringify(issues, null, 2)
    )
  })
}

test('骨架 lesson.html 不触发结构硬伤（它本来就该只有占位符和缺资源）', () => {
  const issues = lintOf(skeleton)
  const codes = new Set(issues.map((issue) => issue.code))
  assert.equal(codes.has('goals-duplicate-title'), false, JSON.stringify(issues))
  assert.equal(codes.has('shell-without-sidenav'), false, JSON.stringify(issues))
  assert.equal(codes.has('sidenav-not-first'), false, JSON.stringify(issues))
  assert.equal(codes.has('toc-entry-mismatch'), false, JSON.stringify(issues))
  assert.equal(codes.has('toc-label-drift'), false, JSON.stringify(issues))
  // 骨架故意留着 〔…〕，它应该是硬伤；这条断言同时防止 placeholder 被误删
  assert.ok(codes.has('placeholder'), JSON.stringify(issues))
})
