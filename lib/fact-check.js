/* 核查编排通过宿主官方 subagent 工具执行；计划与实际启动分开记录，不把计划当完成。 */
import path from 'node:path'
import { z } from 'zod'
import { openArchive } from './archive/store.js'
import { learningScope } from './archive/learning-scope.js'
import { assertId } from './archive/state.js'
import { hashJson, randomId } from './archive/util.js'
import { ValidationError } from './archive/errors.js'

export const FACT_CHECK_BUDGET = { none: [0, 0], loose: [1, 1], moderate: [1, 2], strict: [3, 4] }
export function reviewerCount(level, complex = false) {
  const range = FACT_CHECK_BUDGET[level]
  if (!range) throw new ValidationError('未知事实核查等级')
  return range[complex ? 1 : 0]
}
const finding = z.object({ claim: z.string().min(1).max(3000), kind: z.enum(['error', 'uncertain']), resolution: z.enum(['fixed', 'removed', 'pending']), note: z.string().max(4000) })
export const reportSchema = z.object({
  runId: z.string().min(1), summary: z.string().min(1).max(2000),
  participants: z.array(z.object({ agentId: z.string().min(1), status: z.enum(['complete', 'failed']), sources: z.array(z.string().min(1).max(3000)).max(40), findings: z.array(finding).max(80) })).max(4),
  followup: z.array(z.object({ reviewerId: z.string().min(1), targetId: z.string().min(1), issue: z.string().min(1).max(3000), result: z.string().min(1).max(3000) })).max(12).default([]),
  pending: z.array(z.string().min(1).max(3000)).max(80).default([])
})
export function validateFactReport(run, input) {
  const report = reportSchema.parse(input)
  const ids = report.participants.map((p) => p.agentId)
  if (new Set(ids).size !== ids.length || ids.length > FACT_CHECK_BUDGET[run.level][1]) throw new ValidationError('核查者必须不同且不能超过档位上限（替补也计入）')
  for (const follow of report.followup) {
    if (!ids.includes(follow.reviewerId) || !ids.includes(follow.targetId)) throw new ValidationError('复查必须在已有核查者之间进行')
    if (ids.length > 1 && follow.reviewerId === follow.targetId) throw new ValidationError('多个核查者必须交叉复查，不能自查')
  }
  if (report.participants.some((p) => p.findings.some((f) => f.kind === 'error' && f.resolution === 'pending'))) throw new ValidationError('已知错误须修正或删除后交付')
  const observed = new Set(run.started ?? [])
  const traceable = ids.every((id) => observed.has(id))
  const complete = run.level === 'none' || (traceable && ids.length >= run.count && report.participants.every((p) => p.status === 'complete') && report.pending.length === 0 && report.participants.every((p) => p.sources.length > 0 && p.findings.every((f) => f.resolution !== 'pending')))
  return { ...report, level: run.level, count: run.count, started: run.started ?? [], status: complete ? (run.level === 'none' ? 'disabled' : 'complete') : 'incomplete', traceable }
}

