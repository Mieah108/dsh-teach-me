import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ValidationError } from '../../lib/archive/errors.js'
import {
  archiveStatus,
  evaluateSubmission,
  gradeDeterministic,
  publishLesson,
  recordSubmission,
  registerQuestion,
  scanLocalAssets
} from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import { registerArchiveTools } from '../../lib/archive/tools.js'

/* 0.6.2 档案层的四处修补（对应 specs-0.6.2 的 #4 #5 #6 #8）：
 *   #5 幂等命中要回结论，不能只说「没重复记分」；
 *   #6 多选标准答案按集合判分（三种写法都认），单选口径不变；
 *   #4 评估链补「课程改版 / rubric 覆盖 / 确定性判分冲突」三道闸门；
 *   #8 发布扫描要跟着 CSS 依赖走（url()/@import 与 <style> 块）。 */

const PAGE = '<html><body>课</body></html>'

function workspace(html = PAGE) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-062-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), html)
  fs.writeFileSync(path.join(ws, 'assets', 'course.css'), 'body{}\n')
  return ws
}

function publish(ws, extra = {}) {
  return publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html', ...extra })
}

/* ————————————————————————— #5 幂等分支漏 verdict ————————————————————————— */

test('#5 幂等命中：同答案第二次提交带回 verdict=passed，status 与 assessmentId 不变', () => {
  const ws = workspace()
  publish(ws)
  registerQuestion(ws, {
    questionId: 'q1',
    lessonId: 'l1',
    type: 'choice',
    prompt: '选一个',
    options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
    answer: 'b'
  })
  const first = recordSubmission(ws, { questionId: 'q1', rawAnswer: 'b', source: 'chat' })
  assert.equal(first.verdict, 'passed')
  assert.equal(first.idempotent, false)

  const again = recordSubmission(ws, { questionId: 'q1', rawAnswer: 'b', source: 'chat' })
  assert.equal(again.idempotent, true)
  assert.equal(again.submissionId, first.submissionId)
  assert.equal(again.assessmentId, first.assessmentId)
  assert.equal(again.status, 'evaluated')
  assert.equal(again.verdict, 'passed')
  assert.equal(again.reason, '')
  assert.equal(again.questionRevision, 1)
  assert.equal(again.stale, false)
  assert.equal(again.staleReason, '')
  // 幂等命中不写档案
  assert.equal(archiveStatus(ws).summary.submissions, 1)
})

test('#5 幂等命中：还没评估的开放题回 verdict=null 加一句说明', () => {
  const ws = workspace()
  publish(ws)
  registerQuestion(ws, { questionId: 'q2', lessonId: 'l1', type: 'explanation', prompt: '解释机制' })
  const first = recordSubmission(ws, { questionId: 'q2', rawAnswer: '我的解释', source: 'chat' })
  assert.equal(first.verdict, null)

  const again = recordSubmission(ws, { questionId: 'q2', rawAnswer: '我的解释', source: 'chat' })
  assert.equal(again.idempotent, true)
  assert.equal(again.verdict, null)
  assert.equal(again.reason, '这次提交之前已经记过，还没有评估')
})

test('#5 工具输出契约：幂等命中新增的 verdict / stale / staleReason 都已在 output.schema 声明', async () => {
  const ws = workspace()
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (tool) => { registered.push(tool); return () => {} } }
      if (name === 'workingDirectory') return { get: () => ws }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    }
  }
  registerArchiveTools(ctx, { tools: { archive: true } }, () => ws)
  const tools = new Map(registered.map((tool) => [tool.name, tool]))
  const exec = { agent: { id: 'agent-1', session: { id: 'session-1' } } }

  await tools.get('teach_lesson_publish').execute({ path: 'lessons/one.html', lessonId: 'l1', title: '第一课' }, exec)
  await tools
    .get('teach_question_register')
    .execute({ questionId: 'q1', lessonId: 'l1', type: 'choice', prompt: '选', answer: 'b', options: [{ id: 'b' }] }, exec)
  await tools.get('teach_submission_record').execute({ questionId: 'q1', rawAnswer: 'b' }, exec)
  const replay = await tools.get('teach_submission_record').execute({ questionId: 'q1', rawAnswer: 'b' }, exec)
  assert.equal(replay.idempotent, true)
  assert.equal(replay.verdict, 'passed')
  assert.equal(replay.stale, false)

  const schema = tools.get('teach_submission_record').output.schema
  assert.deepEqual(schema.required, ['text', 'ok'])
  for (const key of Object.keys(replay)) {
    assert.ok(Object.hasOwn(schema.properties, key), 'output.schema 少声明了字段：' + key)
  }
  for (const key of ['verdict', 'stale', 'staleReason', 'questionRevision']) {
    assert.ok(Object.hasOwn(schema.properties, key), 'output.schema 少声明了 ' + key)
  }
})

