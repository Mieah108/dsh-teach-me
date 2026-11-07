/* LessonSpec 的最小 schema：只覆盖 templates/lesson.html 里真实存在的槽位。
 *
 * 编译边界（docs/architecture.md）：编译器只做模板拼装。
 * 所以这里刻意"少"：不做自由 HTML 片段、不做 Markdown、不做组件内部结构。
 * 未知字段一律拒绝 —— 允许任意字段就等于没有约束，实验结论也就没有意义。
 */

export const SPEC_SCHEMA_VERSION = 1
export const BLOCK_KINDS = ['p', 'math', 'table', 'list', 'callout', 'link', 'image', 'video']
export const QUESTION_TYPES = ['choice', 'numeric', 'short', 'explanation', 'design']
export const DETERMINISTIC_TYPES = ['choice', 'numeric', 'short']
export const COMPONENT_KINDS = ['flashcards', 'timeline', 'chart']

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
const MAX_SECTIONS = 8
const MAX_QUESTIONS = 6

export class LessonSpecError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'LessonSpecError'
    this.code = 'lesson-spec-invalid'
    if (detail !== undefined) this.detail = detail
  }
}

const fail = (where, message, detail) => {
  throw new LessonSpecError(`spec ${where}：${message}`, detail)
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 只允许这些键：多一个键就报错，并指出是哪个。 */
function onlyKeys(value, allowed, where) {
  if (!isPlainObject(value)) fail(where, '必须是对象', { value })
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(where, '不认识的字段 ' + key + '（允许：' + allowed.join('/') + '）', { key })
  }
  return value
}

function text(value, where, { max = 20000, allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(where, '必须是字符串', { value })
  if (!allowEmpty && value.trim() === '') fail(where, '不能为空')
  if (value.length > max) fail(where, '太长（' + value.length + ' > ' + max + '）')
  return value
}

function id(value, where) {
  if (typeof value !== 'string' || !ID.test(value)) fail(where, '不是合法标识：' + String(value), { value })
  return value
}

/** 路径相对编译页面；文件存在性与工作区边界留给 lint / publish，不在纯 schema 里做 I/O。 */
function resourceAddress(value, where, { external = false } = {}) {
  const address = text(value, where, { max: 2000 })
  if (/[\s\u0000-\u001f\u007f\\]/.test(address)) fail(where, '地址不能含空白、控制字符或反斜杠')
  if (external && /^https?:\/\//i.test(address)) {
    let url
    try {
      url = new URL(address)
    } catch {
      fail(where, '不是有效的 HTTP(S) URL')
    }
    if (!url.hostname || url.username || url.password) fail(where, 'HTTP(S) URL 必须有主机且不能含凭据')
    return address
  }
  // 原始相对路径不含 URL 转义/实体字符，保证浏览器、lint 与资产扫描看到的是同一路径。
  if (address.startsWith('/') || /[:%?#&"'<>]/.test(address)) {
    fail(where, external ? '只支持 HTTP(S) URL 或本地相对文件路径' : '媒体只支持本地相对文件路径')
  }
  const segments = address.split('/')
  if (segments.some((part) => part.startsWith('.') && part !== '.' && part !== '..')) fail(where, '不能引用点号隐藏文件或目录')
  if (['', '.', '..'].includes(segments[segments.length - 1])) fail(where, '必须指向文件，不能是目录')
  return address
}

function blockOf(block, where) {
  if (!isPlainObject(block)) fail(where, '必须是对象', { value: block })
  const { id: nodeId, ...content } = block
  const normalized = blockContentOf(content, where)
  if (nodeId !== undefined) normalized.id = id(nodeId, where + '.id')
  return normalized
}

function blockContentOf(block, where) {
  if (!isPlainObject(block)) fail(where, '必须是对象', { value: block })
  const fields = {
    link: ['kind', 'text', 'href'],
    image: ['kind', 'src', 'alt', 'caption'],
    video: ['kind', 'src', 'poster', 'watch', 'source', 'caption']
  }
  if (Object.hasOwn(fields, block.kind)) {
    onlyKeys(block, fields[block.kind], where)
    if (block.kind === 'link') {
      return { kind: 'link', text: text(block.text, where + '.text'), href: resourceAddress(block.href, where + '.href', { external: true }) }
    }
    const normalized = { kind: block.kind, src: resourceAddress(block.src, where + '.src') }
    if (block.kind === 'image') normalized.alt = text(block.alt, where + '.alt', { max: 2000 })
    else {
      normalized.watch = text(block.watch, where + '.watch', { max: 2000 })
      normalized.source = text(block.source, where + '.source', { max: 2000 })
      if (block.poster !== undefined) normalized.poster = resourceAddress(block.poster, where + '.poster')
    }
    if (block.caption !== undefined) normalized.caption = text(block.caption, where + '.caption', { max: 2000 })
    return normalized
  }
  onlyKeys(block, ['kind', 'text', 'tex', 'display', 'head', 'rows', 'ordered', 'items'], where)
  const kind = block.kind
  if (!BLOCK_KINDS.includes(kind)) fail(where + '.kind', '不支持：' + String(kind) + '（允许：' + BLOCK_KINDS.join('/') + '）')

  if (kind === 'p' || kind === 'callout') return { kind, text: text(block.text, where + '.text') }
  if (kind === 'math') {
    const display = block.display === undefined ? true : block.display
    if (typeof display !== 'boolean') fail(where + '.display', '必须是布尔值')
    return { kind, tex: text(block.tex, where + '.tex'), display }
  }
  if (kind === 'list') {
    if (!Array.isArray(block.items) || block.items.length === 0) fail(where + '.items', '必须是非空数组')
    return {
      kind,
      ordered: block.ordered === true,
      items: block.items.map((item, index) => text(item, where + '.items[' + index + ']', { max: 2000 }))
    }
  }
  // table
  if (!Array.isArray(block.head) || block.head.length === 0) fail(where + '.head', '必须是非空数组（表格要有表头，lint 会把缺 thead 报硬伤）')
  if (!Array.isArray(block.rows) || block.rows.length === 0) fail(where + '.rows', '必须是非空数组')
  const head = block.head.map((cell, index) => text(cell, where + '.head[' + index + ']', { max: 500 }))
  const rows = block.rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== head.length) {
      fail(where + '.rows[' + rowIndex + ']', '列数必须与表头一致（' + head.length + '）', { row })
    }
    return row.map((cell, cellIndex) => text(cell, where + '.rows[' + rowIndex + '][' + cellIndex + ']', { max: 2000 }))
  })
  return { kind, head, rows }
}

