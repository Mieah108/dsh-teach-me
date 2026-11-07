/* 课程资源里的 CSS 依赖。
 *
 * 发布扫描原先只看 HTML 标签属性，CSS 里的 url()/@import 从来没进过清单：
 * 课堂上这些文件全部 404 asset-not-listed，离线导出把 CSS 转成 data URI 后
 * 相对路径又没有基准，静默丢图。这里给扫描与离线内联提供同一套解析规则，
 * 两边口径一致，避免「发布收了但导出不认」。
 */

/** url(…) 与 @import "…" 的引用；一条正则单遍扫描，保留文件里的真实出现顺序。 */
const CSS_REF_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi
const STYLE_BLOCK_PATTERN = /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi

/** url(…) 的三组捕获依次是双引号、单引号、裸露；@import 的两组是双引号、单引号。 */
function refOf(match) {
  return String(match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim()
}

function isUrlForm(match) {
  return match[1] !== undefined || match[2] !== undefined || match[3] !== undefined
}

/** 本地引用：排除空值、锚点、绝对 URL 与协议相对地址。 */
export function isLocalRef(raw) {
  const value = String(raw ?? '').trim()
  if (value === '' || value.startsWith('#')) return false
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)
}

/**
 * 抽一段 CSS（文件或 <style> 块）里的本地引用，按出现顺序去重。
 * 调用方负责按「CSS 文件所在目录」解析相对路径。
 */
export function cssRefsOf(text) {
  const css = String(text ?? '')
  const out = []
  let hit
  CSS_REF_PATTERN.lastIndex = 0
  while ((hit = CSS_REF_PATTERN.exec(css)) !== null) {
    const raw = refOf(hit)
    if (isLocalRef(raw)) out.push(raw)
  }
  return [...new Set(out)]
}

/**
 * 把 CSS 里的本地引用换成 data URI。toDataUri(raw) 返回字符串则替换，
 * 返回 null/undefined 表示这一条处理不了（原样保留，由调用方决定要不要报错）。
 */
export function inlineCssDataUris(text, toDataUri) {
  const css = String(text ?? '')
  CSS_REF_PATTERN.lastIndex = 0
  return css.replace(CSS_REF_PATTERN, (whole, ...groups) => {
    const match = [whole, ...groups]
    const raw = refOf(match)
    if (!isLocalRef(raw)) return whole
    const data = toDataUri(raw)
    if (data === null || data === undefined) return whole
    return isUrlForm(match) ? 'url("' + data + '")' : '@import "' + data + '"'
  })
}

/** 页面里 <style> 块的内联：行的属性不动，只换块内的引用。 */
export function inlineStyleBlocks(html, toDataUri) {
  return String(html ?? '').replace(STYLE_BLOCK_PATTERN, (whole, open, body, close) => open + inlineCssDataUris(body, toDataUri) + close)
}