/* ————————————————————————— #6 多选标准答案无法判分 ————————————————————————— */

test('#6 多选按集合判分：JSON 数组、英文逗号、中文顿号三种写法都认，顺序与重复无关', () => {
  const question = { type: 'choice', answer: ['a', 'b'] }
  assert.deepEqual(gradeDeterministic(question, 'a,b').expected, ['a', 'b'])
  for (const raw of ['a,b', '["a","b"]', 'a、b', ' b , a ', '["b", "a"]', 'a, a, b']) {
    assert.equal(gradeDeterministic(question, raw).correct, true, '应当判对：' + raw)
  }
  assert.equal(gradeDeterministic(question, 'a').correct, false)
  assert.equal(gradeDeterministic(question, 'a,b,c').correct, false)
  assert.equal(gradeDeterministic(question, 'b,a、c').correct, false)
})

test('#6 单选行为与 0.6.1 完全一致', () => {
  const question = { type: 'choice', answer: 'b' }
  assert.equal(gradeDeterministic(question, 'b').correct, true)
  assert.equal(gradeDeterministic(question, 'a').correct, false)
  assert.equal(gradeDeterministic(question, 'a,b').correct, false)
  // 含逗号的单选答案照旧逐字比较，不能被当成多选拆开
  assert.equal(gradeDeterministic({ type: 'choice', answer: '1,000' }, '1,000').correct, true)
  assert.deepEqual(gradeDeterministic(question, 'b').expected, ['b'])
})

test('#6 registerQuestion：choice 标准答案必须是字符串或非空字符串数组', () => {
  const ws = workspace()
  publish(ws)
  const base = { questionId: 'q-choice', lessonId: 'l1', type: 'choice', prompt: '选' }
  assert.throws(() => registerQuestion(ws, { ...base, answer: 42 }), ValidationError)
  assert.throws(() => registerQuestion(ws, { ...base, answer: { id: 'a' } }), ValidationError)
  assert.throws(() => registerQuestion(ws, { ...base, answer: null }), ValidationError)
  assert.throws(() => registerQuestion(ws, { ...base, answer: '   ' }), ValidationError)
  assert.throws(() => registerQuestion(ws, { ...base, answer: ['a', '  '] }), ValidationError)
  assert.throws(() => registerQuestion(ws, { ...base, answer: ['a', 1] }), ValidationError)
  assert.throws(() => registerQuestion(ws, { ...base, answer: [] }), ValidationError)

  // 数组 = 多选：trim + 去重后入库
  registerQuestion(ws, { ...base, answer: [' a ', 'b', 'a'] })
  assert.deepEqual(openArchive(ws).state.questions['q-choice'].answer, ['a', 'b'])
  // 字符串照旧
  registerQuestion(ws, { ...base, answer: 'a' })
  assert.equal(openArchive(ws).state.questions['q-choice'].answer, 'a')
})

/* ————————————————————————— #4 评估链补 rubric / 确定性 / 课程版本 ————————————————————————— */

test('#4 rubric 覆盖：criteria id 缺或多都转待复核，对上号才能通过', () => {
  const ws = workspace()
  publish(ws)
  registerQuestion(ws, {
    questionId: 'q-rub',
    lessonId: 'l1',
    type: 'explanation',
    prompt: '讲清机制与边界',
    rubric: [{ id: 'r1', text: '机制' }, { id: 'r2', text: '边界' }]
  })
  const record = recordSubmission(ws, { questionId: 'q-rub', rawAnswer: '我的解释', source: 'chat' })

  const invented = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'invented', met: true, evidence: '自造一条标准' }]
  })
  assert.equal(invented.verdict, 'needs_review')
  assert.match(invented.reason, /评分标准与题目登记的不一致/)
  assert.match(invented.reason, /缺 r1、r2/)
  assert.match(invented.reason, /多出 invented/)

  const partial = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'r1', met: true, evidence: '答案里说了连乘' }]
  })
  assert.equal(partial.verdict, 'needs_review')
  assert.match(partial.reason, /缺 r2/)

  const good = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [
      { id: 'r1', met: true, evidence: '答案里说了连乘' },
      { id: 'r2', met: true, evidence: '答案里说了梯度消失的边界' }
    ]
  })
  assert.equal(good.verdict, 'passed')
  assert.equal(archiveStatus(ws).summary.passed, 1)
})

