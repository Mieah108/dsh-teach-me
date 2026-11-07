#!/usr/bin/env node
/** Reuses OpenMAIC's standalone IIFE approach; no build or network is needed while reading a lesson. */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const outputDir = path.join(root, 'templates/components')
const check = process.argv.includes('--check')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const sources = JSON.parse(fs.readFileSync(path.join(root, 'ui/upstream/SOURCES.json'), 'utf8'))
for (const item of sources.assets) {
  if (hash(fs.readFileSync(path.join(root, item.local))) !== item.sha256) throw new Error('上游原件变化，请先核实来源：' + item.local)
}

async function bundle(entry) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false,
    format: 'iife', platform: 'browser', target: ['es2020'], minify: true,
    jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    legalComments: 'eof', logLevel: 'warning', charset: 'utf8'
  })
  return result.outputFiles[0].text
}

const outputs = {
  'teach-components.js': await bundle('ui/components.tsx'),
  'teach-charts.js': await bundle('ui/charts.ts'),
  'teach-components.css': fs.readFileSync(path.join(root, 'ui/components.css'), 'utf8'),
  'UPSTREAM.json': JSON.stringify({
    sources: sources.assets,
    adaptations: [
      { source: 'deeptutor/FlashCardsBlock.tsx', output: 'teach-components.js', changes: '保留翻面与导航状态；替换应用专属i18n/图标/样式；提示改为主动揭晓；暴露当前可见状态。' },
      { source: 'deeptutor/TimelineBlock.tsx', output: 'teach-components.js', changes: '保留事件顺序与可选日期/描述结构；适配现有course.css主题与窄屏。' },
      { source: 'openmaic/chartOption.ts', output: 'teach-charts.js', changes: '原件不改；仅剥离TypeScript类型后构建，外层补本地数据验证、控件、主题与销毁。' },
      { source: 'openmaic/build-standalone-player.mjs', output: 'build-components.mjs', changes: '复用预构建IIFE和图表独立包方式，移除整套播放器、Tailwind和KaTeX，仅保留选中资产。' }
    ]
  }, null, 2) + '\n'
}

const licenses = [
  ['DeepTutor', 'ui/upstream/deeptutor/LICENSE'], ['OpenMAIC', 'ui/upstream/openmaic/LICENSE']
].map(([name, file]) => name + '\n' + fs.readFileSync(path.join(root, file), 'utf8'))
// esbuild also preserves library license comments in each JS bundle.
for (const name of ['react', 'react-dom', 'scheduler', 'echarts', 'zrender', 'tslib']) {
  const parent = name === 'scheduler' ? 'react-dom' : ['zrender', 'tslib'].includes(name) ? 'echarts' : null
  const resolver = parent ? createRequire(require.resolve(parent + '/package.json')) : require
  let dir
  try { dir = path.dirname(resolver.resolve(name + '/package.json')) }
  catch {
    dir = path.dirname(resolver.resolve(name))
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
      const parent = path.dirname(dir)
      if (parent === dir) throw new Error('无法定位依赖许可：' + name)
      dir = parent
    }
  }
  const license = fs.readdirSync(dir).find((file) => /^LICENSE(?:\.|$)/i.test(file))
  if (!license) throw new Error('缺少依赖许可：' + name)
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  licenses.push(name + '@' + pkg.version + '\n' + fs.readFileSync(path.join(dir, license), 'utf8'))
  if (fs.existsSync(path.join(dir, 'NOTICE'))) licenses.push(name + ' NOTICE\n' + fs.readFileSync(path.join(dir, 'NOTICE'), 'utf8'))
}
outputs['THIRD_PARTY_NOTICES.txt'] = licenses.join('\n\n' + '='.repeat(72) + '\n\n') + '\n'

// Normalize generated copies only; fixed upstream originals and their hashes stay untouched.
for (const name of Object.keys(outputs)) outputs[name] = outputs[name].replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '')

const sizes = Object.fromEntries(Object.entries(outputs).filter(([name]) => /\.(?:js|css)$/.test(name)).map(([name, value]) => [name, { bytes: Buffer.byteLength(value), gzipBytes: gzipSync(value).length, sha256: hash(value) }]))
outputs['build-info.json'] = JSON.stringify({ target: 'browser ES2020; local IIFE, no runtime imports', files: sizes }, null, 2) + '\n'
if (!check) fs.mkdirSync(outputDir, { recursive: true })
for (const [name, value] of Object.entries(outputs)) {
  const target = path.join(outputDir, name)
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== value) throw new Error('组件构建产物过期：' + name + '；请运行 pnpm build:components')
  } else fs.writeFileSync(target, value)
}
console.log(check ? '✓ 组件原件与构建产物一致' : '✓ 本地组件已构建')
for (const [name, size] of Object.entries(sizes)) console.log(name + ': ' + size.bytes + ' B / gzip ' + size.gzipBytes + ' B')
