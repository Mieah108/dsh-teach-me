import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { publishLesson, scanLocalAssets } from '../../lib/archive/operations.js'
import { hashEntry } from '../../lib/archive/journal.js'
import { lintFile } from '../../lib/lint.js'

/* 三条收尾护栏：
 * 1) 课堂清单不收录点号目录（.dsh-teach-me / .dsh-teach-me / .git）——页面里一个 <a href>
 *    就能顺着清单把标准答案取走；
 * 2) 媒体资源漏写时 lesson_lint 报硬伤（发布不报错，课堂里就是静默 404）；
 * 3) 0.3.x 发布的老课程没有 questionIds 投影，重发时补一次修订，补上后回到幂等。 */

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-guard-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, '.dsh-teach-me', 'archive'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'media'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets', 'mathjax'), { recursive: true })
  fs.writeFileSync(path.join(ws, '.dsh-teach-me', 'archive', 'index.json'), '{"answers":["A"]}')
  fs.writeFileSync(path.join(ws, 'media', 'clip.mp4'), 'fake-mp4')
  for (const name of ['course.css', 'course.js', 'mathjax/tex-svg.js']) fs.writeFileSync(path.join(ws, 'assets', name), '/*x*/')
  return ws
}

test('课堂清单不收录点号目录里的文件（答案不该被页面链接带走）', () => {
  const ws = workspace()
  const lesson = path.join(ws, 'lessons', 'one.html')
  fs.writeFileSync(lesson, '<html><body><a href="../.dsh-teach-me/archive/index.json">材料</a><video src="../media/clip.mp4"></video></body></html>')
  const assets = scanLocalAssets(ws, lesson, fs.readFileSync(lesson, 'utf8'))
  assert.deepEqual(assets.map((item) => item.path), ['media/clip.mp4'])
})

test('媒体漏写时 lint 报硬伤（视频 / 封面 / 字幕 / 音频）', () => {
  const ws = workspace()
  const file = path.join(ws, 'lessons', 'media.html')
  fs.writeFileSync(
    file,
    [
      '<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../assets/course.css">',
      '<script src="../assets/course.js"></script><script async src="../assets/mathjax/tex-svg.js"></script></head><body>',
      '<video src="../media/missing.mp4" poster="../media/missing.png" controls></video>',
      '<audio src="../media/missing.mp3"></audio>',
      '<video><source src="../media/missing.webm" type="video/webm"><track kind="captions" src="../media/missing.vtt"></video>',
      '</body></html>'
    ].join('')
  )
  const issues = lintFile(fs.readFileSync(file, 'utf8'), file)
  const missing = issues.filter((issue) => issue.code === 'media-missing')
  assert.equal(missing.length, 5, JSON.stringify(missing.map((issue) => issue.message)))
  assert.ok(missing.every((issue) => issue.level === 'error'))
})

test('老课程没有 questionIds 投影时，重发补一次修订；补上后回到幂等', () => {
  const ws = workspace()
  const lesson = path.join(ws, 'lessons', 'one.html')
  fs.writeFileSync(lesson, '<html><body><div class="quiz" data-question-id="q-1">题</div></body></html>')
  const first = publishLesson(ws, { path: 'lessons/one.html', lessonId: 'lesson-1' })
  assert.equal(first.lessonRevision, 1)
  // 造真实旧 journal，不能只改投影：索引不是权威。
  const archiveDir = path.join(ws, '.dsh-teach-me', 'archive')
  const journal = path.join(archiveDir, 'journal', fs.readdirSync(path.join(archiveDir, 'journal'))[0])
  let previous = 'genesis'
  const lines = fs.readFileSync(journal, 'utf8').trim().split('\n').map((line) => {
    const entry = JSON.parse(line)
    for (const change of entry.changes) if (change.type === 'lesson.published') delete change.data.questionIds
    entry.prevHash = previous
    entry.hash = hashEntry(entry)
    previous = entry.hash
    return JSON.stringify(entry)
  })
  fs.writeFileSync(journal, lines.join('\n') + '\n')
  const healed = publishLesson(ws, { path: 'lessons/one.html', lessonId: 'lesson-1' })
  assert.equal(healed.lessonRevision, 2)
  assert.equal(healed.idempotent, false)
  const again = publishLesson(ws, { path: 'lessons/one.html', lessonId: 'lesson-1' })
  assert.equal(again.idempotent, true)
  assert.equal(again.lessonRevision, 2)
})
