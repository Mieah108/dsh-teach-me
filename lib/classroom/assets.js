import { readingBridge } from './reading-bridge.js'
/* 课堂资源：只按已发布课程的资产清单服务文件，并给 HTML 注入课堂桥。
 *
 * 路径永远相对工作区根；真实路径必须仍在根内；页面与资源的大小/哈希必须与
 * publishLesson 时记录的清单一致。HTML 额外注入 <base>（让相对图片/脚本
 * 仍按课程目录解析）和一段桥脚本（父 tab 校验 nonce 与 revision 后才提交）。 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.wav', 'audio/wav'],
  // 课程清单现在也收 <track>/<audio>/<source>：字幕必须用 text/vtt 服务，否则浏览器不加载
  ['.vtt', 'text/vtt; charset=utf-8'],
  ['.webvtt', 'text/vtt; charset=utf-8'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8']
])

export function mimeFor(file) {
  return MIME.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream'
}

function inside(root, target) {
  const realRoot = fs.realpathSync.native(root)
  const real = fs.realpathSync.native(target)
  return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null
}

/** 从档案里取已发布课程；revision 必须与 URL 票据一致。 */
export function lessonOf(archive, lessonId, revision) {
  const lesson = archive.state.lessons[lessonId]
  if (lesson === undefined) return { error: 'lesson-not-found' }
  if (lesson.revision !== revision) return { error: 'lesson-revision-stale' }
  return { lesson }
}

/**
 * 解析一次请求到工作区文件和清单项。
 * rel 是工作区相对路径；'' 表示课程首页。
 * 返回 {file, relative, manifest, html} 或 {error,status}。
 */
export function resolveAsset(root, lesson, rel) {
  const relative = rel === '' ? lesson.path : rel
  if (relative !== lesson.path) {
    const listed = Array.isArray(lesson.assets) && lesson.assets.some((item) => item.path === relative)
    if (!listed) return { error: 'asset-not-listed', status: 404 }
  }
  const absolute = path.resolve(root, relative)
  let real
  try {
    real = inside(root, absolute)
  } catch {
    return { error: 'asset-missing', status: 404 }
  }
  if (real === null) return { error: 'asset-outside-workspace', status: 403 }
  let stat
  try {
    stat = fs.statSync(real)
  } catch {
    return { error: 'asset-missing', status: 404 }
  }
  if (!stat.isFile()) return { error: 'asset-not-file', status: 404 }
  const manifest = relative === lesson.path
    ? { path: lesson.path, sha256: lesson.fingerprint, size: stat.size }
    : lesson.assets.find((item) => item.path === relative)
  if (manifest === undefined) return { error: 'asset-not-listed', status: 404 }
  if (typeof manifest.size === 'number' && manifest.size !== stat.size) return { error: 'asset-size-mismatch', status: 409 }
  if (typeof manifest.sha256 === 'string') {
    // 哈希校验在服务层读取后做（HTML 还要注入，字节会变），这里只返回清单。
  }
  return { file: real, relative, manifest, html: relative === lesson.path }
}

/** 在线与离线共用发布清单校验；大文件也必须核对哈希。 */
export function readPublishedAsset(root, lesson, rel) {
  const asset = resolveAsset(root, lesson, rel)
  if (asset.error !== undefined) return asset
  let bytes
  try {
    bytes = fs.readFileSync(asset.file)
  } catch {
    return { error: 'asset-missing', status: 404 }
  }
  if (typeof asset.manifest.sha256 === 'string' && crypto.createHash('sha256').update(bytes).digest('hex') !== asset.manifest.sha256) {
    return { error: 'asset-hash-mismatch', status: 409 }
  }
  return { ...asset, bytes }
}

/**
 * 资源读缓存的保守上限：条目数与总字节双封顶。
 * 32 MiB ≈ 15 个 2.1 MB 级别的 MathJax 资源；再大就不能只算「课堂读缓存」的内存账。
 */
export const ASSET_CACHE_LIMITS = Object.freeze({ entries: 64, bytes: 32 * 1024 * 1024 })

/** 清单里该资源的 sha256；课程首页取 lesson.fingerprint，其余取 assets[] 项。 */
function manifestShaOf(lesson, rel) {
  if (rel === lesson.path) return typeof lesson.fingerprint === 'string' ? lesson.fingerprint : undefined
  const listed = Array.isArray(lesson.assets) ? lesson.assets.find((item) => item.path === rel) : undefined
  return typeof listed?.sha256 === 'string' ? listed.sha256 : undefined
}

