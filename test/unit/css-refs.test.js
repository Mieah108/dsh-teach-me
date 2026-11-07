import assert from 'node:assert/strict'
import test from 'node:test'
import { cssRefsOf, inlineCssDataUris, inlineStyleBlocks, isLocalRef } from '../../lib/archive/css-refs.js'

test('cssRefsOf 抽 url()/@import 的本地引用，跳过外部/数据/锚点', () => {
  const css = [
    'body { background: url("../img/bg.svg"); }',
    "@import 'theme.css';",
    '@import url("fonts/body.css");',
    'a { background: url(data:image/png;base64,AA); }',
    'b { background: url(https://example.com/x.png); }',
    'c { background: url(//cdn/x.png); }',
    'd { background: url(#gradient); }'
  ].join('\n')
  assert.deepEqual(cssRefsOf(css), ['../img/bg.svg', 'theme.css', 'fonts/body.css'])
})

test('cssRefsOf 去重且保持出现顺序；空输入返回空数组', () => {
  assert.deepEqual(cssRefsOf('a{background:url(x.png)} b{background:url(x.png)}'), ['x.png'])
  assert.deepEqual(cssRefsOf(''), [])
  assert.deepEqual(cssRefsOf(undefined), [])
})

test('inlineCssDataUris 只替换本地引用，解析不了的原样保留', () => {
  const css = 'a{background:url(bg.svg)} @import "theme.css"; b{background:url(http://e/x.png)}'
  const out = inlineCssDataUris(css, (raw) => (raw === 'theme.css' ? null : 'data:image/svg+xml;base64,QQ=='))
  assert.match(out, /url\("data:image\/svg\+xml;base64,QQ=="\)/)
  assert.match(out, /@import "theme.css"/)
  assert.match(out, /url\(http:\/\/e\/x\.png\)/)
})

test('inlineStyleBlocks 只改 <style> 块内部，不动属性与其它标签', () => {
  const html = '<link href="course.css"><style data-x="1">p{background:url(a.png)}</style><script>url(b.png)</script>'
  const out = inlineStyleBlocks(html, () => 'DATA')
  assert.match(out, /<style data-x="1">p\{background:url\("DATA"\)\}<\/style>/)
  assert.match(out, /<link href="course.css">/)
  assert.match(out, /<script>url\(b\.png\)<\/script>/)
})

test('isLocalRef 认得出本地与远程', () => {
  assert.equal(isLocalRef('a/b.png'), true)
  assert.equal(isLocalRef('./a.png'), true)
  assert.equal(isLocalRef('data:text/css,'), false)
  assert.equal(isLocalRef('https://e/x'), false)
  assert.equal(isLocalRef('//e/x'), false)
  assert.equal(isLocalRef('#x'), false)
  assert.equal(isLocalRef('  '), false)
})
