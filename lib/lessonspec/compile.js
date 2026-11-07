/* LessonSpec 编译器：**只做模板拼装**（docs/architecture.md）。
 *
 * 输入一份已校验的 spec，输出一个 lessons/NNNN-*.html：
 *   1. <head> 逐字取自 templates/lesson.html（MathJax 配置、course.css/course.js 引用、
 *      color-scheme 都在模板里，编译器不重写一份）；
 *   2. 正文按 spec 的段落与 block 生成，公式/表格/列表/提示框各自对应模板里的写法；
 *   3. 自测段落生成 .quiz[data-question-id] 标记，与 templates/lesson.html 的测验块同构，
 *      课堂桥（course.js）与 lesson_lint 都能直接认；
 *   4. 组件按 templates/COMPONENTS.md 的 JSON 契约拼装运行资源与数据块，不生成组件源码。
 *
 * 不做什么：不解释 Markdown、不内联 CSS/JS、不写自由 HTML、不做组件内部实现。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateSpec } from './schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_TEMPLATE = path.resolve(here, '../../templates/lesson.html')

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 模板 head：从文件开头到 <body> 之前，逐字保留（模板改了这里自动跟随）。 */
function headOf(templateText, { templatePath }) {
  const cut = templateText.indexOf('<body>')
  if (cut === -1) throw new Error('模板里找不到 <body>：' + templatePath)
  return templateText.slice(0, cut)
}

function renderBlock(block) {
  const html = renderBlockContent(block)
  return block.id === undefined ? html : html.replace(/^(\s*<[a-z]+)/i, '$1 data-node-id="' + escapeHtml(block.id) + '"')
}

function renderBlockContent(block) {
  if (block.kind === 'link') return '  <p><a href="' + escapeHtml(block.href) + '">' + escapeHtml(block.text) + '</a></p>'
  if (block.kind === 'image') {
    const lines = ['  <figure>', '    <img src="' + escapeHtml(block.src) + '" alt="' + escapeHtml(block.alt) + '" loading="lazy">']
    if (block.caption !== undefined) lines.push('    <figcaption>' + escapeHtml(block.caption) + '</figcaption>')
    lines.push('  </figure>')
    return lines.join('\n')
  }
  if (block.kind === 'video') {
    const poster = block.poster === undefined ? '' : ' poster="' + escapeHtml(block.poster) + '"'
    const lines = [
      '  <figure class="video">',
      '    <video src="' + escapeHtml(block.src) + '"' + poster + ' controls preload="metadata" playsinline></video>',
      '    <figcaption>',
      '      <span class="watch">看什么：' + escapeHtml(block.watch) + '</span>',
      '      <span class="source">源码：' + escapeHtml(block.source) + '</span>'
    ]
    if (block.caption !== undefined) lines.push('      <span>' + escapeHtml(block.caption) + '</span>')
    lines.push('    </figcaption>', '  </figure>')
    return lines.join('\n')
  }
  if (block.kind === 'p') return '  <p>' + escapeHtml(block.text) + '</p>'
  if (block.kind === 'math') {
    const tex = escapeHtml(block.tex)
    return block.display ? '  <div class="eq">$$' + tex + '$$</div>' : '  <p>$' + tex + '$</p>'
  }
  if (block.kind === 'list') {
    const tag = block.ordered ? 'ol' : 'ul'
    return ['  <' + tag + '>', ...block.items.map((item) => '    <li>' + escapeHtml(item) + '</li>'), '  </' + tag + '>'].join('\n')
  }
  // .callout 是 course.css 里真实存在的独立样式（.note 只在 .formula 上下文有定义，
  // 用它会被 lint 的样式上下文检查报 class-context-missing，且提示块实际没有样式）。
  if (block.kind === 'callout') return '  <p class="callout">' + escapeHtml(block.text) + '</p>'
  // table：必须有 thead，否则 lint 报 table-no-thead 硬伤
  const head = block.head.map((cell) => '<th>' + escapeHtml(cell) + '</th>').join('')
  const rows = block.rows.map((row) => '      <tr>' + row.map((cell) => '<td>' + escapeHtml(cell) + '</td>').join('') + '</tr>')
  return ['  <table>', '    <thead>', '      <tr>' + head + '</tr>', '    </thead>', '    <tbody>', ...rows, '    </tbody>', '  </table>'].join('\n')
}

function renderQuestion(question, index) {
  const name = 'q' + (index + 1)
  const attrs = [
    'class="quiz"',
    'data-question-id="' + escapeHtml(question.questionId) + '"',
    question.explain === undefined ? '' : 'data-explain="' + escapeHtml(question.explain) + '"',
    question.scope === undefined ? '' : 'data-scope="' + escapeHtml(question.scope) + '"'
  ]
    .filter((item) => item !== '')
    .join(' ')
  const lines = ['  <div ' + attrs + '>']
  lines.push('    <p class="q"><span class="tag">自测</span>' + escapeHtml(question.prompt) + '</p>')
  if (question.prerequisite !== undefined && question.prerequisite !== '') {
    lines.push('    <p class="hint">' + escapeHtml(question.prerequisite) + '</p>')
  }
  if (question.type === 'choice') {
    const answer = Array.isArray(question.answer) ? question.answer : [question.answer]
    const multi = answer.length > 1
    if (multi) lines[0] = lines[0].replace(/>$/, ' data-multi="1">')
    for (const option of question.options) {
      const ok = answer.includes(option.id) ? ' data-ok="1"' : ''
      const type = multi ? 'checkbox' : 'radio'
      lines.push('    <label><input type="' + type + '" name="' + name + '" value="' + escapeHtml(option.id) + '"' + ok + '> ' + escapeHtml(option.text) + '</label>')
    }
  } else if (question.type === 'numeric' || question.type === 'short') {
    lines.push('    <label><input type="text" name="' + name + '" data-answer="' + escapeHtml(String(question.answer)) + '"> 作答</label>')
  } else {
    lines.push('    <textarea name="' + name + '" rows="4" placeholder="写下你的推理"></textarea>')
    // 评分标准用无类名的 ul：course.css 里没有 .rubric（加类名会被 lint 报 class-unknown）。
    lines.push('    <ul>')
    for (const item of question.rubric) lines.push('      <li data-rubric="' + escapeHtml(item.id) + '">' + escapeHtml(item.text) + '</li>')
    lines.push('    </ul>')
  }
  lines.push('    <button type="button">判卷</button>')
  lines.push('    <p class="verdict"></p>')
  lines.push('  </div>')
  return lines.join('\n')
}