test('#4 rubric 为空时不做覆盖校验（存量无 rubric 题目仍可人工评估）', () => {
  const ws = workspace()
  publish(ws)
  registerQuestion(ws, { questionId: 'q-plain', lessonId: 'l1', type: 'explanation', prompt: '解释一下' })
  const record = recordSubmission(ws, { questionId: 'q-plain', rawAnswer: '我的解释', source: 'chat' })
  const result = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'anything', met: true, evidence: '答案里说了因果' }]
  })
  assert.equal(result.verdict, 'passed')
})

test('#4 确定性冲突：标准答案判错却逐条全过 → 待复核；override 带理由才允许通过且留痕', () => {
  const ws = workspace()
  publish(ws)
  registerQuestion(ws, {
    questionId: 'q-det',
    lessonId: 'l1',
    type: 'choice',
    prompt: '选一个',
    options: [{ id: 'a' }, { id: 'b' }],
    answer: 'a'
  })
  const record = recordSubmission(ws, { questionId: 'q-det', rawAnswer: 'b', source: 'chat' })
  assert.equal(record.verdict, 'needs_practice')

  const conflict = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'c1', met: true, evidence: '写了一大段解释' }]
  })
  assert.equal(conflict.verdict, 'needs_review')
  assert.match(conflict.reason, /确定性判分与逐条标准不一致/)

  const overridden = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'c1', met: true, evidence: '老师确认这题答对了' }],
    method: { kind: 'override', reason: '老师改判' }
  })
  assert.equal(overridden.verdict, 'passed')
  assert.match(overridden.reason, /^人工覆盖：/)
  assert.match(overridden.reason, /老师改判/)

  // override 但没有理由：不算人工覆盖，仍然待复核
  const noReason = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'c1', met: true, evidence: '老师确认这题答对了' }],
    method: { kind: 'override' }
  })
  assert.equal(noReason.verdict, 'needs_review')

  // 逐条并不全过时，override 也不该把 needs_practice 抬成通过
  const partial = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'c1', met: false, evidence: '没做到' }],
    method: { kind: 'override', reason: '老师改判' }
  })
  assert.equal(partial.verdict, 'needs_practice')
})

test('#4 课程改版：重发升 revision 后评估旧提交 → 待复核', () => {
  const ws = workspace()
  publish(ws)
  registerQuestion(ws, { questionId: 'q-lesson', lessonId: 'l1', type: 'explanation', prompt: '讲清楚' })
  const record = recordSubmission(ws, { questionId: 'q-lesson', rawAnswer: '我的解释', source: 'chat' })
  assert.equal(openArchive(ws).state.lessons.l1.revision, 1)

  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), '<html><body>改过的课</body></html>')
  const republished = publish(ws)
  assert.equal(republished.lessonRevision, 2)

  const result = evaluateSubmission(ws, {
    submissionId: record.submissionId,
    criteria: [{ id: 'c', met: true, evidence: '答案里说了机制' }]
  })
  assert.equal(result.verdict, 'needs_review')
  assert.match(result.reason, /课程已改版/)
})

/* ————————————————————————— #8 发布扫描追踪 CSS 依赖 ————————————————————————— */

test('#8 CSS 依赖进清单：@import / url() 递归，<style> 块也算，带 sha256 与 size', () => {
  const ws = workspace()
  fs.writeFileSync(path.join(ws, 'assets', 'bg.svg'), '<svg></svg>')
  fs.writeFileSync(path.join(ws, 'assets', 'inline.png'), 'png-bytes')
  fs.writeFileSync(path.join(ws, 'assets', 'font.woff2'), 'woff2-bytes')
  fs.writeFileSync(path.join(ws, 'assets', 'theme.css'), '@font-face{src:url(font.woff2)}\n')
  fs.writeFileSync(path.join(ws, 'assets', 'course.css'), '@import "theme.css";\n.hero{background:url(bg.svg)}\n')
  const html = [
    '<html><head><link rel="stylesheet" href="../assets/course.css"></head><body>',
    '<style>body{background:url(../assets/inline.png)}</style>课</body></html>'
  ].join('')
  const lesson = path.join(ws, 'lessons', 'one.html')
  fs.writeFileSync(lesson, html)

  const assets = scanLocalAssets(ws, lesson, html)
  assert.deepEqual(assets.map((item) => item.path), [
    'assets/bg.svg',
    'assets/course.css',
    'assets/font.woff2',
    'assets/inline.png',
    'assets/theme.css'
  ])
  for (const item of assets) {
    assert.match(item.sha256, /^[0-9a-f]{64}$/)
    assert.equal(typeof item.size, 'number')
    assert.ok(item.size > 0)
  }
  const kinds = new Map(assets.map((item) => [item.path, item.kind]))
  assert.equal(kinds.get('assets/course.css'), 'link')
  for (const name of ['assets/bg.svg', 'assets/font.woff2', 'assets/inline.png', 'assets/theme.css']) {
    assert.equal(kinds.get(name), 'css', name + ' 是从样式表里带出来的')
  }

  // 发布也走同一条扫描：清单要进档案
  const published = publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
  assert.deepEqual(published.assets.map((item) => item.path), assets.map((item) => item.path))
})

