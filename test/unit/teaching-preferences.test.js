import test from 'node:test'
import assert from 'node:assert/strict'
import { createTeachingPreferences } from '../../lib/teaching-preferences.js'
import { registerTeachingRuntime } from '../../lib/teaching-runtime.js'
import { learningScope } from '../../lib/archive/learning-scope.js'
import { publishLesson } from '../../lib/archive/operations.js'
import { openArchive } from '../../lib/archive/store.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
function memoryDomain() {
  const records = new Map()
  let fail = false
  return { setFail: (value) => { fail = value }, open: async () => ({ table: () => ({ get: (key) => records.get(key), put: async (key, value) => { if (fail) throw new Error('disk full'); records.set(key, structuredClone(value)) } }), close: async () => {} }) }
}
test('会话默认快照、独立覆盖、保存失败回滚和并行字段写入', async () => {
  let config = { teaching: { depth: 'shallow' } }
  const domain = memoryDomain()
  const service = createTeachingPreferences(() => domain, () => config)
  assert.equal((await service.ensure('a')).depth, 'shallow')
  config = { teaching: { factCheck: 'strict', depth: 'deep' } }
  assert.equal((await service.ensure('a')).depth, 'shallow')
  assert.equal((await service.ensure('b')).factCheck, 'strict')
  await Promise.all([service.update('a', { factCheck: 'none' }, '/workspace'), service.update('a', { depth: 'deep', collectionId: 'other' }, '/workspace')])
  assert.deepEqual((await service.ensure('a')).collections, { '/workspace': 'other' })
  assert.equal((await service.ensure('a')).factCheck, 'none')
  domain.setFail(true)
  await assert.rejects(service.update('a', { depth: 'moderate' }, '/workspace'), /disk full/)
  assert.equal((await service.ensure('a')).depth, 'deep')
  assert.equal((await service.ensure('b')).depth, 'deep')
})
test('请求设置与工具实际执行绑定，途中修改仅下一轮使用', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-request-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let prefs = { factCheck: 'moderate', depth: 'moderate', collections: {} }
  const events = new Map(), registered = new Map()
  const sections = []
  const services = {
    teachPreferences: { ensure: async () => structuredClone(prefs) },
    tools: { register: (definition) => { registered.set(definition.name, definition) }, guard() {} },
    systemPrompt: { section: (section) => sections.push(section) }
  }
  const ctx = { get: (key) => services[key],
    on: (name, handler) => events.set(name, handler), effect: (factory) => factory() }
  const runtime = registerTeachingRuntime(ctx, () => root)
  const agent = { id: 'a', session: { id: 'a' } }
  const renderPreferences = async (context) => {
    const assembly = { sections: sections.map((section) => ({
      ...section, text: typeof section.text === 'function' ? section.text(context) : section.text
    })) }
    const assemble = events.get('system-prompt/assemble')
    const result = assemble ? await assemble(assembly, context, async () => assembly) : assembly
    const text = result.sections.find((section) => section.name === 'teach:request-preferences').text
    assert.equal(typeof text, 'string')
    return text
  }
  events.get('agent/inbox/claimed')({ agent, turn: 1 })
  assert.match(await renderPreferences({ agent }), /讲解深度：适中/)
  const first = await runtime.requestOf(agent)
  prefs.depth = 'deep'; prefs.factCheck = 'none'
  runtime.scopedContext.get('tools').register({ name: 'probe', execute: () => learningScope().depth })
  assert.equal(await registered.get('probe').execute({}, { agent }), 'moderate')
  assert.equal(first.factCheck, 'moderate')
  assert.match(await renderPreferences({ agent }), /讲解深度：适中/)
  events.get('agent/inbox/claimed')({ agent, turn: 2 })
  assert.match(await renderPreferences({ agent }), /讲解深度：深入/)
  assert.equal((await runtime.requestOf(agent)).depth, 'deep')
  assert.equal((await runtime.requestOf(agent)).factCheck, 'none')
  assert.equal(await renderPreferences({}), '')
  services.teachPreferences = undefined
  events.get('agent/inbox/claimed')({ agent, turn: 3 })
  assert.match(await renderPreferences({ agent }), /教学请求尚未就绪：宿主教学设置服务未就绪/)
})

test('正式提交经过宿主闸门后才迁移档案，演练全程只读', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teach-commit-migration-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lessons'))
  fs.writeFileSync(path.join(root, 'lessons', 'legacy.html'), '<html>旧课</html>')
  publishLesson(root, { lessonId: 'legacy', path: 'lessons/legacy.html', title: '旧课' })
  const state = () => openArchive(root, { repairIndex: false }).globalState
  const legacy = state()
  assert.notEqual(legacy.collectionFormat, 1)

  const events = new Map()
  let commit
  const services = {
    teachPreferences: { ensure: async () => ({ collections: {} }) },
    tools: { register: (definition) => { commit = definition } }
  }
  const runtime = registerTeachingRuntime({ get: (name) => services[name], on: (name, handler) => events.set(name, handler) }, () => root)
  runtime.scopedContext.get('tools').register({ name: 'teach_commit', execute: () => state().collectionFormat })
  const execution = { name: 'teach_commit', agent: { id: 'session-1' } }
  const preExecute = events.get('tools/pre-execute')

  // 宿主在 pre-execute 之后运行候答闸门。被拦时不会执行工具本体。
  await preExecute(execution, () => undefined)
  assert.equal(state().revision, legacy.revision)
  assert.equal(await commit.execute({ dryRun: true }, execution), legacy.collectionFormat)
  assert.equal(state().revision, legacy.revision)
  assert.equal(await commit.execute({}, execution), 1)
})