function renderComponents(components) {
  if (components.length === 0) return []
  const lines = []
  for (const component of components) {
    // 与 templates/COMPONENTS.md 的契约一致：容器 + application/json 数据块。
    const json = JSON.stringify(component.data).replace(/</g, '\\u003c')
    lines.push('  <div data-teach-component="' + escapeHtml(component.kind) + '"' + (component.context === '' ? '' : ' data-teach-context="' + escapeHtml(component.context) + '"') + '>')
    lines.push('    <script type="application/json">')
    lines.push('    ' + json)
    lines.push('    </script>')
    lines.push('  </div>')
  }
  return lines
}

function componentAssets(spec) {
  if (spec.assets.components !== true) return []
  const needsCharts = spec.components.some((component) => component.kind === 'chart')
  const lines = ['<link rel="stylesheet" href="../assets/components/teach-components.css">']
  // 有图表才引图表包；其余组件共用 teach-components.js（与 COMPONENTS.md 一致）。
  lines.push('<script src="../assets/components/teach-components.js" defer></script>')
  if (needsCharts) lines.push('<script src="../assets/components/teach-charts.js" defer></script>')
  return lines
}

/**
 * 把 spec 编译成课程页 HTML。
 * @param {object} rawSpec 未校验的 spec（JSON.parse 之后的对象）
 * @param {{templatePath?: string, templateText?: string}} [options] 测试可注入模板文本
 * @returns {{html: string, spec: object}}
 */
export function compileSpec(rawSpec, options = {}) {
  const spec = validateSpec(rawSpec)
  const templatePath = options.templatePath ?? DEFAULT_TEMPLATE
  const templateText = options.templateText ?? fs.readFileSync(templatePath, 'utf8')

  const head = headOf(templateText, { templatePath })
    .replace(/<title>[\s\S]*?<\/title>/, '<title>' + escapeHtml(spec.meta.serial + ' · ' + spec.meta.title) + '</title>')
  const extraAssets = componentAssets(spec)
  const headWithAssets = extraAssets.length === 0 ? head : head.replace('</head>', extraAssets.join('\n') + '\n</head>')

  const contentSections = spec.sections.filter((section) => section.kind === 'content')
  const quiz = spec.sections.find((section) => section.kind === 'quiz')
  // 导航标签用纯序号：模板里的〔01〕是占位符，lint 会把〔…〕当"没换掉的占位符"报硬伤。
  const navItems = [
    ...contentSections.map((section, index) => ({ id: section.id, label: String(index + 1).padStart(2, '0') })),
    { id: quiz.id, label: '验收' }
  ]

  const lines = [headWithAssets, '<body>', '<div class="shell">', '', '<aside class="sidenav">', '  <p class="label">本课路线</p>', '  <nav>', '    <ol>']
  for (const item of navItems) lines.push('      <li><a href="#' + escapeHtml(item.id) + '">' + escapeHtml(item.label) + '</a></li>')
  lines.push('    </ol>', '  </nav>', '</aside>', '', '<div class="wrap">', '', '<header class="course">')
  if (spec.meta.eyebrow !== '') lines.push('  <p class="eyebrow">' + escapeHtml(spec.meta.eyebrow) + '</p>')
  lines.push('  <h1>' + escapeHtml(spec.meta.title) + '</h1>')
  if (spec.meta.lede !== '') lines.push('  <p class="lede">' + escapeHtml(spec.meta.lede) + '</p>')
  lines.push('</header>')

  let componentCursor = 0
  for (const section of contentSections) {
    lines.push('', '<section id="' + escapeHtml(section.id) + '">', '  <h2>' + escapeHtml(section.title) + '</h2>')
    for (const block of section.blocks) lines.push(renderBlock(block))
    // 组件按出现顺序铺在段落末尾（spec 只声明顺序，不声明精确插入点：拼装层的刻意限制）
    while (componentCursor < spec.components.length) {
      lines.push(...renderComponents([spec.components[componentCursor]]))
      componentCursor += 1
      break
    }
    lines.push('</section>')
  }
  while (componentCursor < spec.components.length) {
    // spec 的段落用完了但还有组件：挂到最后一节末尾，不静默丢弃。
    lines.push(...renderComponents([spec.components[componentCursor]]))
    componentCursor += 1
  }

  lines.push('', '<section id="' + escapeHtml(quiz.id) + '">', '  <h2>' + escapeHtml(quiz.title) + '</h2>')
  quiz.questions.forEach((question, index) => lines.push(renderQuestion(question, index)))
  lines.push('</section>', '', '<footer class="course">')
  lines.push('  <p>有哪一步卡住就直说，只补那一段。</p>')
  lines.push('</footer>', '', '</div>', '</div>', '</body>', '</html>', '')

  return { html: lines.join('\n'), spec }
}
