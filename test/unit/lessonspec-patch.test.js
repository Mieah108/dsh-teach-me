import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hashJson } from '../../lib/archive/util.js'
import { compileSpec } from '../../lib/lessonspec/compile.js'
import { inspectSpecFile, patchSpecFile, planSpecPatch } from '../../lib/lessonspec/patch.js'

const specOf = () => ({
  schemaVersion: 1, id: 'patch-demo',
  meta: { serial: '0001', course: '', title: '修改示例', eyebrow: '', lede: '' },
  sections: [
    { id: 'body', title: '正文', blocks: [{ id: 'mechanism', kind: 'p', text: '原文' }] },
    { id: 'check', kind: 'quiz', title: '验收', questions: [{ questionId: 'q1', type: 'short', prompt: '回答？', answer: '是' }] }
  ]
})
const patchOf = (spec) => ({ schemaVersion: 1, expectedHash: hashJson(spec), operations: [
  { op: 'replace-block', sectionId: 'body', blockId: 'mechanism', value: { id: 'mechanism', kind: 'p', text: '新文' } },
  { op: 'insert-block', sectionId: 'body', afterId: 'mechanism', value: { id: 'hint', kind: 'callout', text: '提示' } }
] })

test('G2：按 ID 修改，不改入参；同补丁确定性与 resultHash 幂等', () => {
  const spec = specOf()
  const before = JSON.stringify(spec)
  const patch = patchOf(spec)
  const planned = planSpecPatch(spec, patch)
  assert.equal(JSON.stringify(spec), before)
  assert.deepEqual(planned, planSpecPatch(spec, patch))
  assert.equal(planned.spec.sections[0].blocks[0].text, '新文')
  assert.match(compileSpec(planned.spec).html, /data-node-id="mechanism"/)
  assert.equal(planSpecPatch(planned.spec, { ...patch, resultHash: planned.resultHash }).alreadyApplied, true)
  assert.throws(() => planSpecPatch(planned.spec, patch), /内容已变/)
})

test('G2：替换段落补 ID、修改题目及删除块，旧块无 ID 仍可编译', () => {
  const spec = specOf()
  delete spec.sections[0].blocks[0].id
  assert.equal(compileSpec(spec).html.includes('data-node-id='), false)
  const patch = { schemaVersion: 1, expectedHash: hashJson(spec), operations: [
    { op: 'replace-section', sectionId: 'body', value: specOf().sections[0] },
    { op: 'insert-block', sectionId: 'body', value: { id: 'temp', kind: 'p', text: '临时' } },
    { op: 'remove-block', sectionId: 'body', blockId: 'temp' },
    { op: 'replace-question', sectionId: 'check', questionId: 'q1', value: { questionId: 'q1', type: 'short', prompt: '新题？', answer: '否' } }
  ] }
  const result = planSpecPatch(spec, patch).spec
  assert.equal(result.sections[0].blocks.length, 1)
  assert.equal(result.sections[1].questions[0].answer, '否')
})

test('G2：拒绝丢失目标、重复节点、改 ID、未知操作及错误结果哈希', () => {
  const spec = specOf()
  const invalid = [
    { op: 'remove-block', sectionId: 'body', blockId: 'missing' },
    { op: 'insert-block', sectionId: 'body', value: spec.sections[0].blocks[0] },
    { op: 'replace-block', sectionId: 'body', blockId: 'mechanism', value: { kind: 'p', id: 'other', text: 'x' } },
    { op: 'replace-section', sectionId: 'body', value: { id: 'other', title: 'x', blocks: [] } },
    { op: 'remove-block', sectionId: 'body', blockId: 'mechanism' },
    { op: 'unknown', sectionId: 'body' }
  ]
  for (const operation of invalid) assert.throws(() => planSpecPatch(spec, { schemaVersion: 1, expectedHash: hashJson(spec), operations: [operation] }))
  assert.throws(() => planSpecPatch(spec, { ...patchOf(spec), resultHash: '0'.repeat(64) }))
  assert.throws(() => planSpecPatch(spec, { ...patchOf(spec), expectedHash: [hashJson(spec)] }))
  assert.throws(() => planSpecPatch(spec, { ...patchOf(spec), operations: [{ ...patchOf(spec).operations[0], op: ['replace-block'] }] }))
})

