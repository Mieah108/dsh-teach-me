/* 评分标准的规范形式。
 *
 * 单独成模块是为了断开 operations.js ↔ grading.js 的循环依赖：评估链要按题目登记的
 * rubric 校验逐条标准的 id，而 grading.js 已经 import 了 operations.js（批改走评估）。
 * 两个方向都引同一个纯函数模块就不会成环。
 *
 * 这里只有纯函数，不 import 任何东西（含 @deepseek-ai/*）：行为与 0.6.1 的
 * grading.js 里那一份逐字一致，只是换了位置。 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 评分标准的规范形式：字符串，或 {id, text|criterion|description}。 */
export function normalizeRubric(rubric) {
  if (!Array.isArray(rubric)) return []
  const out = []
  const seen = new Set()
  rubric.forEach((item, index) => {
    let id = 'criterion-' + (index + 1)
    let text = ''
    if (typeof item === 'string') {
      text = item
    } else if (isPlainObject(item)) {
      if (typeof item.id === 'string' && ID_PATTERN.test(item.id.trim())) id = item.id.trim()
      for (const key of ['text', 'criterion', 'description', 'standard']) {
        if (typeof item[key] === 'string' && item[key].trim() !== '') {
          text = item[key]
          break
        }
      }
    }
    const trimmed = String(text).trim()
    if (trimmed === '' || seen.has(id)) return
    seen.add(id)
    out.push({ id, text: trimmed })
  })
  return out
}
