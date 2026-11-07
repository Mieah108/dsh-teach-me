import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { classroomHeaders, injectClassroomHtml, lessonOf, mimeFor, parseRange, resolveAsset } from '../../lib/classroom/assets.js'
import { openArchive } from '../../lib/archive/store.js'
import { publishLesson } from '../../lib/archive/operations.js'

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-classroom-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'assets', 'course.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(ws, 'assets', 'course.css'), 'body{}\n')
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), '<html><head><link rel="stylesheet" href="../assets/course.css"></head><body><script src="../assets/course.js"></script>课程</body></html>')
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  return ws
}

test('MIME 与课程/资源解析', () => {
  const ws = workspace()
  const archive = openArchive(ws)
  const found = lessonOf(archive, 'l1', 1)
  assert.equal(found.lesson.id, 'l1')
  assert.equal(mimeFor('a.html'), 'text/html; charset=utf-8')
  assert.equal(mimeFor('a.mp4'), 'video/mp4')
  assert.equal(mimeFor('a.unknown'), 'application/octet-stream')

  const page = resolveAsset(ws, found.lesson, '')
  assert.equal(page.html, true)
  assert.equal(page.relative, 'lessons/one.html')
  const script = resolveAsset(ws, found.lesson, 'assets/course.js')
  assert.equal(script.html, false)
  assert.equal(script.manifest.path, 'assets/course.js')
  assert.equal(resolveAsset(ws, found.lesson, 'assets/not-listed.txt').error, 'asset-not-listed')
  assert.equal(resolveAsset(ws, found.lesson, '../outside.txt').error, 'asset-not-listed')
})

test('size 与 revision 校验', () => {
  const ws = workspace()
  const archive = openArchive(ws)
  fs.appendFileSync(path.join(ws, 'assets', 'course.css'), 'x')
  const found = lessonOf(archive, 'l1', 1)
  assert.equal(resolveAsset(ws, found.lesson, 'assets/course.css').error, 'asset-size-mismatch')
  assert.equal(lessonOf(archive, 'l1', 2).error, 'lesson-revision-stale')
  assert.equal(lessonOf(archive, 'missing', 1).error, 'lesson-not-found')
})

test('Range 解析：单段、后缀、越界、多段', () => {
  assert.deepEqual(parseRange('bytes=0-3', 10), { start: 0, end: 3 })
  assert.deepEqual(parseRange('bytes=4-', 10), { start: 4, end: 9 })
  assert.deepEqual(parseRange('bytes=-3', 10), { start: 7, end: 9 })
  assert.equal(parseRange('bytes=0-1,4-5', 10), null)
  assert.equal(parseRange('items=0-1', 10), null)
  assert.equal(parseRange('bytes=99-', 10).unsatisfiable, true)
  assert.equal(parseRange('bytes=-0', 10).unsatisfiable, true)
})

test('HTML 注入 base 与课堂桥，bootstrap 不破坏 HTML', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body><p>课</p></body></html>'
  const injected = injectClassroomHtml(html, {
    baseHref: '/teach-classroom/token/lessons/',
    bootstrap: { nonce: 'n1', lessonId: 'l1', revision: 2, sessionId: 's1', workspaceId: 'ws1' }
  })
  assert.match(injected, /<base href="\/teach-classroom\/token\/lessons\/">/)
  assert.match(injected, /teach-classroom-bootstrap/)
  assert.match(injected, /window\.teachClassroom/)
  assert.match(injected, /"nonce":"n1"/)
  assert.ok(injected.indexOf('<base') < injected.indexOf('<title>'))
  assert.ok(injected.indexOf('teach-classroom-bridge') < injected.indexOf('</body>'))
  assert.match(classroomHeaders()['Cache-Control'], /no-store/)
})
