/* 课堂离线导出：把课程页变成可单独打开的一份 HTML。
 *
 * 只内联已发布清单里的本地资源；视频超过 8MiB 不内联（保留原引用并在摘要里说明）。
 * 进度以 application/json 嵌进页面；导入时只作为 self_report，不直接算通过。
 * 0.6.2：CSS 内部的 url()/@import 也要内联（否则离线页的相对路径没有基准），
 * 页面里再补「记下这次作答」与「下载学习进度 JSON」，让离线也能闭环。 */

import path from 'node:path'
import { inlineCssDataUris, inlineStyleBlocks } from '../archive/css-refs.js'
import { verdictViewOf } from '../archive/state.js'
import { mimeFor, readPublishedAsset } from './assets.js'

/** 视频超过这个大小不内联：data URI 会让离线页大到打不开。 */
const MAX_VIDEO_INLINE = 8 * 1024 * 1024
/** @import 嵌套 CSS 的深度上限（防递归炸弹；环用 visited 挡）。 */
const MAX_CSS_DEPTH = 8

export function lessonQuestionsOf(state, lessonId) {
  return Object.values(state.questions)
    .filter((question) => question.lessonId === lessonId && question.status !== 'retired')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}

export function questionView(question) {
  return {
    id: question.id,
    revision: question.revision,
    type: question.type,
    prompt: question.prompt,
    prerequisite: question.prerequisite,
    options: Array.isArray(question.options) ? question.options : [],
    materials: Array.isArray(question.materials) ? question.materials : []
  }
}

export function progressOf(state, lessonId) {
  const questions = lessonQuestionsOf(state, lessonId)
  const submissions = Object.values(state.submissions).filter((item) => item.lessonId === lessonId)
  return {
    version: 1,
    workspaceId: state.workspaceId,
    lessonId,
    collectionId: state.collectionId ?? 'default',
    ...(state.lessons[lessonId]?.contentVersion ? { contentVersion: state.lessons[lessonId].contentVersion } : {}),
    revision: state.lessons[lessonId]?.revision ?? 0,
    questions: questions.map(questionView),
    submissions: submissions.map((submission) => ({
      id: submission.id,
      questionId: submission.questionId,
      questionRevision: submission.questionRevision,
      rawAnswer: submission.rawAnswer,
      submittedAt: submission.submittedAt,
      assessmentId: submission.latestAssessmentId ?? null,
      // 结论走 verdictViewOf：离线页的「通过 N 次」只数仍有效的结论，
      // 已失效的旧通过单独标「已失效 M」，不混进通过数。
      ...verdictViewOf(state, submission)
    })),
    // 离线页写回本机的形状：只要题目与原始作答，导入时当自报用（与导出文件 items 同形）。
    items: submissions.map((submission) => ({
      questionId: submission.questionId,
      rawAnswer: submission.rawAnswer,
      submittedAt: submission.submittedAt
    })),
    selfReports: Object.values(state.selfReports).filter((report) => state.questions[report.questionId]?.lessonId === lessonId)
  }
}

/**
 * 一次批量写入学习自报：单个 journal 条目 + 单次 fsync。
 * 逐条 transact 会让「导入 300 条」变成 300 次加锁/落盘；这里改成一次事务。
 * items 由调用方（lib/classroom/service.js）先校验：id 合法、claim 非空、题目属于目标课。
 * 幂等口径与 recordSelfReport 一致：同 id 同内容 = 跳过；同 id 不同内容 = 跳过并把原因带回，
 * 绝不静默覆盖旧记录。空列表不产生任何写入。
 */