test('G2：文件演练零写、正式写仅改 spec，重试不覆盖外部修改', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-patch-'))
  try {
    fs.mkdirSync(path.join(root, 'lessons'))
    fs.mkdirSync(path.join(root, 'assets/mathjax'), { recursive: true })
    for (const file of ['course.css', 'course.js', 'mathjax/tex-svg.js']) {
      fs.copyFileSync(new URL('../../templates/' + file, import.meta.url), path.join(root, 'assets', file))
    }
    const file = path.join(root, 'lessons/one.spec.json')
    const spec = specOf()
    const bytes = JSON.stringify(spec)
    fs.writeFileSync(file, bytes)
    const inspected = inspectSpecFile(root, file)
    assert.equal(inspected.expectedHash, hashJson(spec))
    const patch = patchOf(spec)
    const dry = patchSpecFile(root, file, patch)
    assert.equal(dry.written, false)
    assert.equal(fs.readFileSync(file, 'utf8'), bytes)
    const replayable = { ...patch, resultHash: dry.resultHash }
    assert.equal(patchSpecFile(root, file, replayable, { dryRun: false }).written, true)
    assert.equal(patchSpecFile(root, file, replayable, { dryRun: false }).alreadyApplied, true)
    const modified = JSON.parse(fs.readFileSync(file, 'utf8'))
    modified.meta.title = '外部修改'
    fs.writeFileSync(file, JSON.stringify(modified))
    assert.throws(() => patchSpecFile(root, file, replayable, { dryRun: false }))
    assert.equal(fs.existsSync(path.join(root, 'lessons/one.html')), false)
    assert.equal(fs.existsSync(path.join(root, '.dsh-teach-me')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
function patchHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-patch-lint-'))
  fs.mkdirSync(path.join(root, 'lessons'))
  fs.mkdirSync(path.join(root, 'assets/mathjax'), { recursive: true })
  for (const file of ['course.css', 'course.js', 'mathjax/tex-svg.js']) {
    fs.copyFileSync(new URL('../../templates/' + file, import.meta.url), path.join(root, 'assets', file))
  }
  return root
}

test('G2：原有硬伤不挡分步修，新增硬伤才拒绝', () => {
  const root = patchHarness()
  try {
    const spec = specOf()
    // 两条坏引用：先各修一条是正常编辑节奏，不能要求一次修到全绿。
    spec.sections[0].blocks.push(
      { id: 'imgA', kind: 'image', src: '../assets/a.png', alt: 'a' },
      { id: 'imgB', kind: 'image', src: '../assets/b.png', alt: 'b' }
    )
    const specPath = path.join(root, 'lessons/one.spec.json')
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n')
    const removeA = { schemaVersion: 1, expectedHash: inspectSpecFile(root, specPath).expectedHash, operations: [
      { op: 'remove-block', sectionId: 'body', blockId: 'imgA' }
    ] }
    const fixedOne = patchSpecFile(root, specPath, removeA, { dryRun: false })
    assert.equal(fixedOne.written, true)
    assert.equal(JSON.parse(fs.readFileSync(specPath, 'utf8')).sections[0].blocks.some((b) => b.id === 'imgB'), true)

    // 新插入一条坏引用 = 新增硬伤，仍然拒绝，且文件不动。
    const bytes = fs.readFileSync(specPath, 'utf8')
    const introduce = { schemaVersion: 1, expectedHash: inspectSpecFile(root, specPath).expectedHash, operations: [
      { op: 'insert-block', sectionId: 'body', afterId: 'mechanism', value: { id: 'imgC', kind: 'image', src: '../assets/c.png', alt: 'c' } }
    ] }
    assert.throws(() => patchSpecFile(root, specPath, introduce, { dryRun: false }), /新增硬伤/)
    assert.equal(fs.readFileSync(specPath, 'utf8'), bytes)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('G2：spec 不存在时给可读错误码，而不是裸 ENOENT', () => {
  const root = patchHarness()
  try {
    assert.throws(() => inspectSpecFile(root, 'lessons/missing.spec.json'), (error) =>
      error.code === 'lesson-spec-patch-invalid' && /不存在/.test(error.message))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