function questionOf(question, where) {
  onlyKeys(
    question,
    ['questionId', 'type', 'prompt', 'scope', 'explain', 'options', 'answer', 'rubric', 'prerequisite'],
    where
  )
  const questionId = id(question.questionId, where + '.questionId')
  const type = question.type
  if (!QUESTION_TYPES.includes(type)) fail(where + '.type', '不支持：' + String(type))
  const prompt = text(question.prompt, where + '.prompt')
  const normalized = { questionId, type, prompt }
  if (question.scope !== undefined) normalized.scope = text(question.scope, where + '.scope', { max: 500, allowEmpty: true })
  if (question.explain !== undefined) normalized.explain = text(question.explain, where + '.explain', { max: 500, allowEmpty: true })
  if (question.prerequisite !== undefined) normalized.prerequisite = text(question.prerequisite, where + '.prerequisite', { max: 2000, allowEmpty: true })

  if (type === 'choice') {
    if (!Array.isArray(question.options) || question.options.length < 2) {
      fail(where + '.options', 'choice 题至少要有两个选项')
    }
    const options = question.options.map((option, index) => {
      onlyKeys(option, ['id', 'text'], where + '.options[' + index + ']')
      return { id: id(option.id, where + '.options[' + index + '].id'), text: text(option.text, where + '.options[' + index + '].text', { max: 500 }) }
    })
    const ids = new Set(options.map((option) => option.id))
    if (ids.size !== options.length) fail(where + '.options', '选项 id 有重复')
    const answer = question.answer
    const answerList = Array.isArray(answer) ? answer : [answer]
    if (answerList.some((item) => typeof item !== 'string' || !ids.has(item))) {
      fail(where + '.answer', '标准答案必须指向存在的选项 id', { answer })
    }
    normalized.options = options
    normalized.answer = Array.isArray(answer) ? answerList : answer
    return normalized
  }

  if (DETERMINISTIC_TYPES.includes(type)) {
    if (question.answer === undefined || question.answer === null || question.answer === '') {
      fail(where + '.answer', type + ' 题必须给标准答案（否则只能记待复核）')
    }
    if (type === 'numeric') {
      // 实验 A 发现的真实约束：numeric 的标准答案必须是数字（或 {value, tolerance}）。
      // 写成字符串 "4" 时，判分侧把它当对象取 .value → undefined → 永远判错。
      const answer = question.answer
      const isNumber = typeof answer === 'number' && Number.isFinite(answer)
      const isTolerance =
        isPlainObject(answer) && Number.isFinite(Number(answer.value)) && (answer.tolerance === undefined || Number.isFinite(Number(answer.tolerance)))
      if (!isNumber && !isTolerance) {
        fail(where + '.answer', 'numeric 题的标准答案必须是有限数字，或 {value, tolerance} 对象（字符串会被判分侧当对象读成 undefined）', { answer })
      }
      normalized.answer = isNumber ? answer : { value: Number(answer.value), tolerance: Number(answer.tolerance ?? 0) }
      return normalized
    }
    if (Array.isArray(question.answer) && type === 'short') {
      normalized.answer = question.answer.map((item, index) => text(item, where + '.answer[' + index + ']', { max: 500 }))
      return normalized
    }
    normalized.answer = typeof question.answer === 'string' ? text(question.answer, where + '.answer', { max: 2000 }) : question.answer
    return normalized
  }

  // explanation / design：必须给 rubric，否则判分没有依据
  if (!Array.isArray(question.rubric) || question.rubric.length === 0) {
    fail(where + '.rubric', '开放题必须给 rubric（逐条标准）')
  }
  normalized.rubric = question.rubric.map((item, index) => {
    onlyKeys(item, ['id', 'text'], where + '.rubric[' + index + ']')
    return { id: id(item.id, where + '.rubric[' + index + '].id'), text: text(item.text, where + '.rubric[' + index + '].text', { max: 1000 }) }
  })
  return normalized
}

