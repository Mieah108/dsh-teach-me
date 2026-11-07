import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { compileSpec, DEFAULT_TEMPLATE } from '../../lib/lessonspec/compile.js'
import { LessonSpecError, validateSpec } from '../../lib/lessonspec/schema.js'
import { lintHtml } from '../../lib/lint.js'

test('G1：来源、图片和视频按正文顺序输出，文本转义且媒体没有自动播放', () => {
  const spec = minimalSpec()
  spec.sections[0].blocks = [
    { kind: 'link', text: '原文 <定义>', href: 'https://example.org/source?a=1&b=2' },
    { kind: 'image', src: '../assets/plot.png', alt: '"投影" <图>', caption: '<script>caption</script>' },
    { kind: 'video', src: '../assets/clip.mp4', poster: '../assets/poster.png', watch: '<看这里>', source: 'src/clip.tsx', caption: '再预测。' }
  ]
  const { html } = compileSpec(spec)
  assert.ok(html.indexOf('原文 &lt;定义&gt;') < html.indexOf('<img '))
  assert.ok(html.indexOf('<img ') < html.indexOf('<video '))
  assert.ok(html.includes('href="https://example.org/source?a=1&amp;b=2"'))
  assert.ok(html.includes('alt="&quot;投影&quot; &lt;图&gt;"'))
  assert.ok(html.includes('&lt;script&gt;caption&lt;/script&gt;'))
  assert.ok(html.includes('class="watch">看什么：&lt;看这里&gt;'))
  assert.ok(html.includes('class="source">源码：src/clip.tsx'))
  assert.match(html, /poster="\.\.\/assets\/poster.png" controls preload="metadata" playsinline/)
  assert.equal(html.includes('autoplay'), false)
  assert.equal(html.includes('<script>caption'), false)
  assert.equal(html, compileSpec(spec).html)
})

test('G1：本地来源与可选媒体字段，归一化不修改输入', () => {
  const spec = minimalSpec()
  spec.sections[0].blocks = [
    { kind: 'link', text: '摘录', href: '../RESOURCES.md' },
    { kind: 'image', src: './images/频谱.png', alt: '频谱' },
    { kind: 'video', src: '../assets/clip.mp4', watch: '看投影', source: 'src/clip.tsx' }
  ]
  const before = JSON.stringify(spec)
  const normalized = validateSpec(spec)
  assert.deepEqual(normalized.sections[0].blocks, spec.sections[0].blocks)
  assert.equal(JSON.stringify(spec), before)
  const { html } = compileSpec(spec)
  assert.ok(html.includes('href="../RESOURCES.md"'))
  assert.equal(html.includes('poster='), false)
})

test('G1：地址拒绝危险协议、远程媒体与解析歧义', () => {
  const invalid = [
    'javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', '//example.org/x', '/tmp/x',
    '../a\\b.png', '../a b.png', '../a\n.png', '../a\t.png', '../a\u00a0b.png',
    '../a%20b.png', '../a.png?x=1', '../a.png#x', '../a&b.png', '../a"b.png',
    '../.dsh-teach-me/archive/index.json', '../.secret', '../assets/', '..'
  ]
  for (const value of invalid) {
    for (const block of [{ kind: 'link', text: '来源', href: value }, { kind: 'image', src: value, alt: '图' }]) {
      const spec = minimalSpec()
      spec.sections[0].blocks = [block]
      assert.throws(() => validateSpec(spec), LessonSpecError, value)
    }
  }
  for (const block of [
    { kind: 'link', text: '来源', href: 'https://user:pass@example.org/x' },
    { kind: 'link', text: '来源', href: 'https://' },
    { kind: 'image', src: 'https://example.org/x.png', alt: '图' },
    { kind: 'video', src: 'https://example.org/x.mp4', watch: '看', source: 'src/x.tsx' },
    { kind: 'video', src: '../x.mp4', poster: 'https://example.org/x.png', watch: '看', source: 'src/x.tsx' }
  ]) {
    const spec = minimalSpec()
    spec.sections[0].blocks = [block]
    assert.throws(() => validateSpec(spec), LessonSpecError)
  }
})

