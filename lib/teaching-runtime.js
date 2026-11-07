import fs from 'node:fs'
import { withLearningScope } from './archive/learning-scope.js'
import { tryOpenArchive } from './archive/store.js'
import { collectionList } from './archive/collections.js'

export function teachingPolicy(snapshot) {
  const counts = { none: '0', loose: '1', moderate: '1–2', strict: '3–4' }
  const levels = { none: '不核查', loose: '宽松', moderate: '适中', strict: '严格' }
  const depths = { shallow: '浅显：直觉、必要术语和最小例子。', moderate: '适中：核心原理、必要公式、常见错误。', deep: '深入：推导、边界、反例、取舍。' }
  return `本次教学请求（已固定；会话设置修改只影响下一次请求）：\n集合：${snapshot.collectionId}；教学根：${snapshot.root}\n事实核查：${levels[snapshot.factCheck]}，课程生成派遣 ${counts[snapshot.factCheck]} 个不同核查子代理（替补也计入上限）。${snapshot.factCheck === 'none' ? '不派事实核查/材料盲审子代理；仍须作者自检、来源检查及页面 lint。' : '仅新课或实质重写课程生成默认派遣；普通答疑不自动派遣，除非学习者明确要求。宽松检查所给材料一致性，适中增加独立一手证据，严格增加推导、反例与冲突检查。核查者只接收课程与必要材料，不带作者完整对话。'}\n讲解深度：${depths[snapshot.depth]}不自动扩大教学范围，也不提高核查档位。\n复查按需且保守，同次生成最多自动一轮针对性复查。多代理互相复查对方的问题或修正，只有一个代理时才允许自查。不做全量两两互审，不新派整批代理，不自动递归。仍有争议标为待核。已知错误先修正或删除；核查失败或不足明确记为未完成，不伪装成功。发布时用 teach_fact_check_record 记录该内容版本实际参与者、来源、问题、修正及复查情况（未做不填）。\n已归档集合可阅读和记录既有工作；新生成需恢复集合。`
}

export function registerTeachingRuntime(ctx, workspaceOf) {
  const requests = new Map()
  const executions = new Map()
  const getService = () => ctx.get?.('teachPreferences')
  const capture = (agent, turn) => {
    const id = agent?.session?.id ?? agent?.id
    if (!id) throw new Error('无法固定教学请求：缺少会话身份')
    const prior = requests.get(id)
    if (prior && (turn === undefined || prior.turn === turn)) return prior.value
    const root = fs.realpathSync.native(workspaceOf(agent))
    const value = Promise.resolve().then(async () => {
      const service = getService()
      if (!service) throw new Error('宿主教学设置服务未就绪，请检查全局教学模式行及 storage.domain')
      const prefs = await service.ensure(id)
      const collectionId = prefs.collections[root] ?? 'default'
      const archive = withLearningScope({}, () => tryOpenArchive(root, { repairIndex: false }))
      if (!collectionList(archive?.globalState).some((c) => c.id === collectionId)) throw new Error('当前教学集合不存在，请重新选择')
      const archived = collectionList(archive?.globalState).find((c) => c.id === collectionId)?.archived === true
      return Object.freeze({ enabled: true, ...prefs, collectionId, root, requestId: id + ':' + (turn ?? Date.now()), allowGeneration: !archived })
    })
    requests.set(id, { turn, value })
    return value
  }
  ctx.on?.('agent/created', async ({ agent }) => { await getService()?.ensure(agent.session?.id ?? agent.id) })
  ctx.on?.('agent/inbox/claimed', ({ agent, turn }) => { try { capture(agent, turn).catch(() => {}) } catch (error) { ctx.logger?.warn?.('teach-me: 请求尚未固定：' + error.message) } })
  ctx.on?.('agent/status', ({ agent, status }) => { if (status === 'idle') requests.delete(agent.session?.id ?? agent.id) })
  ctx.on?.('agent/disposed', ({ agent }) => { requests.delete(agent.session?.id ?? agent.id) })
  ctx.on?.('tools/pre-execute', async (execution, next) => {
    if (!execution.agent?.id) return next()
    let scope
    try { scope = await capture(execution.agent) } catch { return next() }
    executions.set(execution.token ?? execution.callId, scope)
    if (executions.size > 4096) executions.delete(executions.keys().next().value)
    // 初始化/快照只在明确写动作前执行；读取不迁移。
    if (/^(?:write|edit|apply_patch|teach_lesson_publish|teach_question_register)/.test(execution.call?.name ?? execution.tool?.name ?? execution.name ?? '')) {
      withLearningScope({}, () => tryOpenArchive(scope.root, { repairIndex: false })?.initializeLearning())
    }
    return withLearningScope(scope, () => next())
  })
  const prompt = ctx.get?.('systemPrompt')
  if (prompt?.section) {
    const name = 'teach:request-preferences'
    ctx.effect(() => prompt.section({ name, order: 90, text: '', interpolate: false }), 'teach-me: request preferences')
    // section.text 只接受同步文本；在宿主会等待的组装钩子里读取本轮快照。
    ctx.on?.('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      const agent = context?.agent ?? context?.scope
      const section = assembly.sections.find((entry) => entry.name === name)
      if (!section || !agent?.id) return assembly
      try {
        section.text = teachingPolicy(await capture(agent))
      } catch (error) {
        section.text = '教学请求尚未就绪：' + error.message + '。修复设置服务前不要生成或登记课程。'
      }
      return assembly
    })
  }
  const tools = ctx.get?.('tools')
  const scopedTools = tools && new Proxy(tools, { get(target, key) {
    if (key === 'guard') return (guard) => target.guard((execution) => { const scope = executions.get(execution.token ?? execution.callId); return scope ? withLearningScope(scope, () => guard(execution)) : guard(execution) })
    if (key !== 'register') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value }
    return (definition) => /^teach_animation_/.test(definition.name) ? target.register(definition) : target.register({ ...definition, async execute(args, exec) {
      let scope
      try { scope = await capture(exec?.agent) } catch (error) {
        if (['teach_status', 'teach_report'].includes(definition.name) || (['teach_workspace', 'teach_stage'].includes(definition.name) && ['status', 'show', undefined].includes(args?.action))) {
          const result = await definition.execute(args, exec)
          return { ...result, text: result.text + '\n教学偏好不可用：' + error.message }
        }
        throw error
      }
      if (!scope.allowGeneration && ['teach_commit', 'teach_lesson_publish', 'teach_question_register'].includes(definition.name)) return { ok: false, text: '当前教学集合已归档，请先恢复再生成课程。', error: 'collection-archived' }
      // 宿主在 pre-execute 后才跑闸门。正式提交放行后才能迁移档案，演练不写入。
      if (definition.name === 'teach_commit' && args?.dryRun !== true) {
        withLearningScope({}, () => tryOpenArchive(scope.root, { repairIndex: false })?.initializeLearning())
      }
      return withLearningScope(scope, () => definition.execute(args, exec))
    } })
  } })
  const scopedContext = new Proxy(ctx, { get(target, key) {
    if (key === 'on') return (event, callback) => target.on?.(event, event === 'tools/result' ? (execution, result) => { const scope = executions.get(execution.token ?? execution.callId); return scope ? withLearningScope(scope, () => callback(execution, result)) : callback(execution, result) } : callback)
    if (key === 'get') return (name) => name === 'tools' ? scopedTools : target.get(name)
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { requestOf: capture, scopedContext }
}
