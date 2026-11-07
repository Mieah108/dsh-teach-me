#!/usr/bin/env node
/** Isolated browser QA. Set TEACH_PLAYWRIGHT_MODULE when Playwright is supplied by a workspace runtime. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { parseHTML } from 'linkedom'
import { publishLesson, readArchiveState } from '../lib/archive/operations.js'
import { buildOffline } from '../lib/classroom/offline.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.TEACH_PLAYWRIGHT_MODULE || 'playwright')
const output = path.resolve(process.env.TEACH_QA_OUTPUT || path.join(root, 'artifacts/browser-qa'))
fs.mkdirSync(output, { recursive: true })
const gallery = path.join(root, 'templates/examples/lessons/components.html')
const source = fs.readFileSync(gallery, 'utf8')
const { document } = parseHTML(source)
const card = JSON.parse(document.querySelector('[data-teach-component="flashcards"] script').textContent).cards[0]
const results = []
const browser = await chromium.launch({ channel: process.env.TEACH_BROWSER_CHANNEL || 'msedge', headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
const errors = []
const remote = []
context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)))
await context.route(/^https?:/, (route) => { remote.push(route.request().url()); return route.abort() })
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__teachCopied = text } } })
})
const page = await context.newPage()
const check = (name, condition) => { assert.ok(condition, name); results.push(name) }
const flash = () => page.locator('[data-teach-component="flashcards"]')
const chart = () => page.locator('[data-teach-component="chart"]')
async function settled() {
  await page.waitForFunction(() => [...document.querySelectorAll('[data-teach-component]')].every((item) => item.dataset.teachMounted === 'true'))
  await page.waitForFunction(() => document.querySelector('[data-teach-copy-context]'))
}
async function copied(locator) {
  await locator.locator('[data-teach-copy-context]').click()
  return page.evaluate(() => window.__teachCopied)
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-components-browser-'))
try {
  await page.goto(pathToFileURL(gallery).href)
  await settled()
  check('独立 file:// 页面中的三个组件均已挂载', await page.locator('[data-teach-mounted="true"]').count() === 3)
  const initial = await copied(flash())
  check('未翻面快照包含问题而不包含未揭晓答案', initial.includes(card.front) && !initial.includes(card.back))
  await flash().getByRole('button', { name: '查看提示', exact: true }).click()
  check('提示由学习者主动显示并记录', await flash().getAttribute('data-teach-hints-used') === 'true')
  await flash().locator('.teach-flash-face').click()
  const after = await copied(flash())
  check('翻面后快照包含当前已显示答案与提示历史', after.includes(card.back) && after.includes('已使用提示') && after.includes('已看过解答'))
  await flash().getByRole('button', { name: '下一张', exact: true }).click()
  check('切卡后返回正面且上一张答案不再进入当前快照', !(await copied(flash())).includes(card.back))
  await flash().locator('.teach-flash-face').focus()
  await page.keyboard.press('Enter')
  check('闪卡支持键盘操作', await flash().getAttribute('data-teach-showed-solution') === 'true')

  const slider = chart().getByRole('slider')
  await slider.fill('30')
  check('调参同步更新可见读数', (await chart().locator('[data-teach-state]').textContent()).includes('方案 B 30'))
  await chart().getByRole('button', { name: '恢复初始参数', exact: true }).click()
  check('重置恢复原始参数和结果', await slider.inputValue() === '70' && (await chart().locator('[data-teach-state]').textContent()).includes('方案 B 70'))
  await chart().getByText('查看数据表', { exact: true }).click()
  check('图表具有可展开的原始数据表', await chart().locator('table').isVisible())

  const quiz = page.locator('.quiz')
  await quiz.getByRole('button', { name: '判卷', exact: true }).click()
  check('空作答没有揭晓答案', await quiz.getAttribute('data-teach-showed-solution') === null)
  await quiz.locator('input[value="b"]').check()
  await quiz.getByRole('button', { name: '判卷', exact: true }).click()
  check('既有自测保持可用且记录已看解析', (await quiz.locator('.verdict').textContent()).startsWith('对。') && await quiz.getAttribute('data-teach-showed-solution') === '1')
  const count = await page.locator('[data-teach-copy-context]').count()
  await page.evaluate(() => { document.dispatchEvent(new CustomEvent('teach:components-ready')); document.dispatchEvent(new CustomEvent('teach:components-ready')) })
  check('重复组件就绪事件不会叠加按钮', await page.locator('[data-teach-copy-context]').count() === count)

  await page.goto(pathToFileURL(gallery).href)
  await settled()
  await page.screenshot({ path: path.join(output, 'desktop-light.png'), fullPage: true })
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.waitForTimeout(150)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
    check(width + 'px 页面无横向溢出', !overflow)
  }
  await page.setViewportSize({ width: 390, height: 1000 })
  await page.screenshot({ path: path.join(output, 'mobile-light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.waitForTimeout(100)
  await page.screenshot({ path: path.join(output, 'mobile-dark.png'), fullPage: true })
  check('深色模式继承课堂背景与文字', await page.evaluate(() => getComputedStyle(document.body).backgroundColor !== 'rgb(251, 249, 244)'))
  await page.goto(pathToFileURL(path.join(root, 'templates/examples/lessons/reuse.html')).href)
  await settled()
  check('第二主题复用同一组产物', await page.locator('[data-teach-mounted="true"]').count() === 3)

  const typesPage = await context.newPage()
  await typesPage.setContent('<!doctype html><html><body></body></html>')
  await typesPage.addStyleTag({ content: fs.readFileSync(path.join(root, 'templates/course.css'), 'utf8') + fs.readFileSync(path.join(root, 'templates/components/teach-components.css'), 'utf8') })
  await typesPage.evaluate(() => {
    for (const type of ['column', 'bar', 'line', 'area', 'pie', 'ring', 'radar', 'scatter']) {
      const host = document.createElement('div')
      host.dataset.teachComponent = 'chart'
      const data = document.createElement('script')
      data.type = 'application/json'
      data.textContent = JSON.stringify({ title: type, type, data: { labels: ['甲', '乙'], legends: type === 'scatter' ? ['x', 'y'] : ['读数'], series: type === 'scatter' ? [[1, 2], [3, 4]] : [[4, 6]] } })
      host.append(data)
      document.body.append(host)
    }
  })
  await typesPage.addScriptTag({ path: path.join(root, 'templates/components/teach-charts.js') })
  check('声明支持的八种图表均实际生成SVG', await typesPage.locator('[data-teach-mounted="true"] svg').count() === 8)
  await typesPage.evaluate(() => {
    const host = document.createElement('div')
    host.id = 'pie-zero'
    host.dataset.teachComponent = 'chart'
    const data = document.createElement('script')
    data.type = 'application/json'
    data.textContent = JSON.stringify({ title: '可恢复的零占比', type: 'pie', data: { labels: ['当前项'], legends: ['数量'], series: [[1]] }, controls: [{ label: '当前项数量', min: 0, max: 4, step: 1, value: 1 }] })
    host.append(data)
    document.body.append(host)
    window.teachCharts.mount()
  })
  const zero = typesPage.locator('#pie-zero')
  await zero.getByRole('slider').fill('0')
  check('全零占比显示空状态而非虚假等份', !(await zero.locator('.teach-chart-plot').isVisible()) && (await zero.textContent()).includes('全为零'))
  await zero.getByRole('slider').fill('1')
  check('占比恢复正数后可重新显示', await zero.locator('.teach-chart-plot').isVisible() && await zero.locator('svg').count() === 1)
  await typesPage.close()

  // Publish/export in an isolated scratch workspace; never touch a learner's archive.
  fs.cpSync(path.join(root, 'templates'), path.join(scratch, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(scratch, 'lessons'))
  fs.writeFileSync(path.join(scratch, 'lessons/components.html'), source.replaceAll('../../', '../assets/').replaceAll('href="reuse.html"', 'href="#recall"'))
  publishLesson(scratch, { lessonId: 'qa-components', path: 'lessons/components.html', title: '独立导出验证' })
  const state = readArchiveState(scratch)
  const offline = buildOffline(scratch, state, state.lessons['qa-components'])
  const offlinePath = path.join(scratch, 'offline.html')
  fs.writeFileSync(offlinePath, offline.html)
  // Remove all original runtime resources; successful mounting now proves inline closure.
  fs.rmSync(path.join(scratch, 'assets'), { recursive: true })
  fs.rmSync(path.join(scratch, 'lessons'), { recursive: true })
  await page.goto(pathToFileURL(offlinePath).href)
  await settled()
  check('单文件导出在原资源移除后仍能运行三类组件', await page.locator('[data-teach-mounted="true"]').count() === 3)
  await flash().locator('.teach-flash-face').click()
  check('离线文件保留翻卡操作', (await flash().locator('[data-teach-state]').textContent()).includes(card.back))
  check('无外部网络依赖', remote.length === 0)
  check('浏览器无脚本错误', errors.length === 0)
  const report = { browser: await browser.version(), build: JSON.parse(fs.readFileSync(path.join(root, 'templates/components/build-info.json'), 'utf8')), checks: results, errors, remoteRequests: remote, scope: 'isolated standalone HTML and scratch archive export; not a logged-in DSH installation' }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
} finally {
  await browser.close()
  fs.rmSync(scratch, { recursive: true, force: true })
}