test('G1：新块必填字段和字段隔离，拒绝事件、脚本和跨块字段', () => {
  for (const block of [
    { kind: 'link', href: 'https://example.org' },
    { kind: 'image', src: '../x.png' },
    { kind: 'video', src: '../x.mp4', watch: '看' },
    { kind: 'video', src: '../x.mp4', source: 'src/x.tsx' },
    { kind: 'image', src: '../x.png', alt: '图', onerror: 'alert(1)' },
    { kind: 'link', text: '来源', href: 'https://example.org', poster: '../x.png' },
    { kind: 'video', src: '../x.mp4', watch: '看', source: 'src/x.tsx', autoplay: true },
    { kind: 'p', text: '旧块', href: 'https://example.org' }
  ]) {
    const spec = minimalSpec()
    spec.sections[0].blocks = [block]
    assert.throws(() => validateSpec(spec), LessonSpecError)
  }
})

/* E1 实验分支：编译器只做模板拼装。
 * 这些用例证明两件事：① 产物能被现有 lint 直接接受；② 编译是确定性的（同 spec 同字节）。
 * 不在这里测"教学效果好"——那是实验 B 的事。 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function minimalSpec(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'spec-test',
    meta: { serial: '0001', course: '课程 · 测试', eyebrow: '第 1 课', title: '测一课', lede: '一句话说清。' },
    sections: [
      { id: 's1', title: '一、正文', blocks: [{ kind: 'p', text: '这是一个段落。' }] },
      {
        id: 'check',
        kind: 'quiz',
        title: '验收',
        questions: [
          {
            questionId: 'q-t1',
            type: 'choice',
            prompt: '选一个？',
            scope: '口径：只按本课说法。',
            explain: '这是解释。',
            options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
            answer: 'a'
          }
        ]
      }
    ],
    ...overrides
  }
}

/** 临时工作区：把模板运行资源摆好（真实教学工作区的常见布局），lint 才能判断依赖存在。 */
function workspaceWithAssets() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-e1-unit-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets', 'mathjax'), { recursive: true })
  for (const [from, to] of [
    ['course.css', 'assets/course.css'],
    ['course.js', 'assets/course.js'],
    ['mathjax/tex-svg.js', 'assets/mathjax/tex-svg.js']
  ]) {
    fs.copyFileSync(path.join(root, 'templates', from), path.join(ws, to))
  }
  return ws
}

test('编译产物能被 lesson_lint 直接接受（零硬伤）', () => {
  const ws = workspaceWithAssets()
  try {
    const { html } = compileSpec(minimalSpec())
    const issues = lintHtml(html, path.join(ws, 'lessons', 'e1-test.html'))
    const errors = issues.filter((issue) => issue.level === 'error')
    assert.deepEqual(
      errors.map((issue) => issue.code + ':' + issue.message),
      [],
      '编译产物在真实资源布局下不应有硬伤'
    )
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('head 逐字取自模板（MathJax 配置与 course.css/course.js 引用都在）', () => {
  const template = fs.readFileSync(DEFAULT_TEMPLATE, 'utf8')
  const templateHead = template.slice(0, template.indexOf('<body>'))
  const { html } = compileSpec(minimalSpec())
  for (const needle of ['window.MathJax', '../assets/course.css', '../assets/course.js', '../assets/mathjax/tex-svg.js', 'color-scheme']) {
    assert.ok(templateHead.includes(needle), '模板里应当有 ' + needle)
    assert.ok(html.includes(needle), '编译产物应当继承 ' + needle)
  }
  assert.ok(html.includes('<title>0001 · 测一课</title>'))
})

test('编译是确定性的：同一份 spec 两次编译逐字节一致', () => {
  const first = compileSpec(minimalSpec()).html
  const second = compileSpec(minimalSpec()).html
  assert.equal(first, second)
})

test('自测题按课堂桥的标记生成（data-question-id / data-ok / data-scope / data-explain）', () => {
  const { html } = compileSpec(minimalSpec())
  assert.match(html, /class="quiz" data-question-id="q-t1"/)
  assert.match(html, /data-ok="1"/)
  assert.match(html, /data-scope="口径：只按本课说法。"/)
  assert.match(html, /data-explain="这是解释。"/)
})

test('多选：answer 是数组时生成 checkbox 且带 data-multi', () => {
  const spec = minimalSpec()
  spec.sections[1].questions = [
    {
      questionId: 'q-multi',
      type: 'choice',
      prompt: '选出所有正确的',
      options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }],
      answer: ['a', 'b']
    }
  ]
  const { html } = compileSpec(spec)
  assert.match(html, /data-multi="1"/)
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3)
  assert.equal((html.match(/data-ok="1"/g) ?? []).length, 2)
})