export function importSelfReports(archive, items) {
  if (!Array.isArray(items) || items.length === 0) return { imported: 0, skipped: 0, error: '' }
  const result = archive.transact('classroom_import', undefined, (draft) => {
    const changes = []
    const seen = new Set()
    let skipped = 0
    let conflict = ''
    for (const item of items) {
      if (seen.has(item.id)) {
        skipped += 1
        continue
      }
      seen.add(item.id)
      const existing = draft.selfReports[item.id]
      if (existing !== undefined) {
        if (existing.claim !== item.claim || existing.questionId !== item.questionId) {
          if (conflict === '') conflict = '幂等键 ' + item.id + ' 已经用于另一份内容；不能静默覆盖旧记录。'
        }
        skipped += 1
        continue
      }
      changes.push({ type: 'self_report.recorded', data: { id: item.id, questionId: item.questionId, objectiveId: null, claim: item.claim } })
    }
    return { changes: changes, result: { imported: changes.length, skipped: skipped, conflict: conflict } }
  })
  return {
    imported: Number.isInteger(result.imported) ? result.imported : 0,
    skipped: Number.isInteger(result.skipped) ? result.skipped : 0,
    error: typeof result.conflict === 'string' ? result.conflict : ''
  }
}

/** 在已发布清单里按工作区相对路径找一项。 */
function manifestOf(lesson, relative) {
  return lesson.assets.find((item) => item.path === relative)
}

/**
 * 把一个清单项读成 data URI。
 * .css 会递归重写它自己的 url()/@import（基准 = 该 CSS 所在目录），
 * 找不到的、成环的、超过深度上限的原样保留；哈希不符照旧抛错。
 * 返回 null 表示「这一条内联不了，保留原引用」。
 */
function inlineOne(root, lesson, asset, visited, depth) {
  const checked = readPublishedAsset(root, lesson, asset.path)
  if (checked.error !== undefined) throw new Error(checked.error + ': ' + asset.path)
  const bytes = checked.bytes
  const mime = mimeFor(asset.path)
  if (mime.startsWith('video/') && bytes.length > MAX_VIDEO_INLINE) return null
  if (mime.startsWith('text/css')) {
    if (depth > MAX_CSS_DEPTH || visited.has(asset.path)) return null
    const nested = inlineCss(bytes.toString('utf8'), root, lesson, path.posix.dirname(asset.path), new Set([...visited, asset.path]), depth + 1)
    return 'data:text/css;base64,' + Buffer.from(nested, 'utf8').toString('base64')
  }
  return 'data:' + mime + ';base64,' + bytes.toString('base64')
}

/**
 * 把一段 CSS 里的本地引用换成 data URI：相对 baseDir 解析 → 在清单里找 → 内联。
 * 解析不到的返回 null（inlineCssDataUris 会原样保留那条引用）。
 */
function inlineCss(text, root, lesson, baseDir, visited, depth) {
  return inlineCssDataUris(text, (raw) => {
    const clean = String(raw ?? '').trim().split('#')[0].split('?')[0]
    if (clean === '') return null
    const target = path.posix.normalize(path.posix.join(baseDir, clean))
    const asset = manifestOf(lesson, target)
    if (asset === undefined) return null
    return inlineOne(root, lesson, asset, visited, depth)
  })
}

