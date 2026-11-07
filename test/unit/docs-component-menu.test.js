import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const readTemplate = (name) => fs.readFileSync(new URL('../../templates/' + name, import.meta.url), 'utf8')
const readPrompt = (name) => fs.readFileSync(new URL('../../prompt/' + name, import.meta.url), 'utf8')

const formats = readTemplate('FORMATS.md')
const components = readTemplate('COMPONENTS.md')

test('FORMATS 有「组件菜单」：4 列、五种组件、三条判据', () => {
  assert.match(formats, /## 组件菜单（先看表，再决定用不用）/)
  for (const column of ['表达', '什么时候值得用', '标记 / 资源', '细节']) assert.ok(formats.includes(column), `缺少列：${column}`)
  for (const component of ['flashcards', 'timeline', 'chart', 'controls']) {
    assert.ok(formats.includes(component), `组件菜单没覆盖：${component}`)
  }
  for (const criterion of ['改变他**做什么**', '数据来自本课已核验的材料', '只填数据']) {
    assert.ok(formats.includes(criterion), `缺少判据：${criterion}`)
  }
})

test('FORMATS 与 COMPONENTS 互链，分工写清（何时用 → FORMATS；怎么写 → COMPONENTS）', () => {
  assert.ok(formats.includes('[COMPONENTS.md](COMPONENTS.md)'), 'FORMATS 没有链到 COMPONENTS')
  assert.ok(components.includes('[FORMATS](FORMATS.md)'), 'COMPONENTS 没有链回 FORMATS')
  assert.ok(components.includes('组件菜单'), 'COMPONENTS 顶部没写「何时用见 FORMATS 菜单」')
})

test('组件菜单没有偷加 radio 示例：FORMATS 仍然恰好 3 个 value=a/b/c 的 radio', () => {
  const radios = [...formats.matchAll(/<input\b[^>]*type="radio"[^>]*>/g)]
  assert.equal(radios.length, 3, `FORMATS 里的 radio 数量变了：${radios.length}`)
  assert.deepEqual(radios.map(([tag]) => /value="([^"]+)"/.exec(tag)?.[1]), ['a', 'b', 'c'])
})

test('提示词跟着改：30-lesson 无条件读菜单、build 阶加一行，旧的「用了才读」分支消失', () => {
  const lesson = readPrompt('30-lesson.md')
  assert.ok(lesson.includes('组件菜单'), '30-lesson 没提组件菜单')
  assert.ok(lesson.includes('COMPONENTS.md'), '30-lesson 没给 COMPONENTS 入口')
  assert.equal(lesson.includes('需要闪卡、时间线或图表时只读'), false, '旧的条件分支还在')
  assert.ok(lesson.includes('真实先后与因果'), '30-lesson 缺「何时该用」的判据')

  const build = readPrompt('stages/build.md')
  assert.ok(build.includes('组件菜单'), 'build 阶清单没提组件菜单')
})

test('提示词与模板的 D3/D4/D5 口径不许回退', () => {
  const lesson = readPrompt('30-lesson.md')
  assert.ok(lesson.includes('新增类名只有一条合法顺序'), 'D3 的唯一顺序丢了')
  assert.equal(lesson.includes('缺什么就新增类名'), false, 'D3 的矛盾句还在')

  const animationPrompt = readPrompt('60-animation.md')
  assert.ok(animationPrompt.includes('工程既有件 > 规范默认值'), 'D4 的优先级说明丢了')
  assert.ok(animationPrompt.includes('「偏离」表'), 'D4 的偏离表要求丢了')
  assert.ok(animationPrompt.includes('poster: true'), '渲染封面的新参数丢了')
  assert.ok(animationPrompt.includes('-f<frame>.png'), '抽帧产物的命名说明丢了')
  assert.equal(animationPrompt.includes('套 `SceneFrame`，'), false, '「必须套 SceneFrame」的旧说法还在')

  const freedom = readPrompt('80-freedom.md')
  assert.ok(freedom.includes('改变他做什么'), 'D5 的组件判据丢了')

  const animationSpec = readTemplate('ANIMATION.md')
  assert.ok(animationSpec.includes('minBody: 28'), '字号口径没统一（minBody）')
  assert.ok(animationSpec.includes('装饰小字'), '字号口径没统一（装饰小字）')
  assert.equal(animationSpec.includes('任何字不小于 28'), false, '「任何字不小于 28」的自相矛盾还在')
  assert.ok(animationSpec.includes('为什么不改'), '偏离表缺第三列')
})

test('H1：启动顺序里写明 /permission auto 的风险', () => {
  const startup = readPrompt('10-startup.md')
  assert.ok(startup.includes('/permission auto'), '10-startup 没写 permission auto')
  assert.ok(startup.includes('workspace-write'), '10-startup 没给替代建议')
})