test('#8 CSS 依赖递归有环也能停：互相 @import 两份样式表不会无限展开', () => {
  const ws = workspace()
  fs.writeFileSync(path.join(ws, 'assets', 'loop-a.css'), '@import "loop-b.css";\n')
  fs.writeFileSync(path.join(ws, 'assets', 'loop-b.css'), '@import "loop-a.css";\n')
  const html = '<html><head><link rel="stylesheet" href="../assets/loop-a.css"></head></html>'
  const lesson = path.join(ws, 'lessons', 'one.html')
  fs.writeFileSync(lesson, html)
  const assets = scanLocalAssets(ws, lesson, html)
  assert.deepEqual(assets.map((item) => item.path), ['assets/loop-a.css', 'assets/loop-b.css'])
})

test('#8 CSS 里的越界引用照旧报错；工作区内缺失的依赖只跳过', () => {
  const ws = workspace()
  fs.writeFileSync(path.join(ws, 'assets', 'escape.css'), '.x{background:url(../../outside.png)}\n')
  const lesson = path.join(ws, 'lessons', 'one.html')
  const escape = '<html><head><link rel="stylesheet" href="../assets/escape.css"></head></html>'
  fs.writeFileSync(lesson, escape)
  assert.throws(() => scanLocalAssets(ws, lesson, escape), ValidationError)

  // 缺失的依赖（工作区内）不报错，也不进清单
  fs.writeFileSync(path.join(ws, 'assets', 'missing.css'), '.x{background:url(not-there.png)}\n')
  const missing = '<html><head><link rel="stylesheet" href="../assets/missing.css"></head></html>'
  fs.writeFileSync(lesson, missing)
  assert.deepEqual(scanLocalAssets(ws, lesson, missing).map((item) => item.path), ['assets/missing.css'])
})

test('#8 CSS 依赖也不收录点号目录（答案文件不能被样式表带进清单）', () => {
  const ws = workspace()
  fs.mkdirSync(path.join(ws, '.dsh-teach-me', 'archive'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.dsh-teach-me', 'archive', 'index.json'), '{"answers":["A"]}')
  fs.writeFileSync(path.join(ws, 'assets', 'peek.css'), '.x{background:url(../.dsh-teach-me/archive/index.json)}\n')
  const html = '<html><head><link rel="stylesheet" href="../assets/peek.css"></head></html>'
  const lesson = path.join(ws, 'lessons', 'one.html')
  fs.writeFileSync(lesson, html)
  assert.deepEqual(scanLocalAssets(ws, lesson, html).map((item) => item.path), ['assets/peek.css'])
})

test('#8 CSS 递归有深度上限：超过 8 层的链不再展开', () => {
  const ws = workspace()
  const names = []
  for (let index = 0; index <= 12; index += 1) names.push('chain-' + index + '.css')
  names.forEach((name, index) => {
    const next = names[index + 1]
    fs.writeFileSync(path.join(ws, 'assets', name), next === undefined ? '.x{color:red}\n' : '@import "' + next + '";\n')
  })
  const html = '<html><head><link rel="stylesheet" href="../assets/chain-0.css"></head></html>'
  const lesson = path.join(ws, 'lessons', 'one.html')
  fs.writeFileSync(lesson, html)
  const paths = scanLocalAssets(ws, lesson, html).map((item) => item.path)
  assert.ok(paths.includes('assets/chain-8.css'), '上限内的最后一层应当在清单里：' + paths.join(','))
  assert.ok(!paths.includes('assets/chain-9.css'), '超过深度的链不该继续展开：' + paths.join(','))
})

/* ————————————————————————— 汇总口径 ————————————————————————— */

test('archiveStatus：passed 只数仍有效的结论，失效的进 stalePassed', () => {
  const ws = workspace()
  publish(ws)
  const question = { questionId: 'q-pass', lessonId: 'l1', type: 'choice', prompt: '选', options: [{ id: 'a' }], answer: 'a' }
  registerQuestion(ws, question)
  recordSubmission(ws, { questionId: 'q-pass', rawAnswer: 'a', source: 'chat' })
  assert.equal(archiveStatus(ws).summary.passed, 1)
  assert.equal(archiveStatus(ws).summary.stalePassed, 0)

  // 题目改版：旧评估不再算通过，但仍留在历史里
  registerQuestion(ws, { ...question, prompt: '改过的题面' })
  const summary = archiveStatus(ws).summary
  assert.equal(summary.passed, 0)
  assert.equal(summary.stalePassed, 1)
})
