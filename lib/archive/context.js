/* F4：同一journal快照上的只读、有界上下文；来源不污染旧投影schema。 */
import { tryOpenArchive } from './store.js'
import { verdictViewOf } from './state.js'
import { ValidationError } from './errors.js'

const order = (a, b) => a < b ? -1 : a > b ? 1 : 0

export function projectLearningContext(state, entries, { runId, lessonId, now = Date.now(), stage } = {}) {
  if (lessonId !== undefined && state.lessons[lessonId] === undefined) throw new ValidationError('没有这节课：' + lessonId)
  const sources = new Map()
  for (const entry of entries) {
    entry.changes.forEach((change, changeIndex) => {
      sources.set(change.type + ':' + (change.data.id ?? change.data.runId ?? ''), { seq: entry.seq, changeIndex })
    })
  }
  const sourceOf = (type, id = '') => sources.get(type + ':' + id) ?? null
  const scope = lessonId === undefined ? 'workspace' : lessonId
  const ids = lessonId === undefined ? Object.keys(state.objectives) : state.lessons[lessonId].objectives
  const objectives = ids.filter((id) => state.objectives[id]?.status === 'active').sort(order)
    .map((id) => ({ id, title: state.objectives[id].title, source: sourceOf('objective.upsert', id) }))
    .filter((item) => item.source !== null)
  const conclusions = Object.values(state.submissions).filter((item) => lessonId === undefined || item.lessonId === lessonId)
    .flatMap((submission) => {
      const view = verdictViewOf(state, submission)
      const assessmentId = submission.latestAssessmentId
      const source = sourceOf('assessment.recorded', assessmentId)
      if (source === null || view.effectiveVerdict === null || view.effectiveVerdict === 'void') return []
      return [{ submissionId: submission.id, questionId: submission.questionId, assessmentId, verdict: view.effectiveVerdict, source }]
    }).sort((a, b) => b.source.seq - a.source.seq || b.source.changeIndex - a.source.changeIndex || order(a.assessmentId, b.assessmentId)).slice(0, 5)
  const inScope = (item) => lessonId === undefined || item.lessonId === lessonId
  const pendingGrading = Object.values(state.submissions).filter((item) => inScope(item) && item.status === 'pending').length
  const dueCount = Object.values(state.reviews).filter((item) => {
    if (item.state !== 'scheduled' || !(Date.parse(item.dueAt) <= now)) return false
    return lessonId === undefined || state.questions[item.questionId]?.lessonId === lessonId || ids.includes(item.objectiveId)
  }).length
  const run = state.runs?.[runId]
  return {
    scope,
    stage: run?.stage ?? stage?.stage ?? null,
    stageSource: run === undefined ? null : sourceOf('run.state', runId),
    mission: state.mission === null || sourceOf('mission.updated') === null ? null : { text: state.mission.text, source: sourceOf('mission.updated') },
    objectives: objectives.slice(0, 8), objectiveCount: objectives.length,
    conclusions, pendingGrading, dueCount
  }
}

export function readLearningContext(root, options = {}) {
  const archive = tryOpenArchive(root, { repairIndex: false })
  if (archive === null) return null
  return projectLearningContext(archive.state, archive.journalEntries, options)
}

const provenance = (source) => source === null ? '内存' : `seq ${source.seq}/${source.changeIndex}`
export function formatLearningContext(view) {
  const lines = [`学习上下文（${view.scope === 'workspace' ? '工作区' : '课程 ' + view.scope}）：`, `阶段：${view.stage ?? '未知'}（${provenance(view.stageSource)}）`]
  if (view.mission !== null) lines.push(`使命：${view.mission.text}（${provenance(view.mission.source)}）`)
  for (const item of view.objectives) lines.push(`目标 ${item.id}：${item.title}（${provenance(item.source)}）`)
  if (view.objectiveCount > view.objectives.length) lines.push(`目标共${view.objectiveCount}条，仅显示前8条。`)
  for (const item of view.conclusions) lines.push(`结论 ${item.questionId}：${item.verdict}（${item.assessmentId}，${provenance(item.source)}）`)
  lines.push(`评估待处理 ${view.pendingGrading} / 复习到期 ${view.dueCount}`)
  return lines.join('\n')
}
