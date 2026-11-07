import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { registerArchiveTools } from '../../lib/archive/tools.js'
import { openArchive } from '../../lib/archive/store.js'
import { registerLintTool } from '../../lib/lint.js'
import { inlineLessonAssets } from '../../lib/classroom/offline.js'

/* E2：LessonSpec 进主干的接缝 —— teach_commit 直接吃 spec.json，题目从 spec 派生。
 *
 * 这些用例钉的是"发布链上的四个拒绝点"，不是编译器本身（编译器在 lessonspec.test.js）：
 *   1. 传 spec 且传 questions → 拒绝（题目只留一个来源）
 *   2. spec 不合法 → 拒绝，页面与档案都不写
 *   3. 编译出的页面有硬伤 → 拒绝，档案不写
 *   4. 正常路径 → 页面落盘、题目派生、幂等重放不重复写
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function fakeCtx() {
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (tool) => { registered.push(tool); return () => {} } }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    }
  }
  return { ctx, registered }
}

function specOf(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'spec-e2',
    meta: { serial: '0001', course: '课程 · 测试', eyebrow: '第 1 课', title: '测一课', lede: '一句话。' },
    sections: [
      { id: 's1', title: '一、正文', blocks: [{ kind: 'p', text: '一个段落。' }, { kind: 'callout', text: '一句提示。' }] },
      {
        id: 'check',
        kind: 'quiz',
        title: '验收',
        questions: [
          {
            questionId: 'q-e2-1',
            type: 'choice',
            prompt: '选一个？',
            scope: '口径：按本课说法。',
            options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
            answer: 'a'
          },
          { questionId: 'q-e2-2', type: 'explanation', prompt: '说说理由？', rubric: [{ id: 'r1', text: '给出理由' }] }
        ]
      }
    ],
    ...overrides
  }
}

/** 工作区带齐 assets：编译产物引用了 ../assets/*，缺资源 lint 会报 link-missing。 */
function harness() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-e2-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets', 'mathjax'), { recursive: true })
  for (const [from, to] of [
    ['course.css', 'assets/course.css'],
    ['course.js', 'assets/course.js'],
    ['mathjax/tex-svg.js', 'assets/mathjax/tex-svg.js']
  ]) {
    fs.copyFileSync(path.join(root, 'templates', from), path.join(ws, to))
  }
  const { ctx, registered } = fakeCtx()
  registerArchiveTools(ctx, { tools: { archive: true, commit: true } }, () => ws)
  registerLintTool(ctx, { tools: { lint: true } }, () => ws)
  return { ws, tools: new Map(registered.map((tool) => [tool.name, tool])), registered }
}

const EXEC = { agent: { session: { id: 's1' }, id: 'a1' } }

function writeSpec(ws, spec, name = 'lessons/one.spec.json') {
  fs.writeFileSync(path.join(ws, name), JSON.stringify(spec, null, 2))
  return name
}

const commitArgs = (specPath, extra = {}) => ({
  lessonId: 'lesson-e2',
  path: specPath,
  idempotencyKey: 'e2-key-1',
  ...extra
})