/** 把清单里能安全内联的本地资源换成 data URI。 */
export function inlineLessonAssets(html, root, lesson) {
  const dir = path.posix.dirname(lesson.path)
  const pattern = /(\s)(src|href|poster|data)\s*=\s*("([^"]*)"|'([^']*)')/gi
  const inlineTag = (tag) => tag.replace(pattern, (whole, space, name, _quoted, double, single) => {
    const raw = String(double ?? single ?? '').trim()
    if (raw === '' || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) return whole
    const clean = raw.split('#')[0].split('?')[0]
    if (clean === '') return whole
    const rel = path.posix.normalize(path.posix.join(dir, clean))
    const asset = manifestOf(lesson, rel)
    if (asset === undefined) return whole
    const data = inlineOne(root, lesson, asset, new Set(), 1)
    if (data === null) return whole
    return space + name + '="' + data + '"'
  })
  // 页面内 <style> 的基准是 HTML 所在目录（与外部 CSS 的「相对 CSS 目录」不同）。
  const inlineStyle = (token) => inlineStyleBlocks(token, (raw) => {
    const clean = String(raw ?? '').trim().split('#')[0].split('?')[0]
    if (clean === '') return null
    const target = path.posix.normalize(path.posix.join(dir, clean))
    const asset = manifestOf(lesson, target)
    if (asset === undefined) return null
    return inlineOne(root, lesson, asset, new Set(), 1)
  })
  // 只改真实标签的属性；raw-text/RCDATA 中的标签样例不属于资源引用。
  return html.replace(/<!--[\s\S]*?-->|<(script|style|textarea|title|xmp)\b[^>]*>[\s\S]*?<\/\1\s*>|<(?:link|img|video|audio|source|track|a|object|embed)\b[^>]*>/gi, (token) => {
    if (token.startsWith('<!--')) return token
    if (/^<script\b/i.test(token)) return token.replace(/^<script\b[^>]*>/i, inlineTag)
    if (/^<style\b/i.test(token)) return inlineStyle(token)
    if (/^<(?:textarea|title|xmp)\b/i.test(token)) return token
    return inlineTag(token)
  })
}

