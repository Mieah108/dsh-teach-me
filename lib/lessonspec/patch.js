/* G2：按稳定 ID 修改源 spec；发布仍由 teach_commit 完成。 */
import fs from 'node:fs'
import path from 'node:path'
import { acquirePathLock } from '../archive/lock.js'
import { assertInside, assertPlainFile, atomicWrite, hashJson, sha256 } from '../archive/util.js'
import { compileSpec } from './compile.js'
import { specHtmlPathOf, specLintErrors } from './integrate.js'
import { LessonSpecError, validateSpec } from './schema.js'

const fields = {
  'replace-section': ['op', 'sectionId', 'value'],
  'replace-block': ['op', 'sectionId', 'blockId', 'value'],
  'insert-block': ['op', 'sectionId', 'afterId', 'value'],
  'remove-block': ['op', 'sectionId', 'blockId'],
  'replace-question': ['op', 'sectionId', 'questionId', 'value']
}
const fail = (message, conflict = false) => {
  const error = new LessonSpecError(message)
  error.code = conflict ? 'lesson-spec-patch-conflict' : 'lesson-spec-patch-invalid'
  throw error
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** patch 前后硬伤按 code 计数比较，返回「新增」的那些（行号会因插入漂移，不能按位置比）。 */
function introducedErrors(before, after) {
  const tally = new Map()
  for (const issue of before) tally.set(issue.code, (tally.get(issue.code) ?? 0) + 1)
  const introduced = []
  for (const issue of after) {
    const left = tally.get(issue.code) ?? 0
    if (left > 0) tally.set(issue.code, left - 1)
    else introduced.push(issue)
  }
  return introduced
}
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail('patch 含未知字段或不是对象')
}
function findIndex(items, key, value) {
  if (typeof value !== 'string' || value.length === 0) fail('patch 缺少稳定目标 id')
  const index = items.findIndex((item) => item[key] === value)
  if (index < 0) fail('patch 目标不存在：' + value, true)
  return index
}

/** 纯计算，hash 按原始 JSON 内容（键排序）算；保持未修改部分的原形状。 */
export function planSpecPatch(raw, patch) {
  validateSpec(raw)
  keys(patch, ['schemaVersion', 'expectedHash', 'resultHash', 'operations'])
  if (patch.schemaVersion !== 1 || typeof patch.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(patch.expectedHash)) fail('patch 版本或 expectedHash 不合法')
  if (patch.resultHash !== undefined && (typeof patch.resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(patch.resultHash))) fail('patch resultHash 不合法')
  if (!Array.isArray(patch.operations) || patch.operations.length === 0 || patch.operations.length > 100) fail('patch 需要 1–100 个操作')
  for (const operation of patch.operations) {
    if (!object(operation) || typeof operation.op !== 'string' || !Object.hasOwn(fields, operation.op)) fail('patch 操作不支持')
    keys(operation, fields[operation.op])
  }
  const beforeHash = hashJson(raw)
  if (patch.resultHash === beforeHash) return { spec: structuredClone(raw), beforeHash, resultHash: beforeHash, alreadyApplied: true }
  if (beforeHash !== patch.expectedHash) fail('spec 内容已变，重新读取后再规划 patch', true)
  const spec = structuredClone(raw)
  for (const operation of patch.operations) {
    const sectionIndex = findIndex(spec.sections, 'id', operation.sectionId)
    const section = spec.sections[sectionIndex]
    if (operation.op === 'replace-section') {
      if (!object(operation.value) || operation.value.id !== operation.sectionId) fail('替换段落必须保留 id')
      spec.sections[sectionIndex] = structuredClone(operation.value)
      continue
    }
    if (operation.op === 'replace-question') {
      if (section.kind !== 'quiz') fail('replace-question 目标必须是 quiz')
      const index = findIndex(section.questions, 'questionId', operation.questionId)
      if (!object(operation.value) || operation.value.questionId !== operation.questionId) fail('替换题目必须保留 questionId')
      section.questions[index] = structuredClone(operation.value)
      continue
    }
    if (!Array.isArray(section.blocks)) fail('块操作目标必须是正文段')
    if (operation.op === 'insert-block') {
      if (!object(operation.value) || typeof operation.value.id !== 'string') fail('插入块必须显式给 id')
      const index = operation.afterId === undefined ? section.blocks.length : findIndex(section.blocks, 'id', operation.afterId) + 1
      section.blocks.splice(index, 0, structuredClone(operation.value))
    } else {
      const index = findIndex(section.blocks, 'id', operation.blockId)
      if (operation.op === 'remove-block') section.blocks.splice(index, 1)
      else {
        if (!object(operation.value) || operation.value.id !== operation.blockId) fail('替换块必须保留 id')
        section.blocks[index] = structuredClone(operation.value)
      }
    }
    // 每一步都保持节点 ID 唯一，不允许一批操作暂时制造歧义目标。
    const ids = section.blocks.filter((block) => block.id !== undefined).map((block) => block.id)
    if (new Set(ids).size !== ids.length) fail('patch 产生重复块 id')
  }
  validateSpec(spec)
  const resultHash = hashJson(spec)
  if (patch.resultHash !== undefined && patch.resultHash !== resultHash) fail('patch 结果不符合 resultHash', true)
  return { spec, beforeHash, resultHash, alreadyApplied: false }
}

