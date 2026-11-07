import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { injectClassroomHtml, mimeFor } from '../../lib/classroom/assets.js'
import { registerClassroom } from '../../lib/classroom/service.js'
import { callRpc } from '../helpers/classroom-rpc.js'
import { publishLesson, registerQuestion } from '../../lib/archive/operations.js'
import { formatClassroomHooks, registerStatusTool } from '../../lib/health.js'

/* 课堂桥的挂点：
 *   1. bootstrap 里带着 classroom/open 下发的题目清单；
 *   2. 桥据此给页面里「data-question-id 能对上」的 .quiz 自动补「提交到课堂」；
 *   3. 清单外的 id 只在 console.warn，不打扰学习者、也不让桥报错；
 *   4. teach_status 的「课堂挂点」段能把这些数字读出来。 */

const PAGE = '<!doctype html><html><head><title>课</title></head><body><p>课</p></body></html>'

function injectedWith(questions) {
  return injectClassroomHtml(PAGE, {
    baseHref: '/teach-classroom/token/lessons/',
    bootstrap: { nonce: 'n1', workspaceId: 'ws1', lessonId: 'l1', revision: 2, sessionId: 's1', questions }
  })
}

test('清单里新增的媒体类型按真 MIME 服务（字幕/音轨/视频）', () => {
  assert.equal(mimeFor('a.vtt'), 'text/vtt; charset=utf-8')
  assert.equal(mimeFor('A.WEBVTT'), 'text/vtt; charset=utf-8')
  assert.equal(mimeFor('a.mp4'), 'video/mp4')
  assert.equal(mimeFor('a.m4a'), 'audio/mp4')
  assert.equal(mimeFor('a.ogg'), 'audio/ogg')
  assert.equal(mimeFor('a.unknown'), 'application/octet-stream')
})

