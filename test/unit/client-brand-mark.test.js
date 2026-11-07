import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/* 品牌标记（client.js 的 TeachMark）与 assets/brand/icon-line.svg 是同一份几何的
 * 两个副本：客户端半是手写的单文件模块、没有构建步骤，只能把路径数据内嵌一份。
 * 这里把「两处必须同步」钉成断言——只改一边，测试就红。
 *
 * 顺带钉住两条渲染约束：
 * 1) mask id 必须去掉 React useId 的冒号，否则 url(#...) 引不到；
 * 2) 线宽按 weight 放大，16–24px 下 22 的基准只剩零点几像素。 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function fakeReact() {
  const noop = () => undefined
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: noop,
    useId: () => ':r0:'
  }
}

let clientExports
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      clientExports = entry.factory((name) => {
        assert.equal(name, 'react')
        return fakeReact()
      })
    }
  }
}

async function loadClient() {
  if (clientExports === undefined) await import('../../client.js')
  return clientExports
}

/** 把 createElement 树摊平，收集带 `d` 的路径与全部节点。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

test('品牌标记与 assets/brand/icon-line.svg 共用同一份路径数据', async () => {
  const { brandMark } = await loadClient()
  const tree = brandMark({ size: 20, weight: 1.7 })
  const rendered = []
  walk(tree, (node) => {
    if (node.props && typeof node.props.d === 'string') rendered.push(node.props.d)
  })
  const asset = fs.readFileSync(path.join(root, 'assets/brand/icon-line.svg'), 'utf8')
  const expected = [...asset.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1])
  assert.ok(expected.length >= 4, '资产里的路径太少：' + expected.length)
  for (const d of expected) assert.ok(rendered.includes(d), '标记里缺少路径：' + d)
})

test('mask id 去掉冒号，遮罩被正确引用', async () => {
  const { brandMark } = await loadClient()
  const tree = brandMark({ size: 16 })
  let maskId = null
  let referenced = null
  walk(tree, (node) => {
    if (node.type === 'mask') maskId = node.props.id
    if (node.props && typeof node.props.mask === 'string') referenced = node.props.mask
  })
  assert.equal(maskId, 'teach-mark-r0')
  assert.equal(referenced, 'url(#teach-mark-r0)')
})

test('线宽随 weight 放大，小尺寸下不会掉成发丝', async () => {
  const { brandMark } = await loadClient()
  const widths = []
  walk(brandMark({ size: 16, weight: 1.9 }), (node) => {
    if (typeof node.props?.strokeWidth === 'number') widths.push(node.props.strokeWidth)
  })
  // 基准 22 / 18 / 14（遮罩 16）乘以 1.9；浮点先收三位再比。
  const round = (value) => Number(value.toFixed(3))
  assert.deepEqual([...new Set(widths)].map(round).sort((a, b) => a - b), [
    round(14 * 1.9),
    round(16 * 1.9),
    round(18 * 1.9),
    round(22 * 1.9)
  ])
  // 16px 显示时最细的一笔仍有 ≈1.4px
  assert.ok((14 * 1.9 * 16) / 512 > 0.8)
})
