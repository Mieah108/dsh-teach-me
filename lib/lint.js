/* 课程页自检：交付前把「能被机器看见的硬伤」挨个查一遍。
   查的是硬伤（渲染不出来、判不了分、复制不成 Markdown），不是文风；
   文风与讲法由提示词里的判据管。 */

import fs from 'node:fs'
import path from 'node:path'
import { compileSpec } from './lessonspec/compile.js'
import { validateSpec } from './lessonspec/schema.js'
import { matches } from './util.js'
import { inspectAssetDrift } from './archive/drift.js'
import { resolveInside } from './archive/util.js'

const MATH_COMMANDS = /\\(frac|sqrt|sum|int|prod|lim|alpha|beta|gamma|theta|lambda|sigma|omega|times|cdot|left|right|begin|end|partial|nabla|mathbb|mathrm|text)\b/g
const CJK = /[\u3400-\u9fff]/
// 控制字符：LaTeX 的反斜杠经代码字符串落盘时被解释掉（\t → TAB、\b → 退格）
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g
// 被吃掉的 LaTeX 命令：控制字符后面跟着的正是命令名剩余部分（\theta → TAB + heta）
const ESCAPED_LATEX =
  /[\u0008\u0009\u000b\u000c](heta|imes|ext(?:bf|it|rm|sf|tt|style|color|superscript|subscript)?|an|au|eta|egin|ec|rac|left|right|ambda|im|abla|um|athbb|athrm|ight|qrt|igma|omega|alpha|beta|gamma|delta|partial|prod|int|sum|cdot|pm|neq|leq|geq|to|rightarrow|infty)/g

// ── 结构扫描：元素、样式表索引 ─────────────────────────────
// 纯 regex + 栈。本包不 import 外部包（见 lib/util.js 开头），linkedom 只是
// devDependency、发行包里没有，所以这里不拿它做 DOM 解析。

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
// 引号内允许 `>`：属性值里的比较符号不会把标签提前截断
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
// 脚本运行时挂上的类名（course.js / 组件包），作者写不进页面，类名检查跳过
const RUNTIME_CLASS = /^(?:teach|md|js)-|^is-/
const RUNTIME_EXACT = new Set(['verdict', 'ok', 'no'])
// 页面在推荐外部材料却没有外链（matches() 要求带 g）
const RESOURCE_CLAIM = /先去读|一手资源|延伸阅读|阅读清单|参考文献|扩展阅读/g
// 课中让学习者先出力的写法（预测、留空、先算）
const STUDENT_OUTPUT_HINT = /先[^。，；\n]{0,10}(算|写|猜|预测|画|估|答)|别往下看|暂停一下/
// 学习记录里的日期线索（「2025-10 首次诊断」这种）
const RECORD_DATE_CUE = /诊断|决定|首次|记录|本轮/
const RECORD_DATE = /(20\d{2})-(\d{2})(?:-\d{2})?/g
const NUMERIC_TOKEN = /(?<![A-Za-z0-9])([0-9][0-9.,]*[0-9]|[0-9])(?![A-Za-z0-9])/g

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' ']
])

/** HTML 实体解码（够认 &amp; 与数字实体）。 */
function decodeEntities(value) {
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES.get(body.toLowerCase()) ?? whole
  })
}

/** 去标签、解实体、压空白：只为比较「这句是不是同一句」。 */
function normalizeText(value) {
  return decodeEntities(String(value).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, '')
}

/** 去标签留文字（数字提取用）。 */
function textOf(value) {
  return decodeEntities(String(value).replace(/<[^>]+>/g, ' '))
}

/** 资源路径去掉 ?query / #hash。 */
function refName(value) {
  return String(value).split(/[?#]/)[0]
}

/** 取标签属性（标签文本，不是整段 HTML）。 */
function attrOf(tagText, name) {
  const found = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(String(tagText))
  return found === null ? undefined : found[1] ?? found[2]
}

function parseAttrs(raw) {
  const out = {}
  ATTRIBUTE.lastIndex = 0
  let hit = ATTRIBUTE.exec(String(raw))
  while (hit !== null) {
    out[hit[1].toLowerCase()] = hit[2] ?? hit[3] ?? hit[4] ?? ''
    hit = ATTRIBUTE.exec(String(raw))
  }
  return out
}

/**
 * 扫出元素（含父节点、祖先类名），供结构检查用。
 * 输入通常是 stripRawBlocks 之后的文本：script/style/pre/code 已被挖空。
 * 未闭合的元素 end 记到文件末尾，宁可少报也不抛错。
 */
function elementsOf(text) {
  const out = []
  const stack = []
  TAG.lastIndex = 0
  let hit = TAG.exec(text)
  while (hit !== null) {
    const closing = hit[1] === '/'
    const name = hit[2].toLowerCase()
    if (name === '!doctype') {
      hit = TAG.exec(text)
      continue
    }
    if (closing) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (out[stack[index]].tag === name) {
          out[stack[index]].end = hit.index + hit[0].length
          stack.length = index
          break
        }
      }
      hit = TAG.exec(text)
      continue
    }
    const raw = hit[3] ?? ''
    const attrs = parseAttrs(raw)
    out.push({
      tag: name,
      attrs,
      classes: String(attrs.class ?? '').split(/\s+/).filter((item) => item.length > 0),
      start: hit.index,
      openEnd: hit.index + hit[0].length,
      end: text.length,
      parent: stack.length === 0 ? -1 : stack[stack.length - 1],
      ancestors: stack.map((index) => ({ tag: out[index].tag, classes: out[index].classes })),
      index: out.length
    })
    if (!/\/\s*$/.test(raw) && !VOID_TAGS.has(name)) stack.push(out.length - 1)
    hit = TAG.exec(text)
  }
  return out
}