/**
 * 课堂资源读缓存（进程内、不落盘）。
 *
 * 键 = (root, workspaceId, lessonId, lessonRevision, rel)：lessonRevision 或 workspaceId 一变
 * 就是新键，旧条目自然失效（不靠 TTL、不靠 mtime 猜）；进程重启即清空。
 * 命中时不再 stat / readFile / sha256 —— D3 要省的就是这三步（2.1 MB MathJax 每次重算哈希）。
 * 只缓存「读成功且清单哈希一致」的结果：asset-missing / asset-hash-mismatch 一律不入缓存。
 * 容量按 LRU 淘汰；单条超过总预算的资源直接不缓存，避免把别的条目全挤掉。
 *
 * 口径：命中即信任第一次核对过的字节，同 revision 内磁盘被改写要等重新发布（revision 变化）
 * 或进程重启才会被课堂 GET 发现。离线导出/导入仍走未缓存的 readPublishedAsset，逐字节复核不变。
 */
export function createAssetCache({ maxEntries, maxBytes } = {}) {
  const entryLimit = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : ASSET_CACHE_LIMITS.entries
  const byteLimit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : ASSET_CACHE_LIMITS.bytes
  const entries = new Map()
  const stats = { hits: 0, misses: 0, hashComputations: 0, evictions: 0 }
  const keyOf = (root, workspaceId, lesson, rel) =>
    [root, typeof workspaceId === 'string' ? workspaceId : '', lesson.id, lesson.revision, rel].join('\u0000')
  const bytesOf = () => {
    let total = 0
    for (const entry of entries.values()) total += entry.bytes.length
    return total
  }
  const trim = () => {
    let total = bytesOf()
    while (entries.size > 0 && (entries.size > entryLimit || total > byteLimit)) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      total -= entries.get(oldest.value).bytes.length
      entries.delete(oldest.value)
      stats.evictions += 1
    }
  }
  return {
    /** 读一个已发布资源：命中直接给字节，未命中才走 readPublishedAsset 的 stat/read/hash。 */
    read(root, workspaceId, lesson, rel) {
      // rel 为 '' 表示课程首页（与 resolveAsset 同口径），缓存键统一成 lesson.path，避免首页两套键。
      const target = rel === '' ? lesson.path : rel
      const key = keyOf(root, workspaceId, lesson, target)
      const expected = manifestShaOf(lesson, target)
      const cached = entries.get(key)
      if (cached !== undefined) {
        // 同 revision 但清单哈希变了（理论上不该发生）：宁可重读，也不拿旧字节顶新清单。
        if (cached.sha256 === expected) {
          stats.hits += 1
          entries.delete(key)
          entries.set(key, cached) // LRU：命中即最新
          return { ...cached.asset, bytes: cached.bytes }
        }
        entries.delete(key)
      }
      stats.misses += 1
      const asset = readPublishedAsset(root, lesson, target)
      if (asset.error !== undefined) return asset
      if (expected === undefined) return asset
      stats.hashComputations += 1
      // 没有清单哈希就无法证明「这份字节就是发布的那份」；单条超预算也不缓存。
      if (asset.bytes.length > byteLimit) return asset
      const { bytes, ...rest } = asset
      entries.set(key, { bytes, sha256: expected, asset: rest })
      trim()
      return asset
    },
    stats() {
      return { ...stats, entries: entries.size, bytes: bytesOf() }
    },
    clear() {
      entries.clear()
    }
  }
}

