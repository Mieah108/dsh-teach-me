import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  archiveStatus,
  classroomHookOf,
  indexMaterial,
  publishLesson,
  questionIdsOf,
  registerQuestion,
  scanLocalAssets
} from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import { applyChange, emptyState } from '../../lib/archive/state.js'
import { ValidationError } from '../../lib/archive/errors.js'
import { registerArchiveTools } from '../../lib/archive/tools.js'

/* 课堂挂点的两条链路：
 *   1. 资源清单要收全（video/poster/a 等），否则课堂路由按清单服务时一律 404；
 *   2. 页面声明的 data-question-id 要抽出来、写进事件、投影进状态，
 *      并在发布回执里跟已登记题目对账。 */

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-classroom-hooks-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'reference', 'materials'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'assets', 'course.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(ws, 'assets', 'course.css'), 'body{}\n')
  fs.writeFileSync(path.join(ws, 'assets', 'clip.mp4'), 'fake-mp4')
  fs.writeFileSync(path.join(ws, 'assets', 'clip-poster.jpg'), 'fake-jpg')
  fs.writeFileSync(path.join(ws, 'assets', 'track.vtt'), 'WEBVTT\n')
  fs.writeFileSync(path.join(ws, 'assets', 'voice.mp3'), 'fake-mp3')
  fs.writeFileSync(path.join(ws, 'assets', 'widget.svg'), '<svg></svg>')
  fs.writeFileSync(path.join(ws, 'reference', 'glossary.html'), '<html>glossary</html>')
  fs.writeFileSync(path.join(ws, 'reference', 'materials', 'notes.pdf'), '%PDF-1.4')
  fs.writeFileSync(path.join(ws, 'reference', 'materials', 'slides.pdf'), '%PDF-1.5')
  return ws
}

const MEDIA_HTML = [
  '<html><head><link rel="stylesheet" href="../assets/course.css"><script src="../assets/course.js"></script></head><body>',
  '<video src="../assets/clip.mp4" poster="../assets/clip-poster.jpg" controls>',
  '  <source src="../assets/clip.mp4" type="video/mp4"><track src="../assets/track.vtt" kind="captions">',
  '</video>',
  '<audio src="../assets/voice.mp3"></audio>',
  '<a href="../reference/glossary.html">术语表</a>',
  '<a href="https://example.com/x">外链</a>',
  '<a href="#s1">锚点</a>',
  '<a href="../reference/materials/notes.pdf">讲义</a>',
  '<img src="../assets/never-created.png">',
  '<object data="../reference/materials/slides.pdf"></object>',
  '<embed src="../assets/widget.svg">',
  '</body></html>'
].join('\n')

test('资源扫描：script/link/img/video/audio/source/track/a/object/embed 都收，kind 用标签名', () => {
  const ws = workspace()
  const lesson = path.join(ws, 'lessons', 'one.html')
  fs.writeFileSync(lesson, MEDIA_HTML)
  const assets = scanLocalAssets(ws, lesson, MEDIA_HTML)
  const byPath = new Map(assets.map((item) => [item.path, item]))

  assert.deepEqual([...byPath.keys()], [
    'assets/clip-poster.jpg',
    'assets/clip.mp4',
    'assets/course.css',
    'assets/course.js',
    'assets/track.vtt',
    'assets/voice.mp3',
    'assets/widget.svg',
    'reference/glossary.html',
    'reference/materials/notes.pdf',
    'reference/materials/slides.pdf'
  ])
  // video 的封面单独记 video-poster，免得和视频本体混在一起
  assert.equal(byPath.get('assets/clip-poster.jpg').kind, 'video-poster')
  assert.equal(byPath.get('assets/clip.mp4').kind, 'video')
  assert.equal(byPath.get('assets/track.vtt').kind, 'track')
  assert.equal(byPath.get('assets/voice.mp3').kind, 'audio')
  assert.equal(byPath.get('assets/widget.svg').kind, 'embed')
  assert.equal(byPath.get('reference/glossary.html').kind, 'a')
  assert.equal(byPath.get('reference/materials/notes.pdf').kind, 'a')
  assert.equal(byPath.get('reference/materials/slides.pdf').kind, 'object')
  assert.equal(byPath.get('assets/course.js').kind, 'script')
  for (const item of assets) {
    assert.match(item.sha256, /^[0-9a-f]{64}$/)
    assert.equal(typeof item.size, 'number')
    assert.deepEqual(Object.keys(item).sort(), ['kind', 'path', 'sha256', 'size'])
  }
  // 工作区里不存在的本地图片不进清单（交给自己 lint 去报 img-missing）
  assert.equal(byPath.has('assets/never-created.png'), false)
})

