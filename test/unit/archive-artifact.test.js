import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { publishLesson, rebuildArchive, recordArtifact } from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import { artifactKeyOf, artifactsOf, applyChange, emptyState } from '../../lib/archive/state.js'
import { ValidationError } from '../../lib/archive/errors.js'

const HASH_A = createHash('sha256').update('first-render').digest('hex')
const HASH_B = createHash('sha256').update('second-render').digest('hex')

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'teach-artifact-'))
}

/** 读日志里所有 lesson.artifact 事件（老日志没有这类事件时返回空数组）。 */
function journalArtifactEvents(ws) {
  const dir = path.join(ws, '.dsh-teach-me', 'archive', 'journal')
  const files = fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}\.jsonl$/.test(name))
  const events = []
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      const entry = JSON.parse(line)
      for (const change of entry.changes ?? []) {
        if (change.type === 'lesson.artifact') events.push({ entry, change })
      }
    }
  }
  return events
}

test('recordArtifact：写 lesson.artifact 事件，投影给出 path/sha256/帧数/时长/fps/frame', () => {
  const ws = workspace()
  try {
    const at = '2026-02-03T04:05:06.000Z'
    const result = recordArtifact(ws, {
      lessonId: 'l1',
      path: 'out/LLM/ropim-dataflow.mp4',
      sha256: HASH_A,
      frames: 90,
      durationMs: 3000,
      fps: 30,
      at
    })
    assert.equal(result.committed, true)
    assert.equal(result.lessonId, 'l1')
    assert.equal(result.path, 'out/LLM/ropim-dataflow.mp4')
    assert.equal(result.sha256, HASH_A)
    assert.equal(result.frames, 90)
    assert.equal(result.durationMs, 3000)
    assert.equal(result.fps, 30)
    // 成片没有帧号：事件与投影都要明确记成 null，不能缺字段。
    assert.equal(result.frame, null)
    // 0.6.4-D4 补的字段：课程版本。这里没发布 l1，所以是 null；字段本身必须在。
    assert.equal(result.lessonRevision, null)
    assert.equal(result.at, at)

    const archive = openArchive(ws)
    const artifacts = artifactsOf(archive.state)
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].lessonId, 'l1')
    assert.equal(artifacts[0].path, 'out/LLM/ropim-dataflow.mp4')
    assert.equal(artifacts[0].sha256, HASH_A)
    assert.equal(artifacts[0].frames, 90)
    assert.equal(artifacts[0].durationMs, 3000)
    assert.equal(artifacts[0].fps, 30)
    assert.equal(artifacts[0].frame, null)
    assert.equal(artifacts[0].at, at)
    assert.equal(archive.state.artifacts[artifactKeyOf('l1', 'out/LLM/ropim-dataflow.mp4')].sha256, HASH_A)

    const events = journalArtifactEvents(ws)
    assert.equal(events.length, 1)
    assert.equal(events[0].entry.actor, 'teach_artifact_record')
    assert.deepEqual(
      Object.keys(events[0].change.data).sort(),
      // lessonRevision 是 0.6.4-D4 加进 lesson.artifact 的字段（产物绑课程版本）。
      ['at', 'durationMs', 'fps', 'frame', 'frames', 'lessonId', 'lessonRevision', 'path', 'sha256']
    )
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('recordArtifact：静帧产物带 frame，成片保持 null，同一课多帧互不覆盖', () => {
  const ws = workspace()
  try {
    const still = recordArtifact(ws, {
      lessonId: 'l1',
      path: 'out/LLM/demo-f90.png',
      sha256: HASH_A,
      frames: 120,
      fps: 30,
      frame: 90
    })
    assert.equal(still.frame, 90)
    assert.equal(still.durationMs, null)
    recordArtifact(ws, { lessonId: 'l1', path: 'out/LLM/demo-f119.png', sha256: HASH_B, frames: 120, fps: 30, frame: 119 })

    const artifacts = artifactsOf(openArchive(ws).state, { lessonId: 'l1' })
    assert.equal(artifacts.length, 2)
    assert.deepEqual(artifacts.map((item) => item.frame), [90, 119])
    // 事件里有 frame，重放后仍然是同一个帧号
    assert.equal(journalArtifactEvents(ws)[0].change.data.frame, 90)
    const rebuilt = rebuildArchive(ws)
    assert.equal(rebuilt.rebuilt, true)
    assert.deepEqual(
      artifactsOf(openArchive(ws).state, { lessonId: 'l1' }).map((item) => item.frame),
      [90, 119]
    )
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('recordArtifact：同一路径再次渲染追加事件，投影只保留最新一条', () => {
  const ws = workspace()
  try {
    recordArtifact(ws, { lessonId: 'l1', path: 'out/LLM/x.mp4', sha256: HASH_A, frames: 90, durationMs: 3000, fps: 30 })
    const firstRevision = openArchive(ws).state.revision
    recordArtifact(ws, { lessonId: 'l1', path: 'out/LLM/x.mp4', sha256: HASH_B, frames: 120, durationMs: 4000, fps: 30 })

    const archive = openArchive(ws)
    assert.equal(archive.state.revision, firstRevision + 1)
    const artifacts = artifactsOf(archive.state)
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].sha256, HASH_B)
    assert.equal(artifacts[0].frames, 120)
    assert.equal(journalArtifactEvents(ws).length, 2)

    // 分课筛选：未关联课程的产物不会被算进这一课
    recordArtifact(ws, { path: 'out/LLM/other.mp4', sha256: HASH_A })
    assert.equal(artifactsOf(openArchive(ws).state, { lessonId: 'l1' }).length, 1)
    assert.equal(artifactsOf(openArchive(ws).state).length, 2)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('老档案没有 artifacts 字段也能读、也能正常重放（容错旧 journal）', () => {
  // 旧状态没有 artifacts：读取入口返回空数组，不抛错、不补写
  assert.deepEqual(artifactsOf(emptyState()), [])
  assert.deepEqual(artifactsOf({ lessons: {}, questions: {} }), [])
  assert.equal(emptyState().artifacts, undefined)

  const at = '2026-01-02T03:04:05.000Z'
  const state = applyChange(
    emptyState(),
    { type: 'lesson.artifact', data: { path: 'out/only.mp4', sha256: null, frames: null, durationMs: null, fps: null, at, lessonId: null } },
    { at, actor: 'test', seq: 1 }
  )
  assert.equal(artifactsOf(state).length, 1)
  assert.equal(artifactsOf(state)[0].lessonId, null)
  assert.equal(artifactsOf(state)[0].sha256, null)
  assert.equal(artifactsOf(state)[0].path, 'out/only.mp4')
  // 旧事件没有 frame 字段：重放按 null 处理，不判日志损坏，也不补写默认值
  assert.equal(artifactsOf(state)[0].frame, null)
  // 0.6.4-D4 加的 lessonRevision 同理：老日志没有这个字段，按 null 兼容
  assert.equal(artifactsOf(state)[0].lessonRevision, null)

  // 真日志重放：从事件重建出来的投影与写盘时一致
  const ws = workspace()
  try {
    recordArtifact(ws, { lessonId: 'l1', path: 'out/LLM/x.mp4', sha256: HASH_A, frames: 90, durationMs: 3000, fps: 30 })
    const rebuilt = rebuildArchive(ws)
    assert.equal(rebuilt.rebuilt, true)
    const artifacts = artifactsOf(openArchive(ws).state)
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].sha256, HASH_A)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('recordArtifact：产物绑课程 revision（发布时定格），课程改版后旧产物仍记旧版', () => {
  const ws = workspace()
  try {
    fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
    const lessonFile = path.join(ws, 'lessons', 'one.html')
    fs.writeFileSync(lessonFile, '<html><body>v1</body></html>')
    const first = publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
    assert.equal(first.lessonRevision, 1)
    // 不显式传 lessonRevision 时，写档这一刻档案里的课程版本就是绑定值
    const recorded = recordArtifact(ws, { lessonId: 'l1', path: 'out/LLM/x.mp4', sha256: HASH_A, frames: 90, fps: 30 })
    assert.equal(recorded.lessonRevision, 1)
    assert.equal(artifactsOf(openArchive(ws).state)[0].lessonRevision, 1)

    // 课程改版：同路径内容变了 → revision 升到 2；已记录的产物不被追溯改写
    fs.writeFileSync(lessonFile, '<html><body>v2</body></html>')
    const second = publishLesson(ws, { lessonId: 'l1', title: '第一课', path: 'lessons/one.html' })
    assert.equal(second.lessonRevision, 2)
    assert.equal(journalArtifactEvents(ws)[0].change.data.lessonRevision, 1)
    assert.equal(artifactsOf(openArchive(ws).state)[0].lessonRevision, 1)

    // 显式传入优先（渲染起手时定格的那一版）：档案已经到 v2 也按调用方给的版本记
    const explicit = recordArtifact(ws, { lessonId: 'l1', lessonRevision: 1, path: 'out/LLM/y.mp4', sha256: HASH_B })
    assert.equal(explicit.lessonRevision, 1)
    assert.equal(artifactsOf(openArchive(ws).state).find((item) => item.path === 'out/LLM/y.mp4').lessonRevision, 1)

    // 显式传 null = 「渲染时这一课还没发布」，不回落到档案当前版本
    const none = recordArtifact(ws, { lessonId: 'l1', lessonRevision: null, path: 'out/LLM/z.mp4', sha256: HASH_B })
    assert.equal(none.lessonRevision, null)

    // 非法版本明确拒绝，且不落事件
    const before = journalArtifactEvents(ws).length
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', lessonRevision: 0 }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', lessonRevision: 1.5 }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', lessonRevision: 'v1' }), ValidationError)
    assert.equal(journalArtifactEvents(ws).length, before)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('recordArtifact：非法 sha256/帧数/fps/lessonId/空路径都明确拒绝', () => {
  const ws = workspace()
  try {
    assert.throws(() => recordArtifact(ws, { path: '' }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', sha256: 'not-a-hash' }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', sha256: HASH_A.toUpperCase() }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', frames: -1 }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', frames: 1.5 }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', durationMs: -10 }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', fps: 0 }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', frame: -1 }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', frame: 1.5 }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', lessonId: 'bad id' }), ValidationError)
    assert.throws(() => recordArtifact(ws, { path: 'out/x.mp4', at: 'not-a-time' }), ValidationError)
    // 失败的调用不落任何 artifact 事件（档案目录由 openArchive 建，但事件一条都没有）
    assert.equal(journalArtifactEvents(ws).length, 0)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('recordArtifact：拿不到 lessonId 时只记 path，at 可注入', () => {
  const ws = workspace()
  try {
    const at = '2026-02-03T04:05:06.000Z'
    const result = recordArtifact(ws, { path: 'out/unowned.mp4', at })
    assert.equal(result.lessonId, null)
    assert.equal(result.sha256, null)
    assert.equal(result.frames, null)
    assert.equal(result.durationMs, null)
    assert.equal(result.fps, null)
    assert.equal(result.frame, null)

    const artifacts = artifactsOf(openArchive(ws).state)
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0].lessonId, null)
    assert.equal(artifacts[0].path, 'out/unowned.mp4')
    assert.equal(artifacts[0].at, at)
    assert.equal(journalArtifactEvents(ws)[0].change.data.lessonId, null)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})