/** 注入进度 JSON、本机记录与下载按钮；全部在本地跑，不联网、不依赖 CSP。 */
export function offlineHtml(html, state, lesson) {
  const progress = JSON.stringify(progressOf(state, lesson.id)).replace(/</g, '\\u003c')
  const block = [
    '<script id="teach-offline-progress" type="application/json">',
    progress,
    '</script>',
    '<script>',
    '(function () {',
    '  var data = JSON.parse(document.getElementById("teach-offline-progress").textContent);',
    '  var KEY = "teach-offline:" + data.lessonId;',
    '  var localLine = null;',
    '  function readLocal() {',
    '    try {',
    '      var raw = window.localStorage.getItem(KEY);',
    '      var parsed = raw === null ? [] : JSON.parse(raw);',
    '      return Array.isArray(parsed) ? parsed : [];',
    '    } catch (error) { return []; }',
    '  }',
    '  function writeLocal(items) {',
    '    try { window.localStorage.setItem(KEY, JSON.stringify(items)); return true; } catch (error) { return false; }',
    '  }',
    '  /* 取值协议与课堂桥同一套：radio → checkbox（英文逗号连接）→ select → 文本类输入。 */',
    '  function answerOf(quiz) {',
    '    if (!quiz) return "";',
    '    var picked = quiz.querySelector(\'input[type="radio"]:checked\');',
    '    if (picked) return picked.getAttribute("value") || picked.getAttribute("data-value") || picked.id || "";',
    '    var boxes = quiz.querySelectorAll ? quiz.querySelectorAll(\'input[type="checkbox"]:checked\') : [];',
    '    if (boxes && boxes.length > 0) {',
    '      var values = [];',
    '      for (var index = 0; index < boxes.length; index += 1) {',
    '        var value = boxes[index].getAttribute("value") || boxes[index].getAttribute("data-value") || boxes[index].id || "";',
    '        if (value !== "") values.push(value);',
    '      }',
    '      return values.join(",");',
    '    }',
    '    var select = quiz.querySelector("select");',
    '    if (select) return select.value === undefined || select.value === null ? "" : String(select.value);',
    '    var free = quiz.querySelector(\'textarea, input[type="text"], input[type="number"], input[type="range"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input:not([type])\');',
    '    if (!free) return "";',
    '    return free.value === undefined || free.value === null ? "" : String(free.value);',
    '  }',
    '  function record(quiz, questionId) {',
    '    var answer = answerOf(quiz);',
    '    if (!answer.trim()) return "请先作答，再记下这次作答。";',
    '    var items = readLocal();',
    '    items.push({ questionId: questionId, rawAnswer: answer, submittedAt: new Date().toISOString() });',
    '    if (!writeLocal(items)) return "这台浏览器不允许本地存储，记不下来。";',
    '    refreshLocalLine();',
    '    return "已记在本机（" + items.length + " 条）。";',
    '  }',
    '  function knownQuestionIds() {',
    '    var map = {};',
    '    var list = Array.isArray(data.questions) ? data.questions : [];',
    '    for (var index = 0; index < list.length; index += 1) {',
    '      if (list[index] && list[index].id !== undefined && list[index].id !== null) map[String(list[index].id)] = true;',
    '    }',
    '    return map;',
    '  }',
    '  function noteFor(button, message) {',
    '    if (!button.parentNode) return;',
    '    var note = button.parentNode.querySelector(".teach-offline-note");',
    '    if (!note) {',
    '      note = document.createElement("p");',
    '      note.className = "teach-offline-note";',
    '      note.setAttribute("role", "status");',
    '      note.style.cssText = "margin:.4rem 0 0;font-size:12px;color:#666;";',
    '      button.parentNode.insertBefore(note, button.nextSibling);',
    '    }',
    '    note.textContent = message;',
    '  }',
    '  function mountRecordButtons() {',
    '    var known = knownQuestionIds();',
    '    var quizzes = document.querySelectorAll(".quiz[data-question-id]");',
    '    for (var index = 0; index < quizzes.length; index += 1) {',
    '      var quiz = quizzes[index];',
    '      var questionId = String(quiz.getAttribute("data-question-id") || "").trim();',
    '      if (!questionId || !known[questionId]) continue;',
    '      if (quiz.querySelector("[data-teach-offline-record]")) continue;',
    '      var button = document.createElement("button");',
    '      button.type = "button";',
    '      button.setAttribute("data-teach-offline-record", "");',
    '      button.setAttribute("data-question-id", questionId);',
    '      button.textContent = "记下这次作答";',
    '      button.style.cssText = "font:inherit;font-size:.85rem;padding:.4rem .8rem;margin:.5rem 0 0;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;cursor:pointer";',
    '      var verdict = quiz.querySelector(".verdict");',
    '      if (verdict && verdict.parentNode) verdict.parentNode.insertBefore(button, verdict.nextSibling);',
    '      else quiz.appendChild(button);',
    '    }',
    '  }',
    '  function refreshLocalLine() {',
    '    if (!localLine) return;',
    '    var recorded = readLocal();',
    '    var seen = {};',
    '    for (var index = 0; index < recorded.length; index += 1) {',
    '      if (recorded[index] && recorded[index].questionId !== undefined) seen[String(recorded[index].questionId)] = true;',
    '    }',
    '    localLine.textContent = "本地已记录 " + Object.keys(seen).length + " 题";',
    '  }',
    '  /* 导出：快照提交 + 本机记录按 submittedAt 排序去重，形状与导入接口一致（version 1 + items）。 */',
    '  function mergedItems() {',
    '    var merged = [];',
    '    var seen = {};',
    '    function push(item) {',
    '      if (!item || item.questionId === undefined || item.questionId === null) return;',
    '      var rawAnswer = item.rawAnswer === undefined || item.rawAnswer === null ? "" : String(item.rawAnswer);',
    '      var key = String(item.questionId) + "\\u0000" + String(item.submittedAt || "") + "\\u0000" + rawAnswer;',
    '      if (seen[key]) return;',
    '      seen[key] = true;',
    '      merged.push({ questionId: String(item.questionId), rawAnswer: rawAnswer, submittedAt: item.submittedAt || "" });',
    '    }',
    '    var snapshot = Array.isArray(data.items) ? data.items : [];',
    '    for (var index = 0; index < snapshot.length; index += 1) push(snapshot[index]);',
    '    var local = readLocal();',
    '    for (var cursor = 0; cursor < local.length; cursor += 1) push(local[cursor]);',
    '    merged.sort(function (left, right) { return String(left.submittedAt).localeCompare(String(right.submittedAt)); });',
    '    return merged;',
    '  }',
    '  function downloadProgress() {',
    '    var payload = { version: 1, workspaceId: data.workspaceId, lessonId: data.lessonId, revision: data.revision, items: mergedItems() };',
    '    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });',
    '    var url = URL.createObjectURL(blob);',
    '    var link = document.createElement("a");',
    '    link.href = url;',
    '    link.download = data.lessonId + "-r" + data.revision + "-progress.json";',
    '    document.body.appendChild(link);',
    '    link.click();',
    '    link.remove();',
    '    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);',
    '  }',
    '  document.addEventListener("click", function (event) {',
    '    var target = event.target;',
    '    var button = target && target.closest ? target.closest("[data-teach-offline-record]") : null;',
    '    if (!button) return;',
    '    var quiz = button.closest(".quiz");',
    '    var questionId = button.getAttribute("data-question-id") || (quiz && quiz.getAttribute("data-question-id"));',
    '    if (!questionId) return;',
    '    noteFor(button, record(quiz, String(questionId)));',
    '  });',
    '  var box = document.createElement("section");',
    '  box.setAttribute("data-teach-offline", "progress");',
    '  box.style.cssText = "margin:24px;padding:16px;border:1px solid #d0d0d0;border-radius:8px;font-family:system-ui;";',
    '  var passed = 0;',
    '  var expired = 0;',
    '  for (var index = 0; index < data.submissions.length; index += 1) {',
    '    var entry = data.submissions[index];',
    '    if (entry.effectiveVerdict === "passed") passed += 1;',
    '    else if (entry.verdict === "passed") expired += 1;',
    '  }',
    '  var summary = "课程 " + data.lessonId + " · revision " + data.revision +',
    '    " · 提交 " + data.submissions.length + " 次 · 通过 " + passed + " 次" + (expired > 0 ? " · 已失效 " + expired : "");',
    '  var heading = document.createElement("h2");',
    '  heading.style.cssText = "margin:0 0 8px;font-size:16px;";',
    '  heading.textContent = "离线学习档案";',
    '  var line = document.createElement("p");',
    '  line.style.cssText = "margin:0;font-size:13px;line-height:1.6;";',
    '  line.textContent = summary;',
    '  localLine = document.createElement("p");',
    '  localLine.style.cssText = "margin:6px 0 0;font-size:13px;line-height:1.6;";',
    '  var button = document.createElement("button");',
    '  button.type = "button";',
    '  button.setAttribute("data-teach-offline-download", "");',
    '  button.textContent = "下载学习进度 JSON";',
    '  button.style.cssText = "margin:10px 0 0;font:inherit;font-size:13px;padding:.4rem .9rem;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;cursor:pointer";',
    '  button.addEventListener("click", downloadProgress);',
    '  var note = document.createElement("p");',
    '  note.style.cssText = "margin:6px 0 0;font-size:12px;color:#666;";',
    '  note.textContent = "本地资源已内联；超过 8 MiB 的视频仍引用原文件。重新导入时只会记作自报，不会直接算通过。";',
    '  box.appendChild(heading);',
    '  box.appendChild(line);',
    '  box.appendChild(localLine);',
    '  box.appendChild(button);',
    '  box.appendChild(note);',
    '  document.body.appendChild(box);',
    '  refreshLocalLine();',
    '  mountRecordButtons();',
    '  document.addEventListener("teach:components-ready", mountRecordButtons);',
    '})();',
    '</script>'
  ].join('\n')
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, block + '\n</body>')
  return html + '\n' + block
}

/** 生成完整离线文件；调用方负责确认 lesson 存在。 */
export function buildOffline(root, state, lesson) {
  const source = readPublishedAsset(root, lesson, '')
  if (source.error !== undefined) throw new Error(source.error + ': ' + lesson.path)
  const html = source.bytes.toString('utf8')
  const progress = progressOf(state, lesson.id)
  return {
    html: offlineHtml(inlineLessonAssets(html, root, lesson), state, lesson),
    filename: lesson.id + '-r' + lesson.revision + '.html',
    lessonId: lesson.id,
    revision: lesson.revision,
    progress
  }
}