function specTarget(workspace, specPath) {
  const root = fs.realpathSync.native(workspace)
  const requested = path.resolve(root, specPath)
  if (!fs.existsSync(requested)) fail('spec 不存在：' + specPath)
  const checked = () => {
    assertPlainFile(requested)
    const real = assertInside(root, requested, 'spec')
    if (!/\.json$/i.test(real)) fail('spec 必须是 JSON 文件')
    return real
  }
  const file = checked()
  return { root, file, checked }
}

/** 只读取得当前 CAS 哈希与可定位节点，供编写 patch 使用。 */
export function inspectSpecFile(workspace, specPath) {
  const { root, file } = specTarget(workspace, specPath)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  const spec = validateSpec(raw)
  return {
    path: path.relative(root, file), expectedHash: hashJson(raw),
    sections: spec.sections.map((section) => ({
      id: section.id,
      nodes: section.kind === 'quiz' ? section.questions.map((question) => question.questionId) : section.blocks.map((block) => block.id ?? null)
    }))
  }
}

/** 默认演练；正式写入只原子替换 spec，不生成 HTML、不写 archive。 */
export function patchSpecFile(workspace, specPath, patch, { dryRun = true } = {}) {
  const { root, file, checked } = specTarget(workspace, specPath)
  const work = () => {
    if (checked() !== file) fail('spec 路径已变化', true)
    const bytes = fs.readFileSync(file, 'utf8')
    const raw = JSON.parse(bytes)
    const planned = planSpecPatch(raw, patch)
    const htmlPath = specHtmlPathOf(file)
    const html = compileSpec(planned.spec).html
    // 只拒绝「本 patch 新增的硬伤」：源文件编辑不该被整页门禁锁死，
    // 否则一节课有两条坏引用时没法一次修一条，patch 的增量价值就没了。
    // 最终能不能发仍然由 teach_commit 的整页 lint 决定（那一步要求全绿）。
    const introduced = introducedErrors(specLintErrors(compileSpec(raw).html, htmlPath), specLintErrors(html, htmlPath))
    if (introduced.length) fail('patch 新增硬伤：' + introduced.map((error) => error.code).join('、') + '（原有硬伤不阻断修改，发布前必须全绿）')
    const changed = planned.resultHash !== planned.beforeHash
    if (!dryRun && changed) {
      if (checked() !== file || fs.readFileSync(file, 'utf8') !== bytes) fail('写入前 spec 已变化', true)
      atomicWrite(file, JSON.stringify(planned.spec, null, 2) + '\n', { mode: fs.statSync(file).mode & 0o777 })
    }
    return {
      ok: true, dryRun, changed, written: !dryRun && changed, alreadyApplied: planned.alreadyApplied,
      path: path.relative(root, file), beforeHash: planned.beforeHash, resultHash: planned.resultHash,
      published: false, nextAction: 'teach_commit'
    }
  }
  if (dryRun) return work()
  const lock = acquirePathLock(path.dirname(file), { name: '.dsh-teach-patch-' + sha256(file).slice(0, 16) + '.lock', label: 'spec-patch', precondition: checked })
  try { return work() } finally { lock.release() }
}