test('组件：只有 chart 才引入图表包，其余共用 teach-components.js', () => {
  const withCards = minimalSpec({
    components: [{ kind: 'flashcards', context: '回忆', data: { title: 't', cards: [{ front: 'f', back: 'b' }] } }],
    assets: { components: true }
  })
  const cardsHtml = compileSpec(withCards).html
  assert.ok(cardsHtml.includes('teach-components.js'))
  assert.equal(cardsHtml.includes('teach-charts.js'), false, '没有图表就不该引图表包')
  assert.match(cardsHtml, /data-teach-component="flashcards"/)

  const withChart = minimalSpec({
    components: [{ kind: 'chart', data: { type: 'column', data: { labels: ['a'], legends: ['v'], series: [[1]] } } }],
    assets: { components: true }
  })
  assert.ok(compileSpec(withChart).html.includes('teach-charts.js'))
})

test('组件数据里的 < 被转义，避免提前关闭 application/json 脚本块', () => {
  const spec = minimalSpec({
    components: [{ kind: 'flashcards', data: { title: '</script><b>', cards: [{ front: 'a', back: 'b' }] } }],
    assets: { components: true }
  })
  const { html } = compileSpec(spec)
  assert.equal(html.includes('</script><b>'), false)
  assert.ok(html.includes('\\u003c'))
})

test('输出的类名都在 course.css 里真实存在（callout 不用 .note、rubric 不加类名）', () => {
  const css = fs.readFileSync(path.join(root, 'templates', 'course.css'), 'utf8')
  const spec = minimalSpec({
    sections: [
      { id: 's1', title: '一、正文', blocks: [{ kind: 'p', text: '段' }, { kind: 'callout', text: '提示' }] },
      {
        id: 'check',
        kind: 'quiz',
        title: '验收',
        questions: [{ questionId: 'q-open', type: 'explanation', prompt: '说说', rubric: [{ id: 'r1', text: '要点' }] }]
      }
    ]
  })
  const { html } = compileSpec(spec)
  // .note 只在 .formula 上下文有定义、.rubric 根本不存在：用它们会被 lint 报 class-unknown/class-context-missing
  assert.equal(html.includes('class="note"'), false)
  assert.equal(html.includes('class="rubric"'), false)
  assert.ok(html.includes('class="callout"'))
  assert.ok(/\.callout\s*\{/.test(css), '模板样式里必须有 .callout 规则')
})

test('未知字段一律拒绝（允许任意字段等于没有约束）', () => {
  const bad = minimalSpec()
  bad.sections[0].blocks = [{ kind: 'p', text: 'x', html: '<b>自由 HTML</b>' }]
  assert.throws(() => validateSpec(bad), (error) => error instanceof LessonSpecError && /不认识的字段 html/.test(error.message))
})

test('numeric 标准答案必须是数字（字符串会被判分侧读成 undefined）', () => {
  const bad = minimalSpec()
  bad.sections[1].questions = [{ questionId: 'q-num', type: 'numeric', prompt: '几？', answer: '4' }]
  assert.throws(() => validateSpec(bad), (error) => error instanceof LessonSpecError && /有限数字/.test(error.message))
  const good = minimalSpec()
  good.sections[1].questions = [{ questionId: 'q-num', type: 'numeric', prompt: '几？', answer: 4 }]
  assert.doesNotThrow(() => validateSpec(good))
})

test('结构约束：必须有且只有一段 quiz，且放在最后', () => {
  const noQuiz = minimalSpec()
  noQuiz.sections = [noQuiz.sections[0]]
  assert.throws(() => validateSpec(noQuiz), (error) => /恰好要有一段 kind:"quiz"/.test(error.message))

  const quizFirst = minimalSpec()
  quizFirst.sections = [quizFirst.sections[1], quizFirst.sections[0]]
  assert.throws(() => validateSpec(quizFirst), (error) => /必须放在最后/.test(error.message))
})

test('开放题必须给 rubric（否则判分没有依据）', () => {
  const bad = minimalSpec()
  bad.sections[1].questions = [{ questionId: 'q-open', type: 'explanation', prompt: '说说为什么' }]
  assert.throws(() => validateSpec(bad), (error) => /必须给 rubric/.test(error.message))
})

test('表格必须有表头（缺 thead 会被 lint 报硬伤，schema 先挡住）', () => {
  const bad = minimalSpec()
  bad.sections[0].blocks = [{ kind: 'table', rows: [['a']] }]
  assert.throws(() => validateSpec(bad), (error) => /必须是非空数组/.test(error.message))
})