/** 解析 Range；单段，返回 {start,end} 或 null（无效/多段）。 */
export function parseRange(header, size) {
  if (typeof header !== 'string' || !header.startsWith('bytes=')) return null
  const spec = header.slice(6).trim()
  if (spec.includes(',')) return null
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (match === null) return null
  const left = match[1] === '' ? null : Number(match[1])
  const right = match[2] === '' ? null : Number(match[2])
  if (left === null && right === null) return null
  if ((left !== null && !Number.isSafeInteger(left)) || (right !== null && !Number.isSafeInteger(right))) return null
  if (size === 0) return { start: 0, end: -1, unsatisfiable: true }
  if (left === null) {
    const suffix = right
    if (suffix === 0) return { start: size, end: size - 1, unsatisfiable: true }
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  if (left >= size) return { start: size, end: size - 1, unsatisfiable: true }
  const end = right === null ? size - 1 : Math.min(right, size - 1)
  if (end < left) return { start: left, end: left - 1, unsatisfiable: true }
  return { start: left, end }
}

/**
 * 给 HTML 注入 <base> 与课堂桥。bootstrap 只作为数据：nonce/lessonId/revision/sessionId，
 * 以及 questions（classroom/open 下发的题目清单，桥据此给页面 quiz 补「提交到课堂」按钮）。
 */
/**
 * 只注入 `<base>`，不带课堂桥：同一条清单里的其它已发布页面（参考页、速查页）在课堂里
 * 按普通页面打开时用这个 —— 它们的相对引用要能落到自己的目录，但它们不是课程页本身。
 */
export function injectBaseHref(html, baseHref) {
  const base = '<base href="' + escapeAttribute(baseHref) + '">'
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, '<head$1>' + base)
  return base + html
}

