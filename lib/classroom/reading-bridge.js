/* 只注入主课程页；不直接联网，通过已有 nonce/能力票桥写回。 */
export function readingBridge() {
  if (boot.tracking !== true) return
  var lastInput = 0;
  var lastSent = 0;
  var previewAt = 0;
  var sequence = 0;
  var timer;
  var restoring = true;
  var visible = false;
  var saved = boot.reading;
  var high = saved && saved.maxRatio || 0;
  /* 宿主顶栏覆盖在课程页上方时，body 最前面要留一段与顶栏等高的空白：
     首屏内容不被遮住，下滑时再从顶栏下面经过。高度由宿主测量后通过 nonce 桥下发。 */
  var hostInset = 0;
  var spacer = null;
  function applyInset(px) {
    var next = Math.max(0, Math.round(Number(px) || 0));
    if (next === hostInset && (next === 0 || (spacer !== null && spacer.parentNode !== null))) return;
    var previous = hostInset;
    hostInset = next;
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.setAttribute('data-teach-host-inset', '');
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.cssText = 'display:block;width:100%;height:0;margin:0;padding:0;border:0;background:transparent;pointer-events:none;grid-column:1/-1';
    }
    if (document.body && spacer.parentNode === null) document.body.insertBefore(spacer, document.body.firstChild);
    spacer.style.height = next + 'px';
    /* 已经读在中段时，保持当前内容在视口里的位置；在顶部就保持 0，让内容从顶栏下沿开始。 */
    if (window.scrollY > 0) window.scrollBy(0, next - previous);
  }
  function position() {
    var total = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    var ratio = total ? Math.min(1, Math.max(0, window.scrollY / total)) : 1;
    var sections = Array.prototype.slice.call(document.querySelectorAll('main [id],section[id],h2[id],h3[id]'));
    var section = sections.filter(function (item) { return item.getBoundingClientRect().top <= hostInset + 80; }).pop();
    var offset = section ? Math.min(1, Math.max(0, -section.getBoundingClientRect().top / Math.max(1, section.offsetHeight))) : 0;
    return { ratio: ratio, section: section ? section.id : '', offset: offset };
  }
  function flush() {
    clearTimeout(timer);
    if (restoring || !visible || document.visibilityState === 'hidden' || !lastInput) return;
    var pos = position();
    high = Math.max(high, pos.ratio);
    lastSent = Date.now();
    send('reading', { requestId: 'reading-' + (++sequence), sequence: sequence, ratio: high, position: pos, active: true, activeAt: lastInput });
  }
  function schedule() {
    if (restoring || !lastInput) return;
    if (Date.now() - previewAt > 120 && visible) {
      var preview = position();
      high = Math.max(high, preview.ratio); previewAt = Date.now();
      send('reading-preview', { ratio: high, position: preview });
    }
    clearTimeout(timer);
    var wait = Math.max(150, 3000 - (Date.now() - lastSent));
    timer = setTimeout(flush, wait);
  }
  function input(event) {
    if (!event.isTrusted || !visible || restoring) return;
    lastInput = Date.now();
    schedule();
  }
  ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'].forEach(function (type) { window.addEventListener(type, input, { passive: true }); });
  window.addEventListener('scroll', function () { if (lastInput && Date.now() - lastInput < 2500 && !restoring && visible) { lastInput = Date.now(); schedule(); } }, { passive: true });
  window.addEventListener('pagehide', flush);
  window.addEventListener('blur', flush);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('message', function (event) {
    if (event.source !== parent || !event.data || event.data.source !== 'teach-host' || event.data.nonce !== boot.nonce) return;
    if (event.data.type === 'teach:visibility') {
      visible = event.data.active === true;
      if (visible && !restoring && !saved && document.documentElement.scrollHeight <= innerHeight) { lastInput = Date.now(); schedule(); }
    }
    if (event.data.type === 'teach:top-inset') applyInset(event.data.px);
    if (event.data.type === 'teach:retry-reading') flush();
  });
  function restore() {
    var previousBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'auto';
    if (saved && saved.position) {
      var pos = saved.position;
      var element = pos.section && document.getElementById(pos.section);
      var y = element ? element.getBoundingClientRect().top + window.scrollY + (pos.offset || 0) * element.offsetHeight - hostInset : pos.ratio * Math.max(0, document.documentElement.scrollHeight - innerHeight);
      window.scrollTo(0, y);
    }
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      document.documentElement.style.scrollBehavior = previousBehavior;
      restoring = false;
      if (visible && !saved && document.documentElement.scrollHeight <= innerHeight) { lastInput = Date.now(); schedule(); }
    }); });
  }
  if (document.readyState === 'complete') restore();
  else window.addEventListener('load', restore, { once: true });
}