test('资源扫描：越界照旧报错，外部 URL / 锚点 / 协议相对照旧跳过', () => {
  const ws = workspace()
  const lesson = path.join(ws, 'lessons', 'one.html')
  const escape = '<html><body><a href="../../../../etc/hosts">越界</a></body></html>'
  fs.writeFileSync(lesson, escape)
  assert.throws(() => scanLocalAssets(ws, lesson, escape), ValidationError)
  const missingEscape = '<html><body><a href="../../definitely-missing-xyz.txt">越界</a></body></html>'
  assert.throws(() => scanLocalAssets(ws, lesson, missingEscape), ValidationError)

  const external = '<html><body><a href="https://example.com/a.pdf">外链</a><img src="//cdn.example.com/x.png"><video src="#clip"></video><track src="data:text/vtt,WEBVTT"></body></html>'
  assert.deepEqual(scanLocalAssets(ws, lesson, external), [])
})

test('发布把新标签写进课程清单，课堂路由才服务得到', () => {
  const ws = workspace()
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), MEDIA_HTML)
  const published = publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  const kinds = new Map(published.assets.map((item) => [item.path, item.kind]))
  assert.equal(kinds.get('assets/clip.mp4'), 'video')
  assert.equal(kinds.get('assets/clip-poster.jpg'), 'video-poster')
  assert.equal(kinds.get('reference/glossary.html'), 'a')
  assert.deepEqual(openArchive(ws).state.lessons.l1.assets.map((item) => item.path).sort(), published.assets.map((item) => item.path).sort())
})

test('data-question-id 抽取：去重、排序、忽略占位符；发布后投影进状态', () => {
  assert.deepEqual(questionIdsOf('<div class="quiz" data-question-id="q-2"></div><div class="quiz" data-question-id="q-1"></div>'), ['q-1', 'q-2'])
  assert.deepEqual(questionIdsOf("<div class='quiz' data-question-id='q-1'></div><div class=\"quiz\" data-question-id=\"q-1\"></div>"), ['q-1'])
  assert.deepEqual(questionIdsOf('<div class="quiz" data-question-id="〔q-id〕"></div><div class="quiz" data-question-id=""></div>'), [])
  assert.deepEqual(questionIdsOf('<div class="quiz"></div>'), [])

  const ws = workspace()
  const html = MEDIA_HTML.replace(
    '</body>',
    '<div class="quiz" data-question-id="q-2" data-explain="x"></div><div class="quiz" data-question-id="q-1" data-explain="x"></div><div class="quiz" data-question-id="q-9" data-explain="x"></div></body>'
  )
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), html)
  const published = publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  assert.deepEqual(openArchive(ws).state.lessons.l1.questionIds, ['q-1', 'q-2', 'q-9'])
  // 挂点摘要只给发布文案用：不出现在工具返回值里（output schema 不允许额外字段）
  assert.equal(Object.keys(published).includes('classroomHooks'), false)
  assert.deepEqual(published.classroomHooks.pageQuestionIds, ['q-1', 'q-2', 'q-9'])
  assert.deepEqual(published.classroomHooks.danglingIds, ['q-1', 'q-2', 'q-9'])

  registerQuestion(ws, { questionId: 'q-1', lessonId: 'l1', type: 'choice', prompt: '选一个', options: [{ id: 'a' }, { id: 'b' }], answer: 'a' })
  const status = archiveStatus(ws)
  assert.deepEqual(status.classroomHooks.lessons[0].registeredPageIds, ['q-1'])
  assert.deepEqual(status.classroomHooks.danglingIds, ['q-2', 'q-9'])
  assert.equal(status.classroomHooks.pageQuestions, 3)
  assert.equal(status.classroomHooks.registered, 1)
  assert.equal(status.classroomHooks.dangling, 2)

  // 档案里有、页面没挂：课堂里点不到提交按钮
  registerQuestion(ws, { questionId: 'q-7', lessonId: 'l1', type: 'choice', prompt: '另一题', options: [{ id: 'a' }], answer: 'a' })
  assert.deepEqual(classroomHookOf(openArchive(ws).state, 'l1').archiveOnlyIds, ['q-7'])
  assert.deepEqual(archiveStatus(ws).classroomHooks.archiveOnlyIds, ['q-7'])
})

test('旧 journal 的 lesson.published 没有 questionIds 时按空数组重放，不判损坏', () => {
  const state = emptyState()
  applyChange(
    state,
    {
      type: 'lesson.published',
      data: {
        id: 'l1',
        title: '旧课',
        path: 'lessons/one.html',
        revision: 1,
        fingerprint: 'a'.repeat(64),
        assets: [],
        objectives: [],
        publishedAt: '2026-01-01T00:00:00.000Z'
      }
    },
    { at: '2026-01-01T00:00:00.000Z', actor: 'replay' }
  )
  assert.deepEqual(state.lessons.l1.questionIds, [])
})