function sectionOf(section, where) {
  if (!isPlainObject(section)) fail(where, '必须是对象', { value: section })
  const idValue = id(section.id, where + '.id')
  const title = text(section.title, where + '.title', { max: 500 })
  if (section.kind === 'quiz') {
    onlyKeys(section, ['id', 'kind', 'title', 'questions'], where)
    if (!Array.isArray(section.questions) || section.questions.length === 0) fail(where + '.questions', '至少一道题')
    if (section.questions.length > MAX_QUESTIONS) fail(where + '.questions', '最多 ' + MAX_QUESTIONS + ' 题')
    const seen = new Set()
    const questions = section.questions.map((question, index) => {
      const normalized = questionOf(question, where + '.questions[' + index + ']')
      if (seen.has(normalized.questionId)) fail(where + '.questions', '题目 id 重复：' + normalized.questionId)
      seen.add(normalized.questionId)
      return normalized
    })
    return { id: idValue, kind: 'quiz', title, questions }
  }
  onlyKeys(section, ['id', 'title', 'blocks'], where)
  if (!Array.isArray(section.blocks) || section.blocks.length === 0) fail(where + '.blocks', '必须是非空数组')
  const blocks = section.blocks.map((block, index) => blockOf(block, where + '.blocks[' + index + ']'))
  const blockIds = blocks.filter((block) => block.id !== undefined).map((block) => block.id)
  if (new Set(blockIds).size !== blockIds.length) fail(where + '.blocks', '块 id 重复')
  return {
    id: idValue,
    kind: 'content',
    title,
    blocks
  }
}

/**
 * 校验并归一化 spec。返回新对象（不改入参）。
 * @param {object} raw 从 JSON 读出来的 spec
 * @returns {object} 归一化后的 spec
 * @throws {LessonSpecError} 任何不合法之处
 */
export function validateSpec(raw) {
  onlyKeys(raw, ['schemaVersion', 'id', 'meta', 'sections', 'components', 'assets'], 'root')
  if (raw.schemaVersion !== SPEC_SCHEMA_VERSION) {
    fail('root.schemaVersion', '必须是 ' + SPEC_SCHEMA_VERSION + '，实际 ' + String(raw.schemaVersion))
  }
  onlyKeys(raw.meta, ['serial', 'course', 'title', 'eyebrow', 'lede'], 'root.meta')
  const meta = {
    serial: text(raw.meta.serial, 'root.meta.serial', { max: 8 }),
    course: text(raw.meta.course, 'root.meta.course', { max: 200, allowEmpty: true }),
    title: text(raw.meta.title, 'root.meta.title', { max: 500 }),
    eyebrow: text(raw.meta.eyebrow, 'root.meta.eyebrow', { max: 500, allowEmpty: true }),
    lede: text(raw.meta.lede, 'root.meta.lede', { max: 2000, allowEmpty: true })
  }
  if (!Array.isArray(raw.sections) || raw.sections.length === 0) fail('root.sections', '至少一段')
  if (raw.sections.length > MAX_SECTIONS) fail('root.sections', '最多 ' + MAX_SECTIONS + ' 段')
  const sections = raw.sections.map((section, index) => sectionOf(section, 'root.sections[' + index + ']'))
  if (new Set(sections.map((section) => section.id)).size !== sections.length) fail('root.sections', '段落 id 重复')
  const quizCount = sections.filter((section) => section.kind === 'quiz').length
  if (quizCount !== 1) fail('root.sections', '恰好要有一段 kind:"quiz"（现在 ' + quizCount + ' 段）')
  const quiz = sections.find((section) => section.kind === 'quiz')
  if (sections[sections.length - 1] !== quiz) fail('root.sections', 'kind:"quiz" 那段必须放在最后（验收在课末）')

  const components = (raw.components ?? []).map((component, index) => {
    const where = 'root.components[' + index + ']'
    onlyKeys(component, ['kind', 'context', 'data'], where)
    if (!COMPONENT_KINDS.includes(component.kind)) fail(where + '.kind', '不支持：' + String(component.kind))
    if (!isPlainObject(component.data)) fail(where + '.data', '必须是对象（对应 templates/COMPONENTS.md 的 JSON 契约）')
    return {
      kind: component.kind,
      context: text(component.context ?? '', where + '.context', { max: 200, allowEmpty: true }),
      data: component.data
    }
  })
  const assets = raw.assets === undefined ? {} : onlyKeys(raw.assets, ['components'], 'root.assets')
  if (components.length > 0 && assets.components !== true) {
    fail('root.assets.components', '用了 components 就必须显式声明 assets.components = true（否则页面缺运行资源）')
  }
  return {
    schemaVersion: SPEC_SCHEMA_VERSION,
    id: id(raw.id, 'root.id'),
    meta,
    sections,
    components,
    assets: { components: assets.components === true }
  }
}