export function injectClassroomHtml(html, { baseHref, bootstrap }) {
  const base = '<base href="' + escapeAttribute(baseHref) + '">'
  const data = JSON.stringify(bootstrap).replace(/</g, '\\u003c')
  const bridge = `<script id="teach-classroom-bootstrap" type="application/json">${data}</script>
<script id="teach-classroom-bridge">
(function () {
  var boot = JSON.parse(document.getElementById('teach-classroom-bootstrap').textContent);
  (${readingBridge.toString()})();
  var pending = new Map();
  var seq = 0;
  function send(type, payload) {
    var message = { source: 'teach-classroom', type: type, nonce: boot.nonce, lessonId: boot.lessonId, revision: boot.revision };
    if (payload) for (var key in payload) message[key] = payload[key];
    parent.postMessage(message, '*');
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.source !== 'teach-host' || data.nonce !== boot.nonce) return;
    if (data.type === 'teach:result' || data.type === 'teach:error') {
      var entry = pending.get(data.requestId);
      if (!entry) return;
      pending.delete(data.requestId);
      if (data.type === 'teach:result') entry.resolve(data.value);
      else entry.reject(data.error || { code: 'classroom-error', message: '课堂请求失败' });
    }
  });
  window.teachClassroom = {
    ready: function () { send('ready', {}); },
    submit: function (questionId, rawAnswer, options) {
      return new Promise(function (resolve, reject) {
        var requestId = 'req-' + Date.now() + '-' + (++seq);
        pending.set(requestId, { resolve: resolve, reject: reject });
        var question = questions()[String(questionId)];
        send('submit', { requestId: requestId, questionId: String(questionId), questionRevision: question && question.revision, rawAnswer: String(rawAnswer), idempotencyKey: options && options.idempotencyKey, hintsUsed: options && options.hintsUsed, showedSolution: options && options.showedSolution });
      });
    },
    status: function () {
      return new Promise(function (resolve, reject) {
        var requestId = 'req-' + Date.now() + '-' + (++seq);
        pending.set(requestId, { resolve: resolve, reject: reject });
        send('status', { requestId: requestId });
      });
    }
  };
  /* 课堂下发的题目清单（classroom/open 的 boot.questions）。页面 quiz 的
     data-question-id 只认这份清单：在清单里才补「提交到课堂」按钮，不在清单里
     只在控制台留一条警告，不打扰学习者，也不让桥报错。 */
  var questionMap = null;
  function questions() {
    if (questionMap !== null) return questionMap;
    questionMap = {};
    if (!Array.isArray(boot.questions)) {
      if (window.console && typeof console.warn === 'function') {
        console.warn('[teach-classroom] 课堂没有下发题目清单：页面里的 data-question-id 不会自动补提交按钮');
      }
      return questionMap;
    }
    for (var index = 0; index < boot.questions.length; index += 1) {
      var item = boot.questions[index];
      if (!item || item.id === undefined || item.id === null) continue;
      questionMap[String(item.id)] = item;
    }
    return questionMap;
  }
  function hasQuestion(id) {
    return Object.prototype.hasOwnProperty.call(questions(), id);
  }

  /* 答案取值协议（离线页共用同一套）：
     1) radio 选中项：value → data-value → id；
     2) checkbox 全部选中项，用英文逗号连接（多选按集合判分）；
     3) select 的 value；
     4) textarea / 文本类 input / 没有 type 的 input 的 value。
     页面自带的 [data-teach-submit] 与自动补的按钮走同一条取值逻辑。 */
  function inputValueOf(node) {
    if (!node) return '';
    var raw = node.value;
    return raw === undefined || raw === null ? '' : String(raw);
  }
  function pickedValueOf(node) {
    if (!node) return '';
    return node.getAttribute('value') || node.getAttribute('data-value') || node.id || '';
  }
  function answerOf(quiz) {
    if (!quiz) return '';
    var picked = quiz.querySelector('input[type="radio"]:checked');
    if (picked) return pickedValueOf(picked);
    var boxes = quiz.querySelectorAll ? quiz.querySelectorAll('input[type="checkbox"]:checked') : [];
    if (boxes && boxes.length > 0) {
      var values = [];
      for (var index = 0; index < boxes.length; index += 1) {
        var value = pickedValueOf(boxes[index]);
        if (value !== '') values.push(value);
      }
      return values.join(',');
    }
    var select = quiz.querySelector('select');
    if (select) return inputValueOf(select);
    var free = quiz.querySelector('textarea, input[type="text"], input[type="number"], input[type="range"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input:not([type])');
    return inputValueOf(free);
  }

  /* 自动补的提交按钮：内联样式，不依赖课程页 CSS（自定义页面也看得见）。 */
  function submitButton(questionId) {
    var button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-teach-submit', '');
    button.setAttribute('data-question-id', questionId);
    button.setAttribute('data-teach-auto', '1');
    button.textContent = '提交到课堂';
    button.style.cssText = 'font:inherit;font-size:.85rem;padding:.45rem .9rem;margin:.5rem 0 0;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;cursor:pointer';
    return button;
  }

  function submitRow(questionId) {
    var row = document.createElement('div');
    row.className = 'teach-classroom-submit';
    row.appendChild(submitButton(questionId));
    return row;
  }

  /* 页面作者自己写了「提交到课堂」但没挂 data-teach-submit：认领这只按钮，不要再补一只。
     真实的双按钮事故：页面上一只点了没反应，桥又补一只，一道题出现两个提交按钮
     （Signal-processing 0001 课）。认领的条件只认按钮文案，不改作者的结构。 */
  function adoptableButton(quiz) {
    var buttons = quiz.querySelectorAll('button, [role="button"]');
    for (var index = 0; index < buttons.length; index += 1) {
      var node = buttons[index];
      if (node.getAttribute('data-teach-submit') !== null) continue;
      if (node.disabled) continue;
      var text = String(node.textContent || '').replace(/\s+/g, '');
      if (/^提交(到)?课堂$/.test(text) || /^提交作答$/.test(text)) return node;
    }
    return null;
  }

  /* 已经挂过提交按钮的题不再重复加：先看 quiz 子树，再看页面上同 id 的提交按钮。 */
  function wiredTo(quiz, questionId) {
    if (quiz.querySelector('[data-teach-submit]')) return true;
    var existing = document.querySelectorAll('[data-teach-submit]');
    for (var index = 0; index < existing.length; index += 1) {
      if (existing[index].getAttribute('data-question-id') === questionId) return true;
    }
    return false;
  }

  /* 一道题只有一个操作区：优先并进 course.js 的 .teach-context-actions（「复制当前状态」那行），
     没有这行才自己起一行。否则提交与复制会散在题目底部两处。 */
  function actionArea(quiz) {
    return quiz.querySelector('.teach-context-actions');
  }

  /* 给每个「带 data-question-id 且 id 在课堂清单里」的 .quiz 补一个提交按钮，
     放在 .verdict 之后（没有 .verdict 就放末尾）。 */
  function mountSubmitButtons() {
    var quizzes = document.querySelectorAll('.quiz[data-question-id]');
    for (var index = 0; index < quizzes.length; index += 1) {
      var quiz = quizzes[index];
      var questionId = String(quiz.getAttribute('data-question-id') || '').trim();
      if (!questionId) continue;
      if (!hasQuestion(questionId)) {
        if (window.console && typeof console.warn === 'function') {
          console.warn('[teach-classroom] 页面里的 data-question-id 不在课堂题目清单里：' + questionId);
        }
        continue;
      }
      if (wiredTo(quiz, questionId)) continue;
      var actions = actionArea(quiz);
      var adopted = adoptableButton(quiz);
      if (adopted !== null) {
        /* 认领手写按钮：补上桥需要的标记，并把它并进操作区，避免「一只按钮 + 一只复制」分两行。 */
        if (adopted.tagName === 'BUTTON') adopted.type = 'button';
        adopted.setAttribute('data-teach-submit', '');
        adopted.setAttribute('data-question-id', questionId);
        adopted.setAttribute('data-teach-adopted', '1');
        /* 主操作放最前：读起来是「提交到课堂 → 复制当前状态」，不是反过来的。 */
        if (actions !== null && adopted.parentNode !== actions) actions.insertBefore(adopted, actions.firstChild);
        continue;
      }
      if (actions !== null) {
        actions.insertBefore(submitButton(questionId), actions.firstChild);
        continue;
      }
      var row = submitRow(questionId);
      var verdict = quiz.querySelector('.verdict');
      if (verdict && verdict.parentNode) verdict.parentNode.insertBefore(row, verdict.nextSibling);
      else quiz.appendChild(row);
    }
  }

  function contextOptions(quiz) {
    function marked(name) {
      return !!quiz && typeof quiz.getAttribute === 'function' && /^(1|true)$/.test(quiz.getAttribute(name) || '');
    }
    return { hintsUsed: marked('data-teach-hints-used'), showedSolution: marked('data-teach-showed-solution') };
  }

  function submissionFeedback(button, message) {
    if (!button.parentNode) return;
    var line = button.parentNode.querySelector('.teach-classroom-result');
    if (!line) {
      line = document.createElement('p');
      line.className = 'teach-classroom-result';
      line.setAttribute('role', 'status');
      button.parentNode.insertBefore(line, button.nextSibling);
    }
    line.textContent = message;
  }

  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest ? event.target.closest('[data-teach-submit]') : null;
    if (!button) return;
    var quiz = button.closest('.quiz');
    var questionId = button.getAttribute('data-question-id') || (quiz && quiz.getAttribute('data-question-id'));
    if (!questionId) return;
    var answer = answerOf(quiz);
    if (!answer.trim()) {
      submissionFeedback(button, '请先作答，再提交到课堂。');
      return;
    }
    button.disabled = true;
    window.teachClassroom.submit(questionId, answer, contextOptions(quiz)).then(function (result) {
      button.disabled = false;
      button.setAttribute('data-teach-result', JSON.stringify(result));
      var verdicts = { passed: '评估通过', needs_practice: '需要再练习', needs_review: '待复核', void: '已作废' };
      var verdict = result && result.verdict;
      if (verdict) {
        /* 历史结论仍在，但已经不适用于改版后的题目/课程：先显示结论，再标失效原因。 */
        var line = '已提交：' + (verdicts[verdict] || verdict);
        if (result.stale) line += '（旧结论已失效：' + (result.staleReason || '题目或课程已改版') + '）';
        submissionFeedback(button, line);
        return;
      }
      /* 没有结论 = 开放题/待补录：说清楚是「存下了，等导师批」，不是「等评估」。
         幂等返回（这次提交之前就记过）也走这一支，避免重新显示「等待评估」。 */
      submissionFeedback(button, result && result.needsGrading ? '已保存，等待导师批改。' : '已提交，等待评估。');
    }, function (error) {
      button.disabled = false;
      /* 服务端 message 比兜底文案有用（例如「题目已改版，刷新课堂后再提交」）。 */
      var message = error && (error.message || (error.error && error.error.message));
      submissionFeedback(button, message ? String(message) : '提交未完成，请重试。');
    });
  });
  /* 等 DOMContentLoaded 再补按钮：course.js 是 defer，先让它绑好自己的「判卷」按钮，
     免得自动补的提交按钮被当成判卷按钮再绑一次。 */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountSubmitButtons);
  else mountSubmitButtons();
  // 组件异步完成挂载后显式重扫；仍只认 boot.questions，不接受组件自报题目。
  document.addEventListener('teach:components-ready', mountSubmitButtons);
  send('ready', {});
})();
</script>`
  let out = html
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, '<head$1>' + base)
  else out = base + out
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, bridge + '</body>')
  else out += bridge
  return out
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * 课堂响应的公共安全头。默认 no-store：JSON 回执、错误信封与注入了票据 nonce/base 的课程页
 * 都不能被浏览器缓存；已发布资源（正文就是清单里那份字节）在资源路由里覆盖成
 * `private, max-age=3600` + ETag，见 service.js 的 headersOf。
 */
export function classroomHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    ...extra
  }
}
