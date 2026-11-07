/* course.js — 课程页共用交互（本地，不联网）。
   1) 自测题判卷：<div class="quiz"> 内一组 radio（正确项带 data-ok="1"）+ button + .verdict；
      多选用 .quiz[data-multi="1"] 里的 checkbox（正确项可以多条 data-ok="1"），按选中集合判分；
      既没有 radio 也没有 checkbox 的题只在课堂里提交，本地不判卷。
   2) 侧边目录高亮：滚动到哪一节，.sidenav 里对应条目就标 .is-current
   3) 复制为 Markdown：悬停独立公式（.eq）或表格，点右上角按钮把源码写进剪贴板。
      公式输出 $$…$$（TeX 取自 MathJax 记下的原文，渲染后的 DOM 里只剩 SVG）；
      表格输出 GFM 管道表，单元格里的行内公式、<code>、链接都能还原。 */
(function () {
  function markContext(node, name) {
    var current = node && node.closest ? node.closest('.quiz, [data-teach-context]') : null;
    while (current) {
      current.setAttribute(name, '1');
      current = current.parentElement && current.parentElement.closest('.quiz, [data-teach-context]');
    }
  }

  /* 选项值：value → data-value → id（与课堂取值协议一致）。 */
  function optionValue(input) {
    return input.getAttribute('value') || input.getAttribute('data-value') || input.id || '';
  }

  /* 多选（.quiz[data-multi="1"] 的 checkbox）：选中 value 集合 === data-ok 集合才算对。 */
  function checkMulti(quiz, out) {
    var boxes = quiz.querySelectorAll('input[type="checkbox"]');
    var picked = [];
    var expected = [];
    var why = '';
    for (var i = 0; i < boxes.length; i++) {
      var value = optionValue(boxes[i]);
      if (boxes[i].checked) {
        picked.push(value);
        if (!why && boxes[i].dataset.why) why = boxes[i].dataset.why;
      }
      if (boxes[i].dataset.ok === '1') expected.push(value);
    }
    if (!picked.length) {
      out.className = 'verdict';
      out.textContent = '先选一个再判。';
      return;
    }
    var right = expected.length > 0 && picked.length === expected.length;
    for (var j = 0; right && j < picked.length; j++) {
      if (expected.indexOf(picked[j]) === -1) right = false;
    }
    var explanation = quiz.dataset.explain;
    if (explanation) markContext(quiz, 'data-teach-showed-solution');
    out.className = 'verdict ' + (right ? 'ok' : 'no');
    out.textContent = right
      ? '对。' + (explanation || '')
      : '不对。' + (why || explanation || '回到上面对应的一段再看一眼。');
    markJudged(quiz, quiz._teachCheckBtn);
  }

  /* ── 可访问性与结论新鲜度 ─────────────────────────────
     老页面只写了 .quiz 与 .verdict，读屏拿不到分组名、也听不到判卷结果。
     这里统一补齐：跳转链接、main 地标、目录名称、radiogroup、结论播报；
     同时保证结论随作答失效——改了选项就不再显示旧的「对/不对」。 */

  var a11yCounter = 0;

  function ensureLandmarks() {
    var main = document.querySelector('main');
    if (!main) {
      var wrap = document.querySelector('.wrap');
      if (wrap) { wrap.setAttribute('role', 'main'); main = wrap; }
    }
    if (main) {
      if (!main.id) main.id = 'main';
      if (!document.querySelector('.skip-link')) {
        var link = document.createElement('a');
        link.className = 'skip-link';
        link.href = '#' + main.id;
        link.textContent = '跳到正文';
        document.body.insertBefore(link, document.body.firstChild);
      }
    }
    var sideNav = document.querySelector('.sidenav nav');
    if (sideNav && !sideNav.getAttribute('aria-label')) sideNav.setAttribute('aria-label', '本课路线');
    var toc = document.querySelector('nav.toc');
    if (toc && !toc.getAttribute('aria-label')) toc.setAttribute('aria-label', '本课路线');
  }

  function ensureVerdict(out) {
    if (!out) return;
    if (!out.getAttribute('role')) out.setAttribute('role', 'status');
    if (!out.getAttribute('aria-live')) out.setAttribute('aria-live', 'polite');
    if (!out.getAttribute('aria-atomic')) out.setAttribute('aria-atomic', 'true');
  }

  /* 把同一题的单选项包进 radiogroup，并把题干挂成组名。 */
  function groupOptions(quiz) {
    if (quiz.querySelector('[role="radiogroup"]')) return;
    var labels = [];
    var radios = quiz.querySelectorAll('input[type="radio"]');
    for (var i = 0; i < radios.length; i++) {
      var label = radios[i].closest ? radios[i].closest('label') : null;
      if (label && labels.indexOf(label) === -1) labels.push(label);
    }
    if (!labels.length) return;
    var prompt = quiz.querySelector('.q');
    var group = document.createElement('div');
    group.className = 'quiz-options';
    group.setAttribute('role', 'radiogroup');
    if (prompt) {
      if (!prompt.id) prompt.id = 'teach-quiz-prompt-' + (++a11yCounter);
      group.setAttribute('aria-labelledby', prompt.id);
    }
    labels[0].parentNode.insertBefore(group, labels[0]);
    for (var j = 0; j < labels.length; j++) group.appendChild(labels[j]);
  }

  function markJudged(quiz, btn) {
    quiz.setAttribute('data-teach-judged', '1');
    if (btn) btn.textContent = '重新判卷';
  }

  /* 作答一变，旧结论立刻作废：自测的全部价值是「证据」。 */
  function staleVerdict(quiz, btn, out) {
    if (quiz.getAttribute('data-teach-judged') !== '1') return;
    quiz.removeAttribute('data-teach-judged');
    out.className = 'verdict is-stale';
    out.textContent = '选项已更改，请重新判卷。';
    if (btn) btn.textContent = '重新判卷';
  }

  function bindStale(quiz) {
    if (quiz._teachStaleBound) return;
    quiz._teachStaleBound = true;
    quiz.addEventListener('change', function (event) {
      var input = event.target;
      if (!input || !/^(radio|checkbox)$/i.test(input.type || '')) return;
      var out = quiz.querySelector('.verdict');
      if (out) staleVerdict(quiz, quiz._teachCheckBtn, out);
    });
  }

  function check(quiz) {
    var out = quiz.querySelector('.verdict');
    if (!out) return;
    var picked = quiz.querySelector('input[type="radio"]:checked');
    if (!picked) {
      // 没有选中的 radio：多选题按 checkbox 集合判；单选题仍是「先选一个」；
      // 两者都没有的题只在课堂里提交，本地不判卷。
      if (quiz.querySelectorAll('input[type="checkbox"]').length > 0) {
        checkMulti(quiz, out);
        return;
      }
      out.className = 'verdict';
      out.textContent = quiz.querySelector('input[type="radio"]') ? '先选一个再判。' : '这道题在课堂里提交，本地不判卷。';
      return;
    }
    var right = picked.dataset.ok === '1';
    var explanation = right ? quiz.dataset.explain : (picked.dataset.why || quiz.dataset.explain);
    if (explanation) markContext(quiz, 'data-teach-showed-solution');
    out.className = 'verdict ' + (right ? 'ok' : 'no');
    out.textContent = right
      ? '对。' + (quiz.dataset.explain || '')
      : '不对。' + (picked.dataset.why || quiz.dataset.explain || '回到上面对应的一段再看一眼。');
    markJudged(quiz, quiz._teachCheckBtn);
  }

  function init() {
    var quizzes = document.querySelectorAll('.quiz');
    for (var i = 0; i < quizzes.length; i++) {
      (function (quiz) {
        var out = quiz.querySelector('.verdict');
        ensureVerdict(out);
        groupOptions(quiz);
        bindStale(quiz);
        var btn = quiz.querySelector('button:not([data-teach-submit]):not([data-teach-copy-context]):not([data-teach-hint]):not([data-teach-solution])');
        if (btn) quiz._teachCheckBtn = btn;
        if (btn && !btn._teachCheckBound) {
          btn._teachCheckBound = true;
          btn.addEventListener('click', function () { check(quiz); });
        }
      })(quizzes[i]);
    }
  }

  /* 侧边目录：当前小节高亮 */
  function spy() {
    var links = document.querySelectorAll('.sidenav a[href^="#"]');
    if (!links.length || !('IntersectionObserver' in window)) return;
    var byId = {};
    for (var i = 0; i < links.length; i++) {
      var id = links[i].getAttribute('href').slice(1);
      var el = document.getElementById(id);
      if (el) byId[id] = { link: links[i], el: el };
    }
    var io = new IntersectionObserver(function (entries) {
      for (var j = 0; j < entries.length; j++) {
        if (!entries[j].isIntersecting) continue;
        var hit = entries[j].target.id;
        for (var id in byId) {
          byId[id].link.classList.toggle('is-current', id === hit);
        }
      }
    }, { rootMargin: '-10% 0px -75% 0px' });
    for (var id in byId) io.observe(byId[id].el);
  }

  /* ── 复制为 Markdown ─────────────────────────────────
     为什么不能直接抄 textContent：MathJax 把 $$…$$ 换成了 SVG，页面里只剩字形路径，
     读出来是「ab+∑i=1Nxi」这种残渣。所以公式文本一律向 MathJax 要回原始 TeX
     （MathItem.math）；万一 MathJax 没加载，原文本还在 DOM 里，退回正则截 $$…$$。 */

  function mjxDocument() {
    return window.MathJax && MathJax.startup && MathJax.startup.document;
  }

  function mathItemsIn(el) {
    var doc = mjxDocument();
    if (!doc || typeof doc.getMathItemsWithin !== 'function') return [];
    try { return doc.getMathItemsWithin(el) || []; } catch (e) { return []; }
  }

  /* 渲染结果节点 → 原 TeX 的对照表，用来把单元格里的每个 mjx-container 换回 $…$ */
  function typesetRoots(el) {
    var items = mathItemsIn(el), out = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].typesetRoot) out.push({ root: items[i].typesetRoot, tex: String(items[i].math) });
    }
    return out;
  }

  function texAt(node, roots) {
    for (var i = 0; i < roots.length; i++) {
      if (roots[i].root === node) return roots[i].tex;
    }
    return '';
  }

  function squash(s) {
    return String(s).replace(/\s+/g, ' ').trim();
  }

  /* 多行公式（aligned / cases）原来缩进在 HTML 里，去公共缩进后粘进笔记才干净。
     第一行常是 \begin{aligned}（缩进 0），所以公共缩进只看第二行往后。 */
  function dedent(tex) {
    var lines = String(tex).replace(/\r\n?/g, '\n').split('\n'), i, ind, min = -1;
    for (i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/[ \t]+$/, '');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (!lines.length) return '';
    for (i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      ind = lines[i].match(/^[ \t]*/)[0].length;
      if (min < 0 || ind < min) min = ind;
    }
    if (min > 0) {
      for (i = 1; i < lines.length; i++) lines[i] = lines[i].slice(min);
    }
    lines[0] = lines[0].replace(/^[ \t]+/, '');
    return lines.join('\n');
  }

  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, 'MJX-ASSISTIVE-MML': 1 };
  var BLOCKISH = { P: 1, DIV: 1, LI: 1, UL: 1, OL: 1, BLOCKQUOTE: 1 };

  /* 把一段 DOM 压成一行 Markdown（只处理表格单元格里会出现的那几种标签） */
  function inlineMd(node, roots) {
    var out = '', kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.nodeType === 3) { out += k.nodeValue; continue; }
      if (k.nodeType !== 1) continue;
      var tag = k.tagName.toUpperCase();
      if (SKIP[tag]) continue;
      if (tag === 'MJX-CONTAINER') {
        var tex = texAt(k, roots);
        if (tex) out += '$' + tex + '$';
        continue;
      }
      if (tag === 'BR') { out += '<br>'; continue; }
      if (tag === 'CODE') { out += '`' + squash(k.textContent).replace(/`/g, "'") + '`'; continue; }
      if (tag === 'STRONG' || tag === 'B') { out += '**' + inlineMd(k, roots) + '**'; continue; }
      if (tag === 'EM' || tag === 'I') { out += '*' + inlineMd(k, roots) + '*'; continue; }
      if (tag === 'A') {
        var href = k.getAttribute('href') || '';
        var text = squash(inlineMd(k, roots));
        out += text ? '[' + text + '](' + href + ')' : href;
        continue;
      }
      out += inlineMd(k, roots);
      if (BLOCKISH[tag]) out += ' ';
    }
    return out;
  }

  function rowCells(tr) {
    var out = [];
    if (!tr) return out;
    for (var i = 0; i < tr.children.length; i++) {
      var t = tr.children[i].tagName.toUpperCase();
      if (t === 'TD' || t === 'TH') out.push(tr.children[i]);
    }
    return out;
  }

  function cellSpan(c) {
    var n = parseInt(c.getAttribute('colspan') || '1', 10);
    return isNaN(n) || n < 1 ? 1 : n;
  }

  function rowWidth(tr) {
    var cells = rowCells(tr), n = 0;
    for (var i = 0; i < cells.length; i++) n += cellSpan(cells[i]);
    return n;
  }

  function alignOf(cell) {
    var a = '';
    try { a = window.getComputedStyle(cell).textAlign || ''; } catch (e) { a = ''; }
    if (a === 'right' || a === 'end') return '---:';
    if (a === 'center') return ':---:';
    return '---';
  }

  function buildRow(tr, roots, cols) {
    var cells = rowCells(tr), out = [], w = 0;
    for (var i = 0; i < cells.length; i++) {
      out.push(squash(inlineMd(cells[i], roots)).replace(/\|/g, '\\|'));
      w++;
      for (var s = 1; s < cellSpan(cells[i]); s++) { out.push(''); w++; }
    }
    while (w < cols) { out.push(''); w++; }
    return out;
  }

  function tableMd(table) {
    var roots = typesetRoots(table);
    var rows = [], all = table.rows;
    for (var i = 0; i < all.length; i++) rows.push(all[i]);
    if (!rows.length) return '';

    var headRow = null, j;
    if (table.tHead && table.tHead.rows.length) {
      headRow = table.tHead.rows[table.tHead.rows.length - 1];
    } else {
      var first = rowCells(rows[0]);
      for (j = 0; j < first.length; j++) {
        if (first[j].tagName.toUpperCase() === 'TH') { headRow = rows[0]; break; }
      }
    }

    var cols = 0;
    for (j = 0; j < rows.length; j++) cols = Math.max(cols, rowWidth(rows[j]));
    if (!cols) return '';

    /* GFM 必须有表头与分隔行：没有 <th> 就留一行空名，正文行会顺次落在下面 */
    var head = buildRow(headRow, roots, cols);
    var seps = [], n = 0, hcells = rowCells(headRow);
    for (j = 0; j < hcells.length; j++) {
      var a = alignOf(hcells[j]);
      for (var s = 0; s < cellSpan(hcells[j]); s++) { seps.push(a); n++; }
    }
    while (n < cols) { seps.push('---'); n++; }

    var out = ['| ' + head.join(' | ') + ' |', '| ' + seps.join(' | ') + ' |'];
    for (j = 0; j < rows.length; j++) {
      if (rows[j] === headRow) continue;
      out.push('| ' + buildRow(rows[j], roots, cols).join(' | ') + ' |');
    }
    return out.join('\n');
  }

  function eqMd(eq) {
    var items = mathItemsIn(eq), list = [], i;
    for (i = 0; i < items.length; i++) {
      if (items[i].display) list.push(dedent(items[i].math));
    }
    if (!list.length) {
      /* MathJax 没加载过：原文里的 $$…$$ 还在，直接截出来 */
      var clone = eq.cloneNode(true), tags = clone.querySelectorAll('.tag');
      for (i = 0; i < tags.length; i++) tags[i].parentNode.removeChild(tags[i]);
      var re = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, m;
      while ((m = re.exec(clone.textContent || ''))) list.push(dedent(m[1] || m[2]));
    }
    if (!list.length) return '';

    var blocks = [];
    for (i = 0; i < list.length; i++) blocks.push('$$\n' + list[i] + '\n$$');
    var out = blocks.join('\n\n');
    var tag = eq.querySelector('.tag');
    if (tag) {
      var t = squash(tag.textContent);
      if (t) out += '\n\n' + t;   /* 编号 / 说明跟在公式后面，删掉也不影响公式 */
    }
    return out;
  }

  var toastEl = null;
  function toast(text, bad) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'md-toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.className = 'md-toast is-on' + (bad ? ' is-bad' : '');
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(function () { toastEl.className = 'md-toast'; }, 1800);
  }

  /* 老浏览器 / 非安全上下文：拽一个看不见的 textarea 走 execCommand */
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = '0';
    ta.style.opacity = '0';
    var prev = document.activeElement;
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);   /* Safari 要显式选区 */
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (prev && prev.focus) prev.focus();   /* 别把键盘焦点丢在 body 上 */
    return ok;
  }

  /* 剪贴板彻底不可用：源码摊在页面上并选中，⌘C / Ctrl+C 也能拿走 */
  function showSource(text) {
    var old = document.querySelector('.md-src');
    if (old) old.parentNode.removeChild(old);

    var box = document.createElement('div');
    box.className = 'md-src';
    var pre = document.createElement('pre');
    pre.textContent = text;
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'md-src-close';
    close.textContent = '关闭';
    close.addEventListener('click', function () { box.parentNode.removeChild(box); });
    box.appendChild(pre);
    box.appendChild(close);
    document.body.appendChild(box);

    var range = document.createRange();
    range.selectNodeContents(pre);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('剪贴板不可用，源码已选中：⌘C / Ctrl+C 复制', true);
  }

  function copyMd(text, what) {
    function landed(ok) {
      if (ok) toast('已复制' + what + '（Markdown）', false);
      else showSource(text);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { landed(true); },
        function () { landed(legacyCopy(text)); }
      );
      return;
    }
    landed(legacyCopy(text));
  }

  function mount(el, build, what, hostClass) {
    var host = document.createElement('div');
    host.className = 'md-copy-host' + (hostClass ? ' ' + hostClass : '');
    el.parentNode.insertBefore(host, el);
    host.appendChild(el);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-copy';
    btn.textContent = '复制 MD';
    btn.title = '复制为 Markdown';
    btn.setAttribute('aria-label', '复制为 Markdown');
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var md = build();
      if (!md) { toast('这里没有可复制的公式', true); return; }
      copyMd(md, what);
    });
    host.appendChild(btn);
  }

  function initCopy() {
    var eqs = document.querySelectorAll('.eq');
    for (var i = 0; i < eqs.length; i++) {
      var eq = eqs[i];
      if (eq.parentNode && eq.parentNode.classList.contains('md-copy-host')) continue;
      if (eq.closest('.formula')) continue;       /* .formula 里的是位串/伪代码，不是公式 */
      if (!eqMd(eq)) continue;                    /* 没有独立公式就不挂按钮 */
      (function (node) {
        mount(node, function () { return eqMd(node); }, '公式', 'eq-host');
      })(eq);
    }

    var tables = document.querySelectorAll('table');
    for (var j = 0; j < tables.length; j++) {
      var tb = tables[j];
      if (tb.parentNode && tb.parentNode.classList.contains('md-copy-host')) continue;
      if (!tb.rows || !tb.rows.length) continue;
      (function (node) {
        mount(node, function () { return tableMd(node); }, '表格', 'table-host');
      })(tb);
    }
  }

  /* 只复制显式的当前状态、题面和真实作答；不遍历组件 JSON、答案标记或隐藏背面。 */
  function visible(node, root) {
    for (var current = node; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false;
      if (current.tagName === 'DETAILS' && !current.open && node !== current.querySelector('summary')) return false;
      try {
        var style = window.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      } catch (e) { /* DOM 测试或旧浏览器没有 computed style。 */ }
      if (current === root) break;
    }
    return true;
  }

  function visibleText(node, root) {
    if (!node || !visible(node, root)) return '';
    var out = [];
    function visit(item) {
      if (item.nodeType === 3) { out.push(item.nodeValue); return; }
      if (item.nodeType !== 1 || /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(item.tagName) || !visible(item, root)) return;
      for (var child = item.firstChild; child; child = child.nextSibling) visit(child);
    }
    visit(node);
    return squash(out.join(' ')).slice(0, 2000);
  }

  function contextSnapshot(context) {
    var lines = ['# 答疑快照', '课程：' + String(document.title || '').slice(0, 200)];
    var label = context.getAttribute('data-teach-context');
    if (label) lines.push('活动：' + label.slice(0, 200));
    var question = context.querySelector('.q');
    var prompt = visibleText(question, context);
    if (prompt) lines.push('问题：' + prompt);
    var states = context.querySelectorAll('[data-teach-state]');
    for (var i = 0; i < states.length; i++) {
      var text = visibleText(states[i], context);
      if (text) lines.push('当前状态：' + text);
    }
    var fields = context.querySelectorAll('input, textarea, select');
    for (var j = 0; j < fields.length; j++) {
      var field = fields[j];
      var type = String(field.type || '').toLowerCase();
      if (!visible(field, context) || /^(hidden|password|button|submit|reset)$/.test(type)) continue;
      if ((type === 'radio' || type === 'checkbox') && !field.checked) continue;
      var value = String(field.value || '').slice(0, 1000);
      if (!value) continue;
      var label = field.getAttribute('aria-label') || field.getAttribute('name') || '作答';
      lines.push(label.slice(0, 100) + '：' + value);
    }
    var verdict = visibleText(context.querySelector('.verdict'), context);
    if (verdict) lines.push('已显示反馈：' + verdict);
    if (/^(1|true)$/.test(context.getAttribute('data-teach-hints-used') || '')) lines.push('已使用提示');
    if (/^(1|true)$/.test(context.getAttribute('data-teach-showed-solution') || '')) lines.push('已看过解答');
    lines.push('此快照仅供答疑，不是正式提交或掌握结论。');
    return lines.join('\n').slice(0, 6000);
  }

  function copyContext(context, button) {
    var text = contextSnapshot(context);
    function landed(ok) {
      if (ok) toast('已复制当前状态，可粘贴给导师', false);
      else showSource(text);
      if (button) button.textContent = ok ? '已复制当前状态' : '复制当前状态';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { landed(true); }, function () { landed(legacyCopy(text)); });
    } else landed(legacyCopy(text));
  }

  function initContext() {
    var contexts = document.querySelectorAll('.quiz, [data-teach-context]');
    for (var i = 0; i < contexts.length; i++) {
      var context = contexts[i];
      var buttons = context.querySelectorAll('[data-teach-copy-context]');
      var mounted = false;
      for (var j = 0; j < buttons.length; j++) {
        if (buttons[j].closest('.quiz, [data-teach-context]') === context) mounted = true;
      }
      if (mounted) continue;
      var row = document.createElement('div');
      row.className = 'teach-context-actions';
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'teach-context-copy';
      button.setAttribute('data-teach-copy-context', '');
      button.textContent = '复制当前状态';
      row.appendChild(button);
      context.appendChild(row);
    }
  }

  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    var hint = target.closest('[data-teach-hint]');
    var solution = target.closest('[data-teach-solution]');
    if (hint && !hint.disabled) markContext(hint, 'data-teach-hints-used');
    if (solution && !solution.disabled) markContext(solution, 'data-teach-showed-solution');
    var copy = target.closest('[data-teach-copy-context]');
    if (copy) {
      var context = copy.closest('.quiz, [data-teach-context]');
      if (context) copyContext(context, copy);
    }
  });
  document.addEventListener('toggle', function (event) {
    var detail = event.target;
    if (!detail || detail.tagName !== 'DETAILS' || !detail.open) return;
    if (detail.hasAttribute('data-teach-hint')) markContext(detail, 'data-teach-hints-used');
    else if (detail.hasAttribute('data-teach-solution') || detail.closest('.quiz')) markContext(detail, 'data-teach-showed-solution');
  }, true);

  function enhance() { ensureLandmarks(); init(); initCopy(); initContext(); }
  function boot() { enhance(); spy(); }
  document.addEventListener('teach:components-ready', enhance);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