/** 把一条选择器记进类名索引：主语类名 → 需要的标签与祖先条件。 */
function indexSelector(rawSelector, body, selectors, pseudoContent) {
  const selector = rawSelector.trim()
  if (selector.length === 0 || selector.startsWith('@')) return
  const pseudo = /^(.*?)::?(before|after)$/.exec(selector)
  if (pseudo !== null) {
    const base = pseudo[1].trim()
    const content = /content\s*:\s*(?:"([^"]*)"|'([^']*)')/.exec(body)
    if (content !== null && /^\.[A-Za-z0-9_-]+$/.test(base)) pseudoContent.set(base.slice(1), content[1] ?? content[2])
  }
  const parts = selector
    .split(/\s*[>+~]\s*|\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0) return
  const subject = parts[parts.length - 1]
  const subjectClasses = [...subject.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((item) => item[1])
  if (subjectClasses.length === 0) return
  const subjectTag = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(subject)
  const context = {
    tag: subjectTag === null ? null : subjectTag[1].toLowerCase(),
    ancestors: parts
      .slice(0, -1)
      .map((part) => {
        const tag = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(part)
        return { tag: tag === null ? null : tag[1].toLowerCase(), classes: [...part.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((item) => item[1]) }
      })
      .filter((item) => item.tag !== null || item.classes.length > 0),
    selector
  }
  for (const name of subjectClasses) {
    if (!selectors.has(name)) selectors.set(name, [])
    selectors.get(name).push(context)
  }
}

function parseStylesheet(cssText, selectors, pseudoContent) {
  const clean = String(cssText).replace(/\/\*[\s\S]*?\*\//g, '')
  for (const hit of matches(clean, /([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = hit.match[1]
    if (prelude.trim().startsWith('@')) continue
    const body = hit.match[2]
    for (const selector of prelude.split(',')) indexSelector(selector, body, selectors, pseudoContent)
  }
}

/** 页面自己的样式：<link rel=stylesheet> 指向的本地 CSS + 内联 <style>。 */
function styleTextsOf(text, file, refs) {
  const out = []
  for (const entry of refs.links) {
    const ref = String(entry.ref)
    if (/^(?:[a-z]+:|#|\/\/)/i.test(ref)) continue
    if (!/\.css$/i.test(refName(ref))) continue
    const target = path.resolve(path.dirname(file), refName(ref))
    if (!fs.existsSync(target)) continue
    try {
      out.push(fs.readFileSync(target, 'utf8'))
    } catch {
      // 读不到就当没有样式表：类名检查会整体跳过，不猜
    }
  }
  for (const hit of matches(text, /<style\b[^>]*>([\s\S]*?)<\/style>/gi)) out.push(hit.match[1])
  return out
}

/** 验收区（section#check）的起点；找不到就说明不是课程页布局。 */
function checkSectionOf(text) {
  const hit = /<section\b[^>]*\bid\s*=\s*(?:"check"|'check'|check)(?=[\s>])[^>]*>/i.exec(text)
  return hit === null ? undefined : { index: hit.index, openEnd: hit.index + hit[0].length }
}

/** ≥2 位的数字 token（`2^26` 取 26，`0.8488` 取 08488；单数字噪声不要）。 */
function numericTokens(value) {
  const tokens = new Set()
  for (const hit of matches(String(value), NUMERIC_TOKEN)) {
    const digits = hit.match[1].replace(/[^0-9]/g, '')
    if (digits.length >= 2) tokens.add(digits)
  }
  return tokens
}

/** 类名检查：样式表里有没有、以及是不是只在别的上下文里定义。 */
function classIssues(elements, styleIndex, add) {
  if (!styleIndex.available) return
  for (const element of elements) {
    for (const name of element.classes) {
      if (RUNTIME_CLASS.test(name) || RUNTIME_EXACT.has(name)) continue
      const contexts = styleIndex.selectors.get(name)
      if (contexts === undefined) {
        add(
          element.start,
          'warn',
          'class-unknown',
          `类名 .${name} 在页面引用的样式表里没有定义（course.css / 内联 <style>）：<${element.tag} class="${name}"> 现在没有样式；要么拼错了，要么按「先写进 course.css、再在 FORMATS 登记」新增`
        )
        continue
      }
      const matched = contexts.some((context) => {
        if (context.tag !== null && context.tag !== element.tag) return false
        return context.ancestors.every((need) =>
          element.ancestors.some(
            (ancestor) => (need.tag === null || ancestor.tag === need.tag) && need.classes.every((className) => ancestor.classes.includes(className))
          )
        )
      })
      if (matched) continue
      const where = contexts.map((context) => context.selector).slice(0, 3).join(' / ')
      add(
        element.start,
        'warn',
        'class-context-missing',
        `类名 .${name} 只在别的上下文里有样式（${where}），这里的 <${element.tag} class="${name}"> 落不到任何规则：换到那个上下文里，或按「先写进 course.css、再在 FORMATS 登记」给 .${name} 定义独立样式`
      )
    }
  }
}

/** .goals 里又写了一遍 CSS ::before 已经输出的标题。 */
function goalsIssues(text, elements, styleIndex, add) {
  const expected = styleIndex.pseudoContent.get('goals')
  if (expected === undefined) return
  const wanted = normalizeText(expected)
  if (wanted.length === 0) return
  for (const element of elements) {
    if (!element.classes.includes('goals')) continue
    const list = elements.find(
      (candidate) => candidate.start > element.openEnd && candidate.start < element.end && (candidate.tag === 'ol' || candidate.tag === 'ul')
    )
    const until = list === undefined ? element.end : list.start
    if (normalizeText(text.slice(element.openEnd, until)) !== wanted) continue
    const firstChild = elements.find((candidate) => candidate.start > element.openEnd && candidate.start < until)
    add(
      firstChild === undefined ? element.start : firstChild.start,
      'error',
      'goals-duplicate-title',
      `.goals 里又写了一遍「${expected}」：样式表的 .goals::before 已经输出这句，页面里这行删掉（标题只由 CSS 输出）`
    )
  }
}

/** .shell 的第一列是 sidenav；缺了宽屏会把正文塞进 13.5rem。 */
function shellIssues(elements, add) {
  for (const shell of elements) {
    if (!shell.classes.includes('shell')) continue
    const children = elements.filter((candidate) => candidate.parent === shell.index)
    const sidenav = children.find((child) => child.tag === 'aside' && child.classes.includes('sidenav'))
    if (sidenav === undefined) {
      add(
        shell.start,
        'error',
        'shell-without-sidenav',
        'div.shell 里没有 aside.sidenav：宽屏（>1040px）网格会把正文塞进 13.5rem 的首列。补一个 aside.sidenav 放成 .shell 的第一个元素子节点，或去掉外层 .shell 只用 .wrap'
      )
      continue
    }
    if (children[0] !== sidenav) {
      const before = children
        .slice(0, children.indexOf(sidenav))
        .map((child) => `<${child.tag}${child.classes.length > 0 ? ' class="' + child.classes.join(' ') + '"' : ''}>`)
        .join('、')
      add(sidenav.start, 'warn', 'sidenav-not-first', `aside.sidenav 必须是 div.shell 的第一个元素子节点（现在前面是 ${before}）：宽屏网格的第一列就是它`)
    }
  }
}

/** 侧栏与正文顶部目录的条目、文案对不齐。 */
function tocIssues(text, elements, add) {
  const sidenav = elements.find((element) => element.tag === 'aside' && element.classes.includes('sidenav'))
  const toc = elements.find((element) => element.tag === 'nav' && element.classes.includes('toc'))
  if (sidenav === undefined || toc === undefined) return
  const anchorsWithin = (root) => {
    const map = new Map()
    for (const element of elements) {
      if (element.tag !== 'a') continue
      if (element.start <= root.openEnd || element.start >= root.end) continue
      const href = element.attrs.href
      if (typeof href !== 'string' || href.length === 0 || href[0] !== '#') continue
      map.set(href, normalizeText(text.slice(element.openEnd, Math.max(element.openEnd, element.end - 4))))
    }
    return map
  }
  const side = anchorsWithin(sidenav)
  const top = anchorsWithin(toc)
  for (const [href, label] of side) {
    if (!top.has(href)) {
      add(sidenav.start, 'warn', 'toc-entry-mismatch', `aside.sidenav 有 ${href}，nav.toc 里没有：两侧条目都要和 section[id] 对上`)
      continue
    }
    if (top.get(href) !== label) {
      add(
        sidenav.start,
        'warn',
        'toc-label-drift',
        `${href} 两侧文案不一致：「${label}」/「${top.get(href)}」：宽屏看侧栏、窄屏看顶部目录，同一节要同一个名字（有意缩写就统一简称）`
      )
    }
  }
  for (const [href] of top) {
    if (!side.has(href)) add(toc.start, 'warn', 'toc-entry-mismatch', `nav.toc 有 ${href}，aside.sidenav 里没有：两侧条目都要和 section[id] 对上`)
  }
}

/** 在推荐一手资源，却一条外链都没有。 */
function resourceLinkIssues(plain, add) {
  if (/<a\b[^>]*\bhref\s*=\s*(?:"https?:\/\/[^"]*"|'https?:\/\/[^']*')/i.test(plain)) return
  const claims = matches(plain, RESOURCE_CLAIM)
  if (claims.length === 0) return
  add(
    claims[0].index,
    'warn',
    'resources-without-link',
    '页面在推荐一手资源/延伸阅读，但整页没有一条 http(s) 外链：给出原文链接（抓取日期与摘录留在 RESOURCES.md），只写书名或「见 RESOURCES.md」学习者点不过去'
  )
}

/** 课中一次「他自己先出力」的地方都没有。 */
function studentOutputIssues(plain, check, add) {
  if (check === undefined) return
  const before = plain.slice(0, check.index)
  if (quizBlocks(before).length > 0) return
  if (/<details\b/i.test(before)) return
  if (STUDENT_OUTPUT_HINT.test(before)) return
  add(
    check.index,
    'warn',
    'no-student-output',
    '#check 之前没有让他先出力的地方：加一处课中自测、折叠揭晓，或一段「先算/先猜再往下看」（30-lesson 要求课中至少留一次）'
  )
}

/** 验收题的解释与正确项数字全部来自正文：多半是复述题。 */
function restateIssues(plain, check, add) {
  if (check === undefined) return
  const bodyTokens = numericTokens(textOf(plain.slice(0, check.index)))
  if (bodyTokens.size === 0) return
  for (const quiz of quizBlocks(plain)) {
    if (quiz.index < check.index) continue
    const explain = attrOf(quiz.open, 'data-explain') ?? ''
    const labels = [...quiz.block.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)]
    const correct = labels.find((label) => /\bdata-ok\s*=\s*(?:"1"|'1'|1)(?=[\s>])/i.test(label[1]))
    const answer = correct === undefined ? '' : textOf(correct[1])
    const tokens = numericTokens(textOf(explain) + ' ' + answer)
    if (tokens.size < 5) continue
    const shared = [...tokens].filter((token) => bodyTokens.has(token))
    if (shared.length / tokens.size < 0.8) continue
    add(
      quiz.index,
      'warn',
      'quiz-restates-body',
      `这道验收题的解释与正确项里 ${shared.length}/${tokens.size} 个数字都在正文出现过：多半是把正文再问一遍。换参数、换方向或换情境再问（50-questions：验收必须换情境）`
    )
  }
}

/** 学习记录/笔记里的日期年份笔误（如 2026 年写成 2025-10）。 */
function dateYearDriftIssues(text, file, add, today) {
  const normalized = String(file).replace(/\\/g, '/')
  const isRecord = /(^|\/)NOTES\.md$/.test(normalized) || normalized.includes('/learning-records/')
  if (!isRecord) return
  const now = today instanceof Date && !Number.isNaN(today.getTime()) ? today : new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  for (const hit of matches(text, RECORD_DATE)) {
    const claimedYear = Number(hit.match[1])
    const claimedMonth = Number(hit.match[2])
    if (Math.abs(claimedYear - year) !== 1) continue
    if (Math.abs(claimedMonth - month) > 1) continue
    const lineStart = text.lastIndexOf('\n', hit.index) + 1
    const lineEnd = text.indexOf('\n', hit.index)
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
    if (!RECORD_DATE_CUE.test(line)) continue
    add(
      hit.index,
      'warn',
      'date-year-drift',
      `记录里的日期是 ${claimedYear}-${String(claimedMonth).padStart(2, '0')}，现在是 ${year}-${String(month).padStart(2, '0')}：确认是不是年份笔误（引用的文献年份不受这条检查）`
    )
  }
}

/** 控制字符（HTML 与 Markdown 都要查；学习记录被吃掉反斜杠就是这么坏的）。 */
function controlCharsIn(text, add, skip = new Set()) {
  const hits = matches(text, CONTROL).filter((hit) => !skip.has(hit.index))
  if (hits.length === 0) return
  add(
    hits[0].index,
    'error',
    'control-chars',
    `文件里有 ${hits.length} 个控制字符（常见原因：LaTeX 的 \\t、\\b 经过代码字符串时被转义）。用 write 工具直接写内容，别经字符串拼接或 heredoc 再落盘`
  )
}

/** 抓「反斜杠被吃掉」的公式：报精确位置，并把这些控制字符从通用告警里排除。 */
function escapedLatexIn(text, add) {
  const skip = new Set()
  const hits = matches(text, ESCAPED_LATEX)
  for (const hit of hits) {
    skip.add(hit.index)
    add(
      hit.index,
      'error',
      'escaped-latex',
      `公式里的反斜杠被转义成了控制字符（\\${hit.match[1]} 变成了控制字符 + ${hit.match[1]}）：用 write 工具直接写原文，别经过会解释 \\t / \\b / \\f 的字符串`
    )
  }
  return skip
}

/** 行内公式 \$ 是否没闭合；只挑像公式起始的 \$，避免把「$5」这类货币写法算进来。 */
function unclosedInlineMath(plain) {
  const masked = plain
    .replace(/\$\$[\s\S]*?\$\$/g, (block) => ' '.repeat(block.length))
    .replace(/\\\[[\s\S]*?\\\]/g, (block) => ' '.repeat(block.length))
    .replace(/\\\([\s\S]*?\\\)/g, (block) => ' '.repeat(block.length))
  let open = -1
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== '$') continue
    let slashes = 0
    for (let j = i - 1; j >= 0 && masked[j] === '\\'; j -= 1) slashes += 1
    if (slashes % 2 === 1) continue
    const next = masked[i + 1] ?? ''
    const previous = masked[i - 1] ?? ''
    // 货币/普通美元：$5、$ 5 都不当公式起点
    const candidate = /[A-Za-z\\{(_^]/.test(next) && !/[A-Za-z0-9]/.test(previous) ? true : false
    if (candidate && open === -1) open = i
    else if (open !== -1) open = -1
  }
  return open
}

/** 页面真实引用的脚本/样式/媒体（注释里的字不算）。 */
function resourceRefs(text) {
  const refs = { scripts: [], styles: [], links: [], images: [], media: [] }
  for (const hit of matches(text, /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
    refs.scripts.push({ kind: 'script', index: hit.index, ref: hit.match[1] ?? hit.match[2] })
  }
  for (const hit of matches(text, /<link\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
    refs.links.push({ kind: 'link', index: hit.index, ref: hit.match[1] ?? hit.match[2] })
  }
  for (const hit of matches(text, /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
    refs.images.push({ kind: 'image', index: hit.index, ref: hit.match[1] ?? hit.match[2] })
  }
  // 媒体：视频本体与封面、音频、<source>、字幕轨道。课堂清单收它们，但漏写时发布不报错，
  // 所以这里补一条本地缺失检查，别让一节"看动画"的课在课堂里静悄悄 404。
  for (const hit of matches(text, /<video\b([^>]*)>/gi)) {
    const attrs = hit.match[1] ?? ''
    for (const attr of ['src', 'poster']) {
      const found = new RegExp('\\b' + attr + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(attrs)
      if (found !== null) refs.media.push({ kind: 'media', index: hit.index, ref: found[1] ?? found[2] })
    }
  }
  for (const hit of matches(text, /<(audio|source|track)\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)) {
    refs.media.push({ kind: 'media', index: hit.index, ref: hit.match[2] ?? hit.match[3] })
  }
  return refs
}

/**
 * 发布链的资源边界必须在 lint 阶段就报。
 * teach_commit 用 scanLocalAssets + resolveInside 判越界并直接拒绝；如果 lint 不查，
 * 模型就会看到「0 个硬伤」然后卡在最后一步——所以两边共用同一个判定函数。
 */
export function lintOutsideWorkspaceRefs(text, file, root) {
  const issues = []
  const baseDir = path.dirname(file)
  const refs = resourceRefs(text)
  const all = [...refs.scripts, ...refs.links, ...refs.images, ...refs.media]
  for (const entry of all) {
    if (/^(?:[a-z]+:|#|\/\/)/i.test(entry.ref)) continue
    // 路径根本不存在时由既有的「本地资源不存在」报一次就够了，不在这里重复报；
    // 越界报错留给「文件真的在、但不在工作区里」这种发布才拦得住的情况。
    if (!fs.existsSync(path.resolve(baseDir, refName(entry.ref)))) continue
    try {
      resolveInside(root, baseDir, refName(entry.ref))
    } catch (error) {
      issues.push({
        line: lineOf(text, entry.index),
        level: 'error',
        code: 'ref-outside-workspace',
        message: `资源不在工作区内（发布会被拒）：${entry.ref}`
      })
    }
  }
  return issues
}

/** 找 .quiz 容器：支持单/双引号 class，并按 div 嵌套深度找真正的结束标签。 */
function quizBlocks(text) {
  const blocks = []
  const opens = matches(text, /<div\b[^>]*\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)
  for (const hit of opens) {
    const className = hit.match[1] ?? hit.match[2] ?? ''
    if (!/(^|\s)quiz(\s|$)/.test(className)) continue
    const bodyStart = hit.index + hit.match[0].length
    let depth = 1
    let end = text.length
    const nested = /<div\b[^>]*>|<\/div>/gi
    nested.lastIndex = bodyStart
    let step = nested.exec(text)
    while (step !== null) {
      if (step[0].startsWith('</')) depth -= 1
      else depth += 1
      if (depth === 0) {
        end = step.index + step[0].length
        break
      }
      step = nested.exec(text)
    }
    blocks.push({ index: hit.index, open: hit.match[0], block: text.slice(hit.index, end) })
  }
  return blocks
}

/** quiz 里的可取值控件（input/select/textarea）：多选用 data-multi="1" 的 checkbox 承载。 */
function quizControls(block) {
  const controls = []
  for (const hit of matches(block, /<(input|select|textarea)\b[^>]*>/gi)) {
    const tag = hit.match[1].toLowerCase()
    const text = hit.match[0]
    const typeAttr = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(text)
    const declared = typeAttr === null ? '' : (typeAttr[1] ?? typeAttr[2] ?? typeAttr[3] ?? '')
    const type = tag === 'input' ? (declared === '' ? 'text' : declared.toLowerCase()) : tag
    // hidden/submit/button/reset 不是「学习者能填的答案」
    if (tag === 'input' && (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset')) continue
    controls.push({ tag, type, index: hit.index, ok: /\bdata-ok\s*=\s*(?:"1"|'1'|1)(?=[\s>])/i.test(text) })
  }
  return controls
}

/** 抽 quiz 里的 radio：correct 只认 input[type=radio][data-ok=1]。 */
function quizRadios(block) {
  const radios = []
  for (const hit of matches(block, /<input\b[^>]*>/gi)) {
    const tag = hit.match[0]
    const type = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    if ((type?.[1] ?? type?.[2] ?? type?.[3] ?? '').toLowerCase() !== 'radio') continue
    const name = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)
    radios.push({
      index: hit.index,
      name: name?.[1] ?? name?.[2] ?? name?.[3] ?? '',
      correct: /\bdata-ok\s*=\s*(?:"1"|'1'|1)(?=[\s>])/i.test(tag)
    })
  }
  return radios
}


/** 去掉 <script>/<style>/<pre>/<code> 区域，避免误判。 */
function stripRawBlocks(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, (block) => ' '.repeat(block.length))
    .replace(/<style[\s\S]*?<\/style>/gi, (block) => ' '.repeat(block.length))
    .replace(/<pre[\s\S]*?<\/pre>/gi, (block) => ' '.repeat(block.length))
    .replace(/<code[\s\S]*?<\/code>/gi, (block) => ' '.repeat(block.length))
}

/** 行内 $…$ 是不是公式；「$5 和 $10」这种货币写法不算。 */
function looksLikeInlineMath(body) {
  const trimmed = body.trim()
  if (trimmed === '') return false
  if (/[\\^_{}=+*/<>|]/.test(body)) return true
  return !/\s/.test(trimmed)
}

/** 把数学区间挖空（保留长度，行号不变）。 */
function maskMath(text) {
  let masked = text.replace(/\$\$[\s\S]*?\$\$/g, (block) => ' '.repeat(block.length))
  masked = masked.replace(/\\\[[\s\S]*?\\\]/g, (block) => ' '.repeat(block.length))
  masked = masked.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (block, _prefix, body) =>
    looksLikeInlineMath(body) ? ' '.repeat(block.length) : block
  )
  masked = masked.replace(/\\\([\s\S]*?\\\)/g, (block) => ' '.repeat(block.length))
  return masked
}

/** 抽出所有数学片段。 */
function mathSegments(text) {
  const out = []
  const display = [/\$\$[\s\S]*?\$\$/g, /\\\[[\s\S]*?\\\]/g, /\\\([\s\S]*?\\\)/g]
  for (const regex of display) {
    for (const hit of matches(text, regex)) out.push(hit.match[0])
  }
  for (const hit of matches(text, /(^|[^\\$])\$([^$\n]+?)\$/g)) {
    if (looksLikeInlineMath(hit.match[2])) out.push('$' + hit.match[2] + '$')
  }
  return out
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line += 1
  return line
}

const CHINESE_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/**
 * 把「3」「十二」「二十三」「二十四」这类题数说法转成数字；认不出来给 undefined。
 * 只做两位以内的整数：页面里的题数声明不会更大，猜错不如不报。
 */
function countOfClaim(raw) {
  const text = String(raw)
  if (/^[0-9]+$/.test(text)) return Number(text)
  if (!/^[一二两三四五六七八九十]+$/.test(text)) return undefined
  if (text === '十') return 10
  const ten = text.indexOf('十')
  if (ten === -1) return text.length === 1 ? CHINESE_DIGITS[text] : undefined
  const head = ten === 0 ? 1 : CHINESE_DIGITS[text.slice(0, ten)]
  const tail = ten === text.length - 1 ? 0 : CHINESE_DIGITS[text.slice(ten + 1)]
  if (head === undefined || tail === undefined) return undefined
  return head * 10 + tail
}

/** 查一个 HTML 文件。 */
export function lintHtml(text, file) {
  const issues = []
  const add = (index, level, code, message) => {
    issues.push({ line: lineOf(text, index), level, code, message })
  }

  const plain = stripRawBlocks(text)
  const masked = maskMath(plain)

  // 页面依赖与样式表：只看真实标签（注释里写过不算）。样式表用来查类名与骨架。
  const refs = resourceRefs(text)
  const styleTexts = styleTextsOf(text, file, refs)
  const styleIndex = { selectors: new Map(), pseudoContent: new Map(), available: false }
  for (const css of styleTexts) parseStylesheet(css, styleIndex.selectors, styleIndex.pseudoContent)
  styleIndex.available = styleIndex.selectors.size > 0
  const elements = elementsOf(plain)
  // 课程页专属的检查（目标、目录、复述题、课中出力、外链）；参考页只查结构
  const lessonScope = /(^|\/)lessons\//.test(String(file).replace(/\\/g, '/')) || elements.some((element) => element.classes.includes('goals'))

  // 0. 控制字符（反斜杠被转义的痕迹；被吃掉的 LaTeX 命令单独精确报）
  const escaped = escapedLatexIn(plain, add)
  controlCharsIn(text, add, escaped)

  // 1. 占位符残留
  for (const hit of matches(plain, /[〔〕]/g)) add(hit.index, 'error', 'placeholder', '还有〔…〕占位符没换掉')

  // 2. 裸 LaTeX：公式外出现命令
  for (const hit of matches(masked, MATH_COMMANDS)) add(hit.index, 'error', 'bare-latex', `公式命令 \\${hit.match[1]} 出现在公式定界符之外，渲染出来是原文`)

  // 3. 上下标 HTML
  for (const hit of matches(masked, /<su[bp]>/gi)) add(hit.index, 'warn', 'html-subsup', '上下标写在 HTML 里；公式请用 LaTeX（$…$ 或 $$…$$），中文说明才用正文')

  // 4. 公式里的中文
  for (const segment of mathSegments(plain)) {
    if (CJK.test(segment)) {
      const index = plain.indexOf(segment)
      add(index === -1 ? 0 : index, 'error', 'cjk-in-math', `公式里出现中文：${segment.slice(0, 24)}…；中文放在正文，公式只放符号`)
    }
  }

  // 4b. 公式里被多转义一层（\\mathbf 这种）：MathJax 会把 \\ 当换行、宏名变正文，整页公式失效。
  // 这是 E1 实验里真实踩到的坑：lint 原来抓不到，页面看起来"0 硬伤"却全是坏公式。
  for (const segment of mathSegments(plain)) {
    const hit = /[\\][\\][A-Za-z]/.exec(segment)
    if (hit !== null) {
      const index = plain.indexOf(segment)
      add(
        index === -1 ? 0 : index,
        'error',
        'double-escaped-latex',
        '公式里出现『双反斜杠 + 字母』（' + hit[0] + '）：MathJax 会把双反斜杠当换行，宏失效；源文件里只写一个反斜杠'
      )
    }
  }

  // 5. 成对性
  const displayCount = (plain.match(/\$\$/g) ?? []).length
  if (displayCount % 2 !== 0) add(0, 'error', 'unbalanced', '$$ 个数是奇数，有一个公式没闭合')
  const unclosed = unclosedInlineMath(plain)
  if (unclosed !== -1) add(unclosed, 'error', 'unbalanced-inline', '行内公式的 $ 没有闭合：从这里往后会被 MathJax 当成公式')

  // 6. 页面依赖：只看真实的 script/link 标签，注释里写过不算
  const hasMath = mathSegments(plain).length > 0
  if (hasMath && !refs.scripts.some((entry) => refName(entry.ref).endsWith('tex-svg.js'))) {
    add(0, 'error', 'no-mathjax', '页里有公式但没引 tex-svg.js（MathJax），打开看到的是裸 TeX')
  }
  if (!refs.scripts.some((entry) => refName(entry.ref).endsWith('course.js'))) {
    add(0, 'error', 'no-course-js', '没引 course.js：自测不会判卷、侧栏不会高亮、公式/表格复制按钮也不会出现')
  }
  if (!refs.links.some((entry) => refName(entry.ref).endsWith('course.css'))) {
    add(0, 'error', 'no-course-css', '没引 course.css：页面会落回浏览器默认样式')
  }
  // 6b. 本地依赖必须真的存在（只查相对/绝对路径；http、data、# 跳过）
  for (const entry of [...refs.scripts, ...refs.links, ...refs.images, ...refs.media]) {
    if (/^(?:[a-z]+:|#|\/\/)/i.test(entry.ref)) continue
    const target = path.resolve(path.dirname(file), refName(entry.ref))
    if (!fs.existsSync(target)) {
      const code = entry.kind === 'image' ? 'img-missing' : entry.kind === 'link' ? 'link-missing' : entry.kind === 'media' ? 'media-missing' : 'script-missing'
      const label = entry.kind === 'image' ? '图片' : entry.kind === 'media' ? '媒体' : '依赖'
      add(entry.index, 'error', code, `本地${label}不存在：${entry.ref}`)
    }
  }

  // 7. 表格缺表头（复制 Markdown 时表头会丢）
  for (const hit of matches(plain, /<table\b/gi)) {
    const slice = plain.slice(hit.index, hit.index + 4000)
    const end = slice.indexOf('</table>')
    const tableHtml = end === -1 ? slice : slice.slice(0, end)
    if (!/<thead\b/i.test(tableHtml)) add(hit.index, 'warn', 'table-no-thead', '表格没有 <thead>：复制成 Markdown 时会少一行表头，前端也不给样式')
  }

  // 8. 自测题可判分：按真实 DOM 结构查，不看字符串里出现过几个 data-ok
  for (const quiz of quizBlocks(plain)) {
    const radios = quizRadios(quiz.block)
    const controls = quizControls(quiz.block)
    // 多选题：.quiz 带 data-multi="1"，正确项可以有多条，落在 radio 或 checkbox 上都算。
    const multi = /\bdata-multi\s*=\s*(?:"1"|'1'|1)(?=[\s>])/i.test(quiz.open)
    const answerMarkers = controls.filter((control) => control.ok && (control.type === 'radio' || (multi && control.type === 'checkbox')))
    const correct = radios.filter((radio) => radio.correct)
    // 本地判分只认 radio 与「data-multi 的 checkbox」；两者都没有的题只走课堂提交，不要求 data-ok。
    const locallyGradable = radios.length > 0 || (multi && controls.some((control) => control.type === 'checkbox'))
    const markerCount = (quiz.block.match(/\bdata-ok\s*=\s*(?:"1"|'1'|1)(?=[\s>])/gi) ?? []).length
    if (markerCount > answerMarkers.length) {
      add(
        quiz.index,
        'error',
        'quiz-correct-target',
        multi
          ? '正确标记 data-ok="1" 必须写在 <input type="radio"> 或 <input type="checkbox">（data-multi="1" 的多选题）上；写在别的元素上判卷读不到'
          : '正确标记 data-ok="1" 必须写在 <input type="radio"> 上；写在别的元素上判卷读不到'
      )
    } else if (locallyGradable && (multi ? answerMarkers.length < 1 : correct.length !== 1)) {
      add(
        quiz.index,
        'error',
        'quiz-correct',
        multi
          ? '这道多选题一个正确项都没有：data-multi="1" 时正确项至少 1 个（可以有多条 data-ok="1"，radio 或 checkbox 都行）'
          : `这道自测题的正确项有 ${correct.length} 个，必须恰好 1 个（放在 input[type=radio][data-ok="1"] 上）`
      )
    }
    if (radios.length === 0) {
      // 课堂能提交的取值协议比 radio 宽（checkbox/select/输入框）；本地判分才依赖控件类型。
      const usable = controls.filter(
        (control) =>
          control.type === 'checkbox' ||
          control.type === 'select' ||
          control.type === 'textarea' ||
          /^(?:text|number|range|search|email|url|tel)$/.test(control.type)
      )
      if (usable.length === 0) {
        add(quiz.index, 'error', 'quiz-no-radio', '这道自测题没有任何可取值控件（radio / checkbox / select / 输入框）：课堂里提交拿不到答案')
      } else if (multi && usable.some((control) => control.type === 'checkbox')) {
        add(
          quiz.index,
          'warn',
          'quiz-no-radio',
          '这道多选题没有 input[type="radio"]（data-multi="1" 的 checkbox 也可以）：本地判分按 data-multi="1" 的 checkbox 集合比对，单选仍应用 radio'
        )
      } else {
        add(
          quiz.index,
          'warn',
          'quiz-no-radio',
          '这道自测题没有 input[type="radio"]：课堂里可以提交（取值协议支持 checkbox/select/输入框），但本地 course.js 不判分；要本地判分请用 radio'
        )
      }
    } else {
      const names = new Set(radios.map((radio) => radio.name))
      if (names.size > 1) {
        add(quiz.index, 'error', 'quiz-radio-group', '同一道题的 radio 必须共用一个 name（当前有多个分组，会互相干扰）')
      } else if ([...names][0] === '') {
        add(quiz.index, 'error', 'quiz-radio-group', 'radio 没有 name：浏览器不会把它们当成同一道题')
      }
    }
    if (!/data-explain\s*=/.test(quiz.open)) add(quiz.index, 'warn', 'quiz-explain', '这道自测题没有 data-explain：判对之后学习者看不到解释')
    // 课堂挂点：没有 data-question-id 的 quiz 在课堂模式下不会出现「提交到课堂」，只是提醒不是硬伤。
    if (!/data-question-id\s*=/.test(quiz.open)) {
      add(
        quiz.index,
        'warn',
        'quiz-question-id',
        '这道自测题没有 data-question-id：课堂提交不会挂上。顺序固定：定 id → 写页面 → teach_lesson_publish({dryRun:true}) 核对资源、题目 id 与课堂挂点 → 正式 publish → teach_question_register 用同一个 id 登记 → 最后 teach_lesson_open 打开课堂；登记后不要重新发布（课堂与侧栏读的是登记后的档案，立即生效；重发会让已打开的课堂失效）'
      )
    }
    // 口径：写在 data-scope 里、题干里有一句「口径」、或本小节标题之后先交代过口径，都算
    const headingStart = Math.max(plain.lastIndexOf('<h2', quiz.index), plain.lastIndexOf('<section', quiz.index), 0)
    const context = plain.slice(headingStart, quiz.index)
    if (!/data-scope\s*=/.test(quiz.block) && !/口径/.test(quiz.block) && !/口径/.test(context)) {
      add(quiz.index, 'warn', 'quiz-scope', '这道自测题没写口径：用 data-scope 或题干里一句「口径：」说清怎么算，否则同一道题能算出两个数')
    }
  }

  // 8a. 页面自己写「提交到课堂」按钮：桥会补一个并认领手写的这只，但作者写的通常是死按钮，
  // 而且会和桥补的按钮并排出现两个。要么加 data-teach-submit（桥接管，只此一只），要么删掉。
  for (const hit of text.matchAll(/<button\b([^>]*)>([\s\S]{0,120}?)<\/button>/gi)) {
    const attrs = hit[1]
    const label = String(hit[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, '')
    if (!/提交(到)?课堂|提交作答/.test(label)) continue
    if (/data-teach-submit/.test(attrs)) continue
    add(
      hit.index ?? 0,
      'warn',
      'quiz-manual-submit',
      '页面自己写了「提交到课堂」按钮：课堂桥会自动补一只，两只会并排出现（手写的那只默认不生效）。要么给这只按钮加 data-teach-submit（桥会接管它），要么删掉这一行'
    )
  }

  // 8b. 页面里声称的题数 vs 实际题数（自报数字要能对上；「三道题」与「三题」都算）
  const actual = quizSummary(text).length
  const claimPattern = /([0-9]+|[一二两三四五六七八九十]+)\s*(?:道\s*)?(?:自测|验收|选择|练习)?题/g
  // 「第一题」是序号，「每题」「另一题」「再来一题」是数量短语，都不是「这一页有几题」的声明。
  const INDEX_LIKE = new Set(['第', '每', '另', '哪', '再', '做', '剩', '还', '差'])
  for (const hit of matches(plain, claimPattern)) {
    if (INDEX_LIKE.has(plain[hit.index - 1] ?? '')) continue
    const claimed = countOfClaim(hit.match[1])
    if (typeof claimed !== 'number') continue
    // 不带「道」的「一题」多半是「再来一题」这类短语，不当题数声明。
    if (!/道/.test(hit.match[0]) && claimed === 1) continue
    if (claimed !== actual) {
      add(
        hit.index,
        'warn',
        'quiz-count-claim',
        `页面里说「${hit.match[0]}」，实际有 ${actual} 道 .quiz 自测题：交付前把数字对齐（或改掉说法）`
      )
    }
    break
  }

  // 9. 本地图片是否存在（单双引号都认；缺失并入 6b，不重复报）

  // 10. 结构与样式上下文（页面自己的样式表说了算，不比对模板）
  classIssues(elements, styleIndex, add)
  goalsIssues(text, elements, styleIndex, add)
  shellIssues(elements, add)
  tocIssues(text, elements, add)
  // 10b. 课程页专属：外链、课中出力、验收题复述
  if (lessonScope) {
    resourceLinkIssues(plain, add)
    const check = checkSectionOf(text)
    studentOutputIssues(plain, check, add)
    restateIssues(plain, check, add)
  }

  return issues
}

/** 去掉 ``` 围栏代码块（Markdown 用）。 */
function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, (block) => ' '.repeat(block.length))
}

/**
 * 查一个 Markdown 文件（学习记录、笔记）。
 * 只查「坏掉的标记」：控制字符、公式定界符成对、公式外裸 LaTeX、公式里的中文，
 * 以及学习记录里写错的日期年份（传 options.today 可固定「今天」，测试用）。
 */
export function lintMarkdown(text, file, options = {}) {
  const issues = []
  const add = (index, level, code, message) => {
    issues.push({ line: lineOf(text, index), level, code, message })
  }

  const plain = stripFences(text)
  const escaped = escapedLatexIn(plain, add)
  controlCharsIn(text, add, escaped)

  const displayCount = (plain.match(/\$\$/g) ?? []).length
  if (displayCount % 2 !== 0) add(0, 'error', 'unbalanced', '$$ 个数是奇数，有一个公式没闭合')
  const unclosed = unclosedInlineMath(plain)
  if (unclosed !== -1) add(unclosed, 'error', 'unbalanced-inline', '行内公式的 $ 没有闭合')

  const masked = maskMath(plain)
  for (const hit of matches(masked, MATH_COMMANDS)) {
    add(hit.index, 'error', 'bare-latex', `公式命令 \\${hit.match[1]} 出现在公式定界符之外，渲染出来是原文`)
  }
  for (const segment of mathSegments(plain)) {
    if (CJK.test(segment)) {
      const index = plain.indexOf(segment)
      add(index === -1 ? 0 : index, 'error', 'cjk-in-math', `公式里出现中文：${segment.slice(0, 24)}…`)
    }
  }
  for (const segment of mathSegments(plain)) {
    const hit = /[\\][\\][A-Za-z]/.exec(segment)
    if (hit !== null) {
      const index = plain.indexOf(segment)
      add(index === -1 ? 0 : index, 'error', 'double-escaped-latex', '公式里出现『双反斜杠 + 字母』（' + hit[0] + '）：MathJax 会当换行，宏失效')
    }
  }
  dateYearDriftIssues(text, file, add, options?.today)
  return issues
}

/** 按扩展名分派。 */
export function lintFile(text, file, options = {}) {
  return /\.md$/i.test(file) ? lintMarkdown(text, file, options) : lintHtml(text, file)
}

/** 从 HTML 里抽自测题（给交付报告用；嵌套 div 与单引号也能正确切开）。 */
export function quizSummary(text) {
  const items = []
  for (const quiz of quizBlocks(text)) {
    const question = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(quiz.block)
    const label = (open) => {
      const value = open.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return value.slice(0, 80)
    }
    items.push({
      line: lineOf(text, quiz.index),
      stem: question === null ? '' : label(question[1]),
      hasExplain: /data-explain\s*=/.test(quiz.open),
      correct: quizRadios(quiz.block).filter((radio) => radio.correct).length
    })
  }
  return items
}

/**
 * 注册 lesson_lint 工具。
 * @param {object} ctx 预设作用域上下文
 * @param {object} config 配置
 * @param {Function} resolveBase 返回当前会话工作目录的函数
 */
export function registerLintTool(ctx, config, resolveBase) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (!config.tools.lint || tools === undefined || tools === null) return

  ctx.effect(
    () =>
      tools.register({
        name: 'lesson_lint',
        description:
          'Lint lesson HTML (and Markdown such as learning records) before delivering. Catches the machine-visible defects: ' +
          'leftover 〔…〕 placeholders, bare LaTeX outside math delimiters, CJK inside formulas, missing ' +
          'MathJax/course.js/course.css, tables without <thead>, quizzes without exactly one correct option (a ' +
          'data-multi="1" multi-select quiz needs at least one data-ok on a radio or checkbox), quizzes with no answer ' +
          'control at all, radio-free quizzes with other controls (warn only: classroom can submit, local grading needs ' +
          'radio), without a 口径 line or without data-question-id (no classroom submit hook), quiz-count claims that ' +
          'disagree with the ' +
          'page (Arabic or Chinese numerals), control characters left by escaped LaTeX, missing local images. ' +
          'Also checks page structure against its own stylesheet: a .goals heading duplicated by CSS ::before, class ' +
          'names with no rule (or only styled in another context), div.shell without aside.sidenav, sidenav/nav.toc ' +
          'entries and labels drifting apart, resource sections with no external link, a page with no mid-lesson ' +
          'student-output spot, acceptance questions whose numbers all restate the body, and record files whose date ' +
          'year looks like a typo. ' +
          'Pass a file, several files, or a directory (defaults to ./lessons, plus ./reference when it exists).',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: '要查的文件或目录；省略时查当前工作目录下的 lessons/（reference/ 存在时也一起查）。'
            }
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'errors', 'warnings', 'files'],
            properties: {
              text: { type: 'string', description: '人读报告。' },
              errors: { type: 'integer', description: '硬伤条数。' },
              warnings: { type: 'integer', description: '提醒条数。' },
              files: { type: 'integer', description: '查了几个文件。' }
            }
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
        },
        async execute(args, exec) {
          const base = resolveBase(exec?.agent)
          // 默认连参考页一起查：术语表/路线图也在 reference/ 下，只查 lessons/ 会漏掉骨架与类名问题。
          const defaults = ['lessons']
          try {
            if (fs.statSync(path.resolve(base, 'reference')).isDirectory()) defaults.push('reference')
          } catch {
            // 没有 reference/ 就只查 lessons/
          }
          const requested = Array.isArray(args?.paths) && args.paths.length > 0 ? args.paths : defaults
          const files = []
          for (const item of requested) {
            const target = path.isAbsolute(item) ? item : path.resolve(base, item)
            const stat = fs.existsSync(target) ? fs.statSync(target) : undefined
            if (stat === undefined) {
              files.push({ file: target, missing: true })
              continue
            }
            if (stat.isDirectory()) {
              // *.spec.json 一起查：spec 是课程源文件，漏查它等于漏查半个交付面。
              const wanted = (entry) => entry.endsWith('.html') || entry.endsWith('.md') || entry.endsWith('.spec.json')
              for (const name of fs.readdirSync(target).filter(wanted).sort()) {
                files.push({ file: path.join(target, name), missing: false })
              }
            } else {
              files.push({ file: target, missing: false })
            }
          }

          const lines = []
          let errors = 0
          let warnings = 0
          let count = 0
          for (const entry of files) {
            if (entry.missing) {
              lines.push(`× 找不到：${entry.file}`)
              errors += 1
              continue
            }
            const text = fs.readFileSync(entry.file, 'utf8')
            count += 1
            const label = path.relative(base, entry.file) || entry.file
            // spec 文件：先查 schema 与编译，再按编译产物查页面（与 teach_commit 的 spec 路线同一道门）。
            let target = entry.file
            let source = text
            if (/\.json$/i.test(entry.file)) {
              try {
                const raw = JSON.parse(text)
                validateSpec(raw)
                source = compileSpec(raw).html
                target = entry.file.replace(/\.json$/i, '.html')
              } catch (error) {
                errors += 1
                lines.push(`× ${label}`)
                lines.push(`  ${label}:0 [硬伤] spec 不合法：${error instanceof Error ? error.message : String(error)}`)
                continue
              }
            }
            const issues = lintFile(source, target)
            // 页面里的本地引用必须落在工作区内：与 teach_commit 的资源扫描同一判定，
            // 否则模型会拿「0 硬伤」交付、到发布才被拒。
            if (/\.html?$/i.test(target)) issues.push(...lintOutsideWorkspaceRefs(source, target, base))
            if (issues.length === 0) {
              const quizzes = /\.html?$/i.test(target) ? `（${quizSummary(source).length} 道自测）` : ''
              lines.push(`✓ ${label}${quizzes}`)
              continue
            }
            lines.push(`${issues.some((issue) => issue.level === 'error') ? '×' : '!'} ${label}`)
            for (const issue of issues.sort((left, right) => left.line - right.line)) {
              if (issue.level === 'error') errors += 1
              else warnings += 1
              lines.push(`  ${label}:${issue.line} [${issue.level === 'error' ? '硬伤' : '提醒'}] ${issue.message}`)
            }
          }
          // 清单按工作区所有课程取并集，共享资源不能按单课认作未登记。
          // 逐条列 actionable 的问题（缺失/哈希/链接/扫描上限）；"未登记"按目录聚成一行——
          // 一个工作区放几十张配图时，逐条列会把 lint 输出刷成一屏，模型反而看不见真问题。
          const drift = inspectAssetDrift(base)
          const driftErrors = drift.issues.filter((issue) => issue.level === 'error')
          const unregistered = drift.issues.filter((issue) => issue.code === 'asset-unregistered' || issue.code === 'asset-link')
          const otherWarns = drift.issues.filter((issue) => issue.level === 'warn' && !unregistered.includes(issue))
          if (driftErrors.length > 0 || otherWarns.length > 0 || unregistered.length > 0) {
            lines.push('', '资产 drift（工作区全部已发布课程；只报告不修复）：')
            for (const issue of [...driftErrors, ...otherWarns]) {
              lines.push(`  ${issue.path}:0 [${issue.level === 'error' ? '硬伤' : '提醒'}] ${issue.message}`)
            }
            if (unregistered.length > 0) {
              const examples = unregistered.slice(0, 3).map((issue) => issue.path).join('、')
              const more = unregistered.length > 3 ? ` 等 ${unregistered.length} 个` : ''
              lines.push(`  assets/:0 [提醒] ${unregistered.length} 个未登记文件（示例：${examples}${more}；可能属于用户，也可能是忘记重新发布）`)
            }
            errors += drift.errors
            warnings += drift.warnings
          }
          lines.push('', `共 ${count} 个页面/记录文件：${errors} 个硬伤、${warnings} 条提醒。`)
          if (drift.issues.length > 0) lines.push(`（其中资产 drift 贡献 ${drift.errors} 个硬伤、${drift.warnings} 条提醒，不在上面的文件计数里）`)
          return { text: lines.join('\n'), errors, warnings, files: count }
        }
      }),
    'teach-me.tool(lesson_lint)'
  )
}
