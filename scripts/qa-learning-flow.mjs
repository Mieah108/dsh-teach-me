#!/usr/bin/env node
/* 有真实档案与 HTTP 能力票的浏览器闭环；仅使用临时合成课程，不调用模型。 */
import { hostPrimitiveAssets } from './host-ui-primitives.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { publishLesson, registerQuestion } from '../lib/archive/operations.js'
import { registerClassroom } from '../lib/classroom/service.js'
import { createTeachingPreferences } from '../lib/teaching-preferences.js'
import { openArchive } from '../lib/archive/store.js'
import { withLearningScope } from '../lib/archive/learning-scope.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teach-flow-')))
fs.mkdirSync(path.join(root, 'lessons'))
fs.writeFileSync(path.join(root, 'lessons/one.html'), '<!doctype html><html><head><title>浏览器合成课程</title><style>body{font:20px sans-serif;line-height:1.7}section{height:900px}input,button{font:inherit}</style></head><body><main>' + [1,2,3,4].map((i) => `<section id="s${i}"><h2>章节 ${i}</h2><p>合成课程阅读内容</p></section>`).join('') + '<div class="quiz" data-question-id="q"><p class="q">填写 a</p><input type="text" aria-label="答案"></div></main></body></html>')
publishLesson(root, { lessonId: 'one', title: '浏览器合成课程', path: 'lessons/one.html' })
registerQuestion(root, { lessonId: 'one', questionId: 'q', type: 'short', prompt: '填写 a', answer: 'a' })
const records = new Map()
const preferences = createTeachingPreferences(() => ({ open: async () => ({ table: () => ({ get: (id) => records.get(id), put: async (id, value) => { records.set(id, structuredClone(value)) } }), close: async () => {} }) }), () => ({}))
let route
registerClassroom({ get: (key) => ({ webServer: { register: (value) => { route = value } }, connection: { requestRejection: () => undefined }, sessions: { get: (id) => ['session-a', 'session-b'].includes(id) ? { header: { cwd: root } } : undefined }, teachPreferences: preferences })[key], effect: (factory) => factory() })
const built = await build({ entryPoints: ['test/fixtures/host-ui/learning-flow.js'], bundle: true, format: 'esm', external: ['/host-assets/host-primitives.js'], write: false })
const client = fs.readFileSync('client.js')
const hostAssets = hostPrimitiveAssets()
const server = http.createServer((req, res) => {
  if (hostAssets(req, res)) return
  if (req.url.startsWith('/teach-classroom')) { route.handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message) }); return }
  if (req.url === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(built.outputFiles[0].contents); return }
  if (req.url === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(client); return }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head><style>:root{--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#151517;--dsw-alias-label-secondary:#5c6068;--dsw-alias-border-l2:#ddd;--dsw-alias-border-l3:#bbb;--dsh-font-family-text-default:system-ui}body{margin:24px;font:14px system-ui}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const require = createRequire(path.resolve(path.dirname(process.execPath), '../lib/node_modules/@playwright/cli/') + '/')
const { chromium } = require('playwright')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const dock = page.locator('#dock')
  const originalTop = (await page.locator('#courses').boundingBox()).y
  await dock.getByRole('button', { name: '教学设置', exact: true }).click()
  await page.locator('.tsm-teaching-popover').getByRole('slider', { name: '事实核查等级' }).waitFor()
  const popup = page.locator('.tsm-teaching-popover')
  assert.equal(await popup.locator('select').count(), 0)
  assert.equal((await page.locator('#courses').boundingBox()).y, originalTop)
  await popup.getByRole('button', { name: '当前教学集合', exact: true }).click()
  await page.getByRole('menuitem', { name: '默认集合', exact: true }).click()
  await popup.getByRole('slider', { name: '事实核查等级' }).focus()
  await page.keyboard.press('Home')
  await page.waitForFunction(() => document.querySelector('.tsm-teaching-popover [role=status]')?.textContent === '已保存')
  // 成功结果只给读屏：弹层里不应再出现可见的「已保存」那行。
  assert.equal(await popup.locator('p.tsm-note').filter({ hasText: '已保存' }).count(), 0)
  assert.equal((await preferences.ensure('session-a')).factCheck, 'none')
  await page.keyboard.press('Escape')
  await popup.waitFor({ state: 'detached' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '教学设置')
  await page.keyboard.press('Space')
  await popup.waitFor()
  await popup.getByRole('button', { name: '当前教学集合', exact: true }).click()
  await page.locator('nav').click({ position: { x: 400, y: 5 } })
  await popup.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'session-b', exact: true }).click()
  await dock.getByRole('button', { name: '教学设置', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.tsm-teaching-popover input[type=range]')?.value === '2')
  assert.equal((await preferences.ensure('session-b')).factCheck, 'moderate')
  await page.getByRole('button', { name: 'session-a', exact: true }).click()
  const courses = page.locator('#courses')
  await courses.getByText('管理集合', { exact: true }).click()
  await courses.getByRole('button', { name: '集合操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '复制课程清单', exact: true }).click()
  await courses.getByRole('textbox', { name: '集合名称' }).fill('第二轮')
  await courses.getByRole('button', { name: '保存集合', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#courses .tsm-menu-select')?.textContent === '第二轮')
  console.log('collection copied')
  const selected = (await preferences.ensure('session-a')).collections[root]
  assert.notEqual(selected, 'default')
  await courses.getByRole('button', { name: /打开 浏览器合成课程/ }).click()
  console.log('classroom opened')
  let frame = page.frameLocator('iframe')
  const readingDirectory = path.join(root, '.dsh-teach-me/archive/reading')
  fs.mkdirSync(readingDirectory, { recursive: true }); fs.chmodSync(readingDirectory, 0o500)
  await frame.getByRole('heading', { name: '章节 1' }).click()
  await frame.locator('body').press('End')
  await page.waitForFunction(() => document.querySelector('#classroom [role=progressbar]')?.getAttribute('aria-valuenow') === '100')
  await page.waitForFunction(() => document.querySelector('#classroom [data-reading-retry="true"]')?.getAttribute('data-pending') === 'true')
  fs.chmodSync(readingDirectory, 0o700)
  await page.locator('#classroom').getByRole('button', { name: '重试保存', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#classroom [data-reading-retry="true"]')?.getAttribute('data-pending') === 'false')
  await page.waitForFunction(() => !document.querySelector('#classroom')?.textContent.includes('尚未保存'))
  console.log('read to end saved')
  const iframe = page.frames().find((f) => f !== page.mainFrame())
  await iframe.evaluate(() => scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * .4))
  await page.waitForTimeout(3300)
  console.log('read back saved')
  await courses.getByRole('button', { name: '当前教学集合', exact: true }).click()
  await page.getByRole('menuitem', { name: '默认集合', exact: true }).click()
  await frame.getByRole('textbox', { name: '答案' }).fill('a')
  await frame.getByRole('button', { name: '提交到课堂', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#classroom')?.textContent.includes('已提交'))
  assert.equal(Object.keys(openArchive(root).state.submissions).length, 0)
  assert.equal(withLearningScope({ collectionId: selected }, () => Object.keys(openArchive(root).state.submissions).length), 1)
  await page.waitForFunction(() => window.__flow.calls.filter((c) => c.endpoint === 'classroom/reading').at(-1)?.payload.position.ratio > .85)
  await page.waitForTimeout(150)
  await page.locator('#classroom').getByRole('button', { name: '重新加载课堂', exact: true }).click()
  await page.waitForTimeout(3500)
  console.log('reloaded')
  const resumed = page.frames().find((f) => f !== page.mainFrame())
  const ratio = await resumed.evaluate(() => scrollY / (document.documentElement.scrollHeight - innerHeight))
  // 正式作答把位置移到题目；重新加载必须恢复最后主动位置，历史最远仍为 100%。
  assert.ok(ratio > .85, 'resume position: ' + ratio)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await page.locator('.tsm-progress>span').first().evaluate((node) => getComputedStyle(node).transitionDuration), '0s')
  assert.deepEqual(errors, [])
  fs.mkdirSync('artifacts/host-ui/learning-flow', { recursive: true })
  await page.screenshot({ path: 'artifacts/host-ui/learning-flow/flow.png', fullPage: true })
  console.log('PASS: session isolation, collection copy/select, capability-bound reading/submission, max progress, save failure/retry, resume, reduced motion, no browser errors')
} catch (error) { console.error(errors); console.error((await page.locator('body').innerText()).slice(0, 2500)); console.error(JSON.stringify(await page.evaluate(() => window.__flow.calls)).slice(0, 3500)); throw error } finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve)); await preferences.close(); fs.rmSync(root, { recursive: true, force: true })
}