test('桥脚本带上题目清单，并具备自动补按钮的全部零件', () => {
  const injected = injectedWith([
    { id: 'q-1', type: 'choice', prompt: '选一个' },
    { id: 'q-2', type: 'short', prompt: '写一句' }
  ])
  // 清单原样进 bootstrap（桥不自己编题目）
  assert.match(injected, /"questions":\[\{"id":"q-1","type":"choice","prompt":"选一个"\}/)
  // 补按钮：找 .quiz[data-question-id]、核对清单、插到 .verdict 之后
  assert.match(injected, /querySelectorAll\('\.quiz\[data-question-id\]'\)/)
  assert.match(injected, /hasQuestion\(questionId\)/)
  assert.match(injected, /verdict\.parentNode\.insertBefore\(row, verdict\.nextSibling\)/)
  assert.match(injected, /quiz\.appendChild\(row\)/)
  // 按钮本身：中文文案 + 现有提交通道 + 可识别的自动标记
  assert.match(injected, /提交到课堂/)
  assert.match(injected, /button\.setAttribute\('data-teach-submit', ''\)/)
  assert.match(injected, /button\.setAttribute\('data-teach-auto', '1'\)/)
  // 已有提交按钮的题不重复加；清单外的 id 只警告一次
  assert.match(injected, /wiredTo\(quiz, questionId\)/)
  assert.match(injected, /console\.warn\('\[teach-classroom\] 页面里的 data-question-id 不在课堂题目清单里：' \+ questionId\)/)
  // 答案取值复用同一套逻辑（radio 优先，其次文本输入）
  assert.match(injected, /function answerOf\(quiz\)/)
  assert.match(injected, /input\[type="radio"\]:checked/)
  assert.match(injected, /textarea, input\[type="text"\]/)
  // 取值协议：checkbox 全部选中项用英文逗号连接，select 与其它文本类 input 取 value
  assert.match(injected, /input\[type="checkbox"\]:checked/)
  assert.match(injected, /values\.join\('\,'\)/)
  assert.match(injected, /quiz\.querySelector\('select'\)/)
  assert.match(injected, /input\[type="number"\]/)
  // 提交反馈：待批改/失效结论各有分支，服务端 message 要透出
  assert.match(injected, /needsGrading/)
  assert.match(injected, /旧结论已失效/)
  assert.match(injected, /error\.message/)
  // 页面自带脚本（course.js，defer）先绑好判卷按钮，再补提交按钮
  assert.match(injected, /document\.addEventListener\('DOMContentLoaded', mountSubmitButtons\)/)
  // 作者手写了提交按钮时的认领逻辑：只补一只、并进动作行、保留作者文案
  assert.match(injected, /function adoptableButton\(quiz\)/)
  assert.match(injected, /adopted\.setAttribute\('data-teach-adopted', '1'\)/)
  assert.match(injected, /function actionArea\(quiz\)/)
  // 主操作排在复制之前：两个入口都 insertBefore 到动作行最前
  assert.match(injected, /actions\.insertBefore\(submitButton\(questionId\), actions\.firstChild\)/)
  assert.match(injected, /actions\.insertBefore\(adopted, actions\.firstChild\)/)
  // 没下发清单时不报错，只提示一句
  assert.match(injectedWith(undefined), /课堂没有下发题目清单/)
})

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-bridge-'))
  fs.mkdirSync(path.join(ws, 'lessons'), { recursive: true })
  fs.mkdirSync(path.join(ws, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(ws, 'assets', 'course.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(ws, 'assets', 'course.css'), 'body{}\n')
  fs.writeFileSync(
    path.join(ws, 'lessons', 'one.html'),
    '<html><head><link rel="stylesheet" href="../assets/course.css"><script src="../assets/course.js"></script></head><body>' +
      '<div class="quiz" data-question-id="q-1" data-explain="x" data-scope="口径"><p class="q">题</p>' +
      '<label><input type="radio" name="q1">A</label><label><input type="radio" name="q1" data-ok="1">B</label>' +
      '<button type="button">判卷</button><p class="verdict"></p></div></body></html>'
  )
  publishLesson(ws, { lessonId: 'l1', path: 'lessons/one.html', title: '第一课' })
  registerQuestion(ws, { questionId: 'q-1', lessonId: 'l1', type: 'choice', prompt: '选一个', options: [{ id: 'a' }, { id: 'b' }], answer: 'a' })
  return ws
}

class Response {
  constructor() {
    this.status = 0
    this.headers = {}
    this.body = undefined
  }
  writeHead(status, headers) {
    this.status = status
    this.headers = { ...this.headers, ...(headers ?? {}) }
  }
  setHeader(name, value) {
    this.headers[name] = value
  }
  end(body) {
    this.body = body
  }
}

test('课堂页真正服出去时带着题目清单（桥才有东西可挂）', async () => {
  const ws = workspace()
  const captured = { route: undefined, rpc: undefined }
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (route) => { captured.route = route; return () => {} } }
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'sessions') return { get: (id) => (id === 's1' ? { header: { cwd: ws } } : undefined) }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    },
    logger: { warn: () => {} }
  }
  registerClassroom(ctx, { getConfig: () => ({ animation: { root: '' } }) })
  const rpc = async (endpoint, payload) => (await callRpc(captured.route, endpoint, payload)).result
  const opened = await rpc('classroom/open', { sessionId: 's1', path: 'lessons/one.html' })
  assert.equal(opened.ok, true)
  const pageUrl = opened.value.url
  const page = new Response()
  await captured.route.handler({ method: 'GET', url: pageUrl, headers: {} }, page)
  assert.equal(page.status, 200)
  const html = page.body.toString('utf8')
  assert.match(html, /"questions":\[\{"id":"q-1"/)
  assert.match(html, /提交到课堂/)
  assert.match(html, /teach-classroom-bridge/)
  // 标准答案不下发给页面
  assert.doesNotMatch(html, /"answer":"a"/)
})

test('teach_status 的「课堂挂点」段读得到页面/已登记/悬空/档案有页面没挂', async () => {
  const registered = []
  const ws = workspace()
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (tool) => { registered.push(tool); return () => {} } }
      if (name === 'teachSettings') return { get: () => ({}), source: 'test' }
      if (name === 'workingDirectory') return { get: () => ws }
      return undefined
    },
    effect(factory) {
      factory()
      return () => {}
    }
  }
  registerStatusTool(ctx, () => ({ animation: { root: '' } }), { workspaceOf: () => ws })
  const status = registered.find((tool) => tool.name === 'teach_status')
  const value = await status.execute({}, { agent: { session: { id: 's1' } } })
  assert.equal(value.archive, 'ready')
  assert.match(value.text, /课堂挂点：页面声明 1 题，其中 1 题已登记，悬空 0 题。/)

  // 档案里有、页面没挂的题目要单独点名
  registerQuestion(ws, { questionId: 'q-2', lessonId: 'l1', type: 'choice', prompt: '没挂到页面', options: [{ id: 'a' }], answer: 'a' })
  const withGap = await status.execute({}, { agent: { session: { id: 's1' } } })
  assert.match(withGap.text, /档案有、页面没挂：q-2/)

  const empty = formatClassroomHooks({})
  assert.match(empty, /页面还没声明 data-question-id/)
});