// G1 待执行回归：复用发布/离线链，不为新块另写资产收集器。
test('G1：媒体与本地来源进资产清单，dryRun 零写、重放幂等、离线内联', async () => {
  const { ws, tools } = harness()
  try {
    for (const name of ['plot.png', 'poster.png', 'clip.mp4']) fs.writeFileSync(path.join(ws, 'assets', name), 'fixture-' + name)
    fs.writeFileSync(path.join(ws, 'RESOURCES.md'), '本地来源')
    const spec = specOf()
    spec.sections[0].blocks.push(
      { kind: 'link', text: '原文', href: 'https://example.org/source' },
      { kind: 'link', text: '摘录', href: '../RESOURCES.md' },
      { kind: 'image', src: '../assets/plot.png', alt: '图' },
      { kind: 'video', src: '../assets/clip.mp4', poster: '../assets/poster.png', watch: '看投影', source: 'src/clip.tsx' }
    )
    const specPath = writeSpec(ws, spec)
    const dry = await tools.get('teach_commit').execute(commitArgs(specPath, { dryRun: true }), EXEC)
    assert.equal(dry.ok, true, dry.text)
    assert.equal(fs.existsSync(path.join(ws, 'lessons/one.html')), false)
    assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false)
    const first = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
    assert.equal(first.ok, true, first.text)
    const archive = openArchive(ws, { create: false })
    const lesson = archive.state.lessons['lesson-e2']
    for (const relative of ['assets/plot.png', 'assets/poster.png', 'assets/clip.mp4', 'RESOURCES.md']) {
      const asset = lesson.assets.find((item) => item.path === relative)
      assert.ok(asset, relative)
      assert.match(asset.sha256, /^[a-f0-9]{64}$/)
      assert.equal(asset.size, fs.statSync(path.join(ws, relative)).size)
    }
    const revision = archive.state.revision
    const replay = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
    assert.equal(replay.ok, true, replay.text)
    assert.equal(replay.idempotent, true)
    assert.equal(openArchive(ws, { create: false }).state.revision, revision)
    const html = fs.readFileSync(path.join(ws, 'lessons/one.html'), 'utf8')
    const offline = inlineLessonAssets(html, ws, lesson)
    assert.match(offline, /<img src="data:image\/png;base64,/)
    assert.match(offline, /<video src="data:video\/mp4;base64,/)
    assert.match(offline, /poster="data:image\/png;base64,/)
    assert.ok(offline.includes('href="https://example.org/source"'))
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('G1：缺图片、视频或海报时 lint 阻止 spec 提交', async () => {
  for (const block of [
    { kind: 'image', src: '../assets/missing.png', alt: '图' },
    { kind: 'video', src: '../assets/missing.mp4', watch: '看', source: 'src/clip.tsx' },
    { kind: 'video', src: '../assets/clip.mp4', poster: '../assets/missing.png', watch: '看', source: 'src/clip.tsx' }
  ]) {
    const { ws, tools } = harness()
    try {
      fs.writeFileSync(path.join(ws, 'assets/clip.mp4'), 'fixture')
      const spec = specOf()
      spec.sections[0].blocks.push(block)
      const result = await tools.get('teach_commit').execute(commitArgs(writeSpec(ws, spec)), EXEC)
      assert.equal(result.ok, false)
      assert.equal(result.error, 'lesson-spec-lint-failed')
      assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false)
    } finally {
      fs.rmSync(ws, { recursive: true, force: true })
    }
  }
})

test('G1：大于 8 MiB 的已有视频保留引用，海报仍可离线内联', async () => {
  const { ws, tools } = harness()
  try {
    fs.writeFileSync(path.join(ws, 'assets/large.mp4'), Buffer.alloc(8 * 1024 * 1024 + 1))
    fs.writeFileSync(path.join(ws, 'assets/poster.png'), 'poster-fixture')
    const spec = specOf()
    spec.sections[0].blocks.push({
      kind: 'video', src: '../assets/large.mp4', poster: '../assets/poster.png', watch: '看投影', source: 'src/clip.tsx'
    })
    const result = await tools.get('teach_commit').execute(commitArgs(writeSpec(ws, spec)), EXEC)
    assert.equal(result.ok, true, result.text)
    const lesson = openArchive(ws, { create: false }).state.lessons['lesson-e2']
    const html = fs.readFileSync(path.join(ws, 'lessons/one.html'), 'utf8')
    const offline = inlineLessonAssets(html, ws, lesson)
    assert.match(offline, /<video src="\.\.\/assets\/large.mp4"/)
    assert.match(offline, /poster="data:image\/png;base64,/)
    assert.equal(offline.includes('data:video/mp4;base64,'), false)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('spec 路线：编译产物落盘、题目从 spec 派生、幂等重放不重复写', async () => {
  const { ws, tools } = harness()
  const specPath = writeSpec(ws, specOf())

  const first = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
  assert.equal(first.ok, true, first.text)
  assert.equal(first.committed, true)
  assert.equal(first.lessonRevision, 1)
  assert.deepEqual(first.questionIds, ['q-e2-1', 'q-e2-2'], '题目必须从 spec 派生')
  assert.deepEqual(first.spec, { id: 'spec-e2', compiledPath: 'lessons/one.html' })

  const html = fs.readFileSync(path.join(ws, 'lessons/one.html'), 'utf8')
  assert.match(html, /<title>0001 · 测一课<\/title>/)
  assert.match(html, /data-question-id="q-e2-1"/)

  const archive = openArchive(ws, { create: false })
  assert.equal(archive.state.questions['q-e2-1'].type, 'choice')
  assert.equal(archive.state.questions['q-e2-2'].type, 'explanation')

  const replay = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
  assert.equal(replay.ok, true)
  assert.equal(replay.idempotent, true)
  assert.equal(replay.committed, false)
  assert.equal(replay.lessonRevision, 1)
})

test('spec 路线的 dryRun 零写：不落盘页面、不建档案，但照样报题目', async () => {
  const { ws, tools } = harness()
  const specPath = writeSpec(ws, specOf())
  const dry = await tools.get('teach_commit').execute(commitArgs(specPath, { dryRun: true }), EXEC)
  assert.equal(dry.ok, true, dry.text)
  assert.equal(dry.dryRun, true)
  assert.equal(dry.committed, false)
  assert.deepEqual(dry.questionIds, ['q-e2-1', 'q-e2-2'], '演练也要报出从 spec 派生的题目')
  assert.match(dry.text, /演练通过/)
  assert.equal(fs.existsSync(path.join(ws, 'lessons/one.html')), false, '演练不能落盘编译产物')
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false, '演练不能建档案')
  // 演练之后正式提交仍然正常：页面落盘、题目登记、revision 1
  const real = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
  assert.equal(real.ok, true, real.text)
  assert.equal(fs.existsSync(path.join(ws, 'lessons/one.html')), true)
  assert.equal(real.committed, true)
  assert.equal(real.lessonRevision, 1)
})

test('spec + questions 同时给：拒绝，且不写档案（题目只留一个来源）', async () => {
  const { ws, tools } = harness()
  const specPath = writeSpec(ws, specOf())
  const result = await tools
    .get('teach_commit')
    .execute(commitArgs(specPath, { questions: [{ questionId: 'lx', lessonId: 'lesson-e2', type: 'short', prompt: '问？', answer: '答' }] }), EXEC)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'lesson-spec-questions-conflict')
  assert.equal(fs.existsSync(path.join(ws, 'lessons/one.html')), false, '拒绝时不能落盘页面')
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false, '拒绝时不能建档案')
})

test('spec 不合法：拒绝，页面与档案都不写', async () => {
  const { ws, tools } = harness()
  const bad = specOf()
  bad.sections[0].blocks = [{ kind: 'p', text: '段', html: '<b>自由 HTML</b>' }]
  const specPath = writeSpec(ws, bad)
  const result = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'lesson-spec-invalid')
  assert.match(result.cause, /不认识的字段 html/)
  assert.equal(fs.existsSync(path.join(ws, 'lessons/one.html')), false)
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false)
})

test('编译出的页面有硬伤：拒绝，档案不写', async () => {
  const { ws, tools } = harness()
  // 〔〕占位符是 lint 硬伤（placeholder），但 schema 不管它 —— 正好测"schema 之后那道门"。
  const dirty = specOf()
  dirty.sections[0].blocks = [{ kind: 'p', text: '这里还留着〔01〕没换。' }]
  const specPath = writeSpec(ws, dirty)
  const result = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'lesson-spec-lint-failed')
  assert.match(result.cause, /placeholder/)
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false, 'lint 不通过时不能建档案')
})

test('lesson_lint 直接查 spec：合法 → 0 硬伤；非法 → 报成硬伤而不是崩', async () => {
  const { ws, tools } = harness()
  const goodPath = writeSpec(ws, specOf(), 'lessons/good.spec.json')
  const good = await tools.get('lesson_lint').execute({ paths: [goodPath] }, EXEC)
  assert.equal(good.errors, 0, good.text)
  assert.match(good.text, /good\.spec\.json/)

  const bad = specOf()
  bad.sections[0].blocks = [{ kind: 'weird', text: 'x' }]
  const badPath = writeSpec(ws, bad, 'lessons/bad.spec.json')
  const result = await tools.get('lesson_lint').execute({ paths: [badPath] }, EXEC)
  assert.equal(result.errors, 1, result.text)
  assert.match(result.text, /spec 不合法/)
})

test('目录扫描会把 *.spec.json 一起查（漏查 spec 等于漏查半个交付面）', async () => {
  const { ws, tools } = harness()
  writeSpec(ws, specOf(), 'lessons/scan.spec.json')
  const result = await tools.get('lesson_lint').execute({ paths: ['lessons'] }, EXEC)
  assert.equal(result.errors, 0, result.text)
  assert.match(result.text, /scan\.spec\.json/)
})

test('F2 spec发布同事务写目标；非法定义在编译产物之前拒绝', async () => {
  const { ws, tools } = harness()
  writeSpec(ws, specOf())
  const tool = tools.get('teach_commit')
  const bad = await tool.execute({ lessonId: 'l-goal', path: 'lessons/one.spec.json', idempotencyKey: 'bad-goal', objectives: ['o1'], objectiveDefinitions: [{ id: 'other', title: '非法关联' }] }, EXEC)
  assert.equal(bad.error, 'validation')
  assert.equal(fs.existsSync(path.join(ws, 'lessons/one.html')), false)
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false)
  const good = await tool.execute({ lessonId: 'l-goal', path: 'lessons/one.spec.json', idempotencyKey: 'good-goal', mission: '测试使命', objectives: ['o1'], objectiveDefinitions: [{ id: 'o1', title: '测试目标' }] }, EXEC)
  assert.equal(good.ok, true)
  const { readArchiveState } = await import('../../lib/archive/operations.js')
  assert.equal(readArchiveState(ws).objectives.o1.title, '测试目标')
})
test('资源越界时 lint 与 commit 同口径：不再出现「lint 0 硬伤、commit 才拒」', async () => {
  const { ws, tools } = harness()
  const outside = path.join(path.dirname(ws), 'outside-' + path.basename(ws) + '.png')
  try {
    fs.writeFileSync(outside, 'x')
    const spec = specOf()
    spec.sections[0].blocks.push({ kind: 'image', src: '../../' + path.basename(outside), alt: '越界图' })
    const specPath = writeSpec(ws, spec)
    const lint = await tools.get('lesson_lint').execute({ paths: [specPath] }, EXEC)
    assert.equal(lint.errors, 1, lint.text)
    assert.match(lint.text, /不在工作区内/)
    const commit = await tools.get('teach_commit').execute(commitArgs(specPath), EXEC)
    assert.equal(commit.ok, false)
    assert.equal(commit.error, 'validation')
  } finally {
    fs.rmSync(outside, { force: true })
    fs.rmSync(ws, { recursive: true, force: true })
  }
})