test('发布回执：课堂挂点摘要 + 未索引材料提醒；没有 data-question-id 时说清楚', async () => {
  const ws = workspace()
  fs.writeFileSync(path.join(ws, 'lessons', 'one.html'), MEDIA_HTML)
  const registered = []
  registerArchiveTools(
    {
      get: (name) => (name === 'tools' ? { register: (tool) => { registered.push(tool); return () => {} } } : undefined),
      effect: (factory) => factory()
    },
    { tools: { archive: true } },
    () => ws
  )
  const publish = registered.find((tool) => tool.name === 'teach_lesson_publish')
  const first = await publish.execute({ path: 'lessons/one.html', lessonId: 'l1', title: '第一课' }, { agent: { session: { id: 's1' } } })
  assert.equal(first.ok, true)
  assert.match(first.text, /课堂挂点：页面没有 data-question-id/)
  assert.match(first.text, /资料提醒：页面引用了 2 个 reference\/materials\/ 下的本地文件/)
  assert.match(first.text, /reference\/materials\/notes\.pdf/)
  assert.match(first.text, /reference\/materials\/slides\.pdf/)

  // 登记一题、页面挂一题、再留一个悬空 id；索引材料后资料提醒消失
  fs.writeFileSync(
    path.join(ws, 'lessons', 'one.html'),
    MEDIA_HTML.replace('</body>', '<div class="quiz" data-question-id="q-1"></div><div class="quiz" data-question-id="q-ghost"></div></body>')
  )
  registerQuestion(ws, { questionId: 'q-1', lessonId: 'l1', type: 'choice', prompt: '选一个', options: [{ id: 'a' }], answer: 'a' })
  indexMaterial(ws, { materialId: 'm1', kind: 'file', title: '讲义', path: 'reference/materials/notes.pdf' })
  indexMaterial(ws, { materialId: 'm2', kind: 'file', title: '幻灯片', path: 'reference/materials/slides.pdf' })
  const second = await publish.execute({ path: 'lessons/one.html', lessonId: 'l1', title: '第一课' }, { agent: { session: { id: 's1' } } })
  assert.equal(second.ok, true)
  assert.match(second.text, /课堂挂点：页面声明 2 题，其中 1 题已登记，悬空 1 题：q-ghost/)
  // 顺序文案：登记这些题即可，不要重新发布（重发会让已打开的课堂失效）
  assert.match(second.text, /登记这些题/)
  assert.match(second.text, /不要重新发布/)
  assert.match(second.text, /已打开的课堂失效/)
  assert.doesNotMatch(second.text, /资料提醒/)
})

test('发布回执：dryRun 只核对并预告 revision，不写档案也不要求重发', async () => {
  const ws = workspace()
  fs.writeFileSync(
    path.join(ws, 'lessons', 'one.html'),
    MEDIA_HTML.replace('</body>', '<div class="quiz" data-question-id="q-1"></div><div class="quiz" data-question-id="q-2"></div></body>')
  )
  const registered = []
  registerArchiveTools(
    {
      get: (name) => (name === 'tools' ? { register: (tool) => { registered.push(tool); return () => {} } } : undefined),
      effect: (factory) => factory()
    },
    { tools: { archive: true } },
    () => ws
  )
  const publish = registered.find((tool) => tool.name === 'teach_lesson_publish')
  const exec = { agent: { session: { id: 's1' } } }
  const dry = await publish.execute({ path: 'lessons/one.html', lessonId: 'l1', title: '第一课', dryRun: true }, exec)
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)
  assert.equal(dry.committed, false)
  assert.equal(dry.lessonRevision, 0)
  assert.match(dry.text, /演练/)
  assert.match(dry.text, /正式发布会写成 revision 1/)
  assert.match(dry.text, /悬空 2 题：q-1、q-2/)
  assert.equal(fs.existsSync(path.join(ws, '.dsh-teach-me')), false)

  const real = await publish.execute({ path: 'lessons/one.html', lessonId: 'l1', title: '第一课' }, exec)
  assert.equal(real.ok, true)
  assert.equal(real.committed, true)
  assert.equal(real.lessonRevision, 1)
  const revision = openArchive(ws).state.revision

  const again = await publish.execute({ path: 'lessons/one.html', lessonId: 'l1', title: '第一课', dryRun: true }, exec)
  assert.equal(again.ok, true)
  assert.equal(again.idempotent, true)
  assert.match(again.text, /幂等/)
  assert.equal(openArchive(ws).state.revision, revision, 'dryRun 不能写日志')
})