export function registerFactCheckTools(ctx, workspaceOf) {
  const tools = ctx.get?.('tools')
  if (!tools?.register) return
  const output = { schema: { type: 'object', additionalProperties: true, required: ['ok', 'text'], properties: { ok: { type: 'boolean' }, text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value.text }] }
  ctx.effect(() => tools.register({
    name: 'teach_fact_check_plan',
    description: 'Plan fact-check delegation for a generated lesson at the frozen session tier (0 / 1 / 1-2 / 3-4). Returns exact official subagent calls with blind, role-separated prompts. Dispatch those calls once, await actual results, fix errors, then teach_fact_check_record. Ordinary Q&A does not use this tool unless explicitly requested. A plan is not a completed check.',
    parameters: { type: 'object', additionalProperties: false, required: ['lessonId'], properties: { lessonId: { type: 'string' }, complex: { type: 'boolean', description: 'Use the upper adaptive count only when derivation, evidence or conflicts require a distinct additional role.' } } }, output,
    execute(args, exec) {
      try {
        const scope = learningScope()
        const root = workspaceOf(exec?.agent)
        const archive = openArchive(root, { create: false })
        archive.initializeLearning()
        const lessonId = assertId(args.lessonId, 'lessonId')
        const lesson = archive.state.lessons[lessonId]
        if (!lesson) throw new ValidationError('先发布课程及题目，再对固定内容版本核查；发现错误后修订并关联原核查任务')
        const level = scope.factCheck ?? 'moderate'
        const count = reviewerCount(level, args.complex === true)
        const previous = Object.values(archive.state.factCheckRuns ?? {}).find((run) => run.lessonId === lessonId && run.requestId === scope.requestId && scope.requestId)
        if (previous) return { ok: true, text: `本次生成已有核查计划 ${previous.runId}，不要重复派遣；修订后仍使用该 runId 记录。`, runId: previous.runId, level, count: previous.count, dispatch: [] }
        const runId = randomId('check')
        const sourceRoot = path.resolve(root, lesson.artifactRoot ?? '.')
        const materials = Object.values(archive.state.materials).filter((m) => Object.values(archive.state.questions).some((q) => q.lessonId === lessonId && q.materials.includes(m.id)))
        const roles = level === 'loose' ? ['核对课程与给定材料的一致性；不要用猜测补证据。'] : ['核对所引材料与事实，并查阅独立一手来源；指出无法验证的断言。', '检查推导、数值、前提、边界与反例；用可重复计算或一手资料交叉验证。', '独立核对证据、时效性与相互矛盾的来源，指出证据冲突。', '检查易错概念、反例与适用范围，聚焦其他角色未覆盖的关键断言。']
        const dispatch = Array.from({ length: count }, (_, index) => ({ name: 'subagent', arguments: { description: '教学事实核查 ' + (index + 1), prompt: `[teach-fact-check:${runId}:${index}]\n你是独立核查者。只读，不修改课程，不派子代理。${roles[index % roles.length]}\n只报告查到的证据（标题/链接/定位）、问题及不确定项；不给掌握结论。\n课程内容版本：${lesson.contentVersion}\n材料索引：${JSON.stringify(materials)}\n课程文件（只读，读取完整内容及必要引用资源）：${path.join(sourceRoot, lesson.path)}\n从这份固定快照开始核查，不读取作者的会话或学习档案。` } }))
        archive.transact('teach_fact_check_plan', undefined, () => ({ changes: [{ type: 'fact-check.planned', data: { runId, requestId: scope.requestId, lessonId, contentVersion: lesson.contentVersion, level, count, dispatchHashes: dispatch.map((d) => hashJson(d.arguments.prompt)), started: [] } }], result: {} }))
        return { ok: true, text: count ? `核查计划 ${runId}：依次派遣 dispatch 中的 ${count} 个官方 subagent 调用。等待真实结果，修正后记录；不要把计划当成已核查。` : '本次不核查，不派核查子代理；仍需作者自检与页面 lint。', runId, level, count, dispatch }
      } catch (error) { return { ok: false, text: error.message } }
    }
  }), 'teach-me: fact-check plan')
  ctx.effect(() => tools.register({
    name: 'teach_fact_check_record', description: 'Record actual fact-check evidence for a planned generation. Known errors must be fixed/removed. Multiple agents cross-check only when needed; one optional targeted follow-up round, no all-to-all. Unobserved/failed/missing reviewers remain incomplete. Bind corrected content to the original generation run; old version evidence is retained.',
    parameters: z.toJSONSchema(reportSchema), output,
    execute(input, exec) {
      try {
        const root = workspaceOf(exec?.agent)
        const archive = openArchive(root, { create: false })
        const run = archive.state.factCheckRuns?.[input.runId]
        if (!run) throw new ValidationError('没有这个核查计划')
        const report = validateFactReport(run, input)
        const version = archive.state.lessons[run.lessonId]?.contentVersion
        const result = archive.transact('teach_fact_check_record', undefined, (draft) => {
          const current = draft.factCheckRuns?.[input.runId]
          if (current.report) throw new ValidationError('该次生成已记录核查结果；再次显式核查请创建新任务，不自动多轮复查')
          return { changes: [{ type: 'fact-check.recorded', data: { ...report, lessonId: run.lessonId, contentVersion: version, originalVersion: run.contentVersion } }], result: {} }
        })
        return { ok: true, text: `核查 ${report.status === 'complete' ? '已完成' : report.status === 'disabled' ? '已关闭' : '未完成'}：${report.summary}`, ...result, status: report.status }
      } catch (error) { return { ok: false, text: error.message } }
    }
  }), 'teach-me: fact-check record')
  if (tools.guard) ctx.effect(() => tools.guard((execution) => {
    if (execution.name !== 'subagent' || typeof execution.arguments?.prompt !== 'string') return
    const marker = /^\[teach-fact-check:([^:]+):(\d+)\]/.exec(execution.arguments.prompt)
    if (!marker) return
    try {
      const archive = openArchive(workspaceOf(execution.agent), { create: false })
      const run = archive.state.factCheckRuns?.[marker[1]]
      const slot = Number(marker[2])
      if (!run || slot >= run.count || run.dispatchHashes[slot] !== hashJson(execution.arguments.prompt)) return '核查派遣不匹配已固定计划，请使用原 dispatch。'
      if (run.reserved?.includes(slot)) return '该核查任务已尝试派遣，不自动重复或增加代理；失败应明确记为未完成。'
      archive.transact('teach_fact_check_reserve', undefined, () => ({ changes: [{ type: 'fact-check.reserved', data: { runId: marker[1], slot } }], result: {} }))
    } catch (error) { return '核查派遣未开始：' + error.message }
  }), 'teach-me: fact-check budget guard')
  ctx.on?.('tools/result', (execution, result) => {
    if (execution.name !== 'subagent' || typeof execution.arguments?.prompt !== 'string') return
    const marker = /^\[teach-fact-check:([^:]+):(\d+)\]/.exec(execution.arguments.prompt)
    if (!marker) return
    const value = result?.value
    if (!value?.subagentId) return
    try {
      // 监听器执行时不假定 ALS 仍有效，使用请求注册层冻结的会话上下文。
      const root = workspaceOf(execution.agent)
      const archive = openArchive(root, { create: false })
      archive.transact('teach_fact_check_started', undefined, (draft) => {
        const run = draft.factCheckRuns?.[marker[1]]
        if (!run || run.dispatchHashes[Number(marker[2])] !== hashJson(execution.arguments.prompt)) return { changes: [], result: {} }
        if ((run.started ?? []).length >= FACT_CHECK_BUDGET[run.level][1]) return { changes: [], result: {} }
        return { changes: [{ type: 'fact-check.started', data: { runId: marker[1], agentId: value.subagentId } }], result: {} }
      })
    } catch (error) { ctx.logger?.warn?.('teach-me: 核查启动记录失败：' + error.message) }
  })
}
