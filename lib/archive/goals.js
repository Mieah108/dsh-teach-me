/* F2：定义形状与差异计划。复用已有事件，不更改旧 objectives ID 数组。 */
import { ValidationError } from './errors.js'
import { assertId, assertString } from './state.js'
import { canonicalJson, sha256 } from './util.js'

const fields = ['id', 'title', 'description', 'acceptance']

export const GOAL_PARAMETERS = {
  mission: { type: 'string', maxLength: 200, description: '显式更新工作区使命；省略保留。' },
  objectiveDefinitions: {
    type: 'array', maxItems: 8,
    items: {
      type: 'object', additionalProperties: false, required: ['id', 'title'],
      properties: {
        id: { type: 'string' }, title: { type: 'string', maxLength: 500 },
        description: { type: 'string', maxLength: 5000 },
        acceptance: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 1000 } }
      }
    }
  }
}

/** 在任何建档/编译写盘之前调用；返回undefined表示完全沿用旧调用。 */
export function goalInputOf(input) {
  if (input.mission === undefined && input.objectiveDefinitions === undefined) return undefined
  const goal = {}
  if (input.mission !== undefined) goal.mission = assertString(input.mission, 'mission', { max: 200 }).trim()
  if (input.objectiveDefinitions !== undefined) {
    if (!Array.isArray(input.objectiveDefinitions) || input.objectiveDefinitions.length > 8) {
      throw new ValidationError('objectiveDefinitions 必须是最多8项的数组')
    }
    const ids = new Set()
    goal.objectiveDefinitions = input.objectiveDefinitions.map((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some((key) => !fields.includes(key))) {
        throw new ValidationError('目标定义只接受 id/title/description/acceptance')
      }
      const id = assertId(item.id, 'objective.id')
      if (ids.has(id)) throw new ValidationError('目标定义id重复：' + id)
      ids.add(id)
      const definition = { id, title: assertString(item.title, 'objective.title', { max: 500 }) }
      if (item.description !== undefined) definition.description = assertString(item.description, 'objective.description', { max: 5000, allowEmpty: true })
      if (item.acceptance !== undefined) {
        if (!Array.isArray(item.acceptance) || item.acceptance.length > 8) throw new ValidationError('acceptance 必须是最多8项的数组')
        definition.acceptance = item.acceptance.map((text) => assertString(text, 'objective.acceptance', { max: 1000 }))
      }
      return definition
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  }
  return goal
}

export function assertGoalLinks(goals, objectiveIds) {
  for (const item of goals?.objectiveDefinitions ?? []) {
    if (!objectiveIds.includes(item.id)) throw new ValidationError('目标定义必须关联这节课的objectives：' + item.id)
  }
}

/** 必须在事务锁内以draft计算，未提供的字段保持原值。 */
export function goalChangesOf(state, goals) {
  const changes = []
  if (goals?.mission !== undefined && goals.mission !== state.mission?.text) {
    changes.push({ type: 'mission.updated', data: { text: goals.mission, sha256: sha256(goals.mission) } })
  }
  for (const item of goals?.objectiveDefinitions ?? []) {
    const old = state.objectives[item.id]
    const data = {
      id: item.id, title: item.title,
      description: item.description ?? old?.description ?? '',
      acceptance: item.acceptance ?? old?.acceptance ?? [],
      prerequisites: old?.prerequisites ?? [], tags: old?.tags ?? [], status: old?.status ?? 'active'
    }
    const before = old === undefined ? null : Object.fromEntries(Object.keys(data).map((key) => [key, old[key]]))
    if (canonicalJson(before) !== canonicalJson(data)) changes.push({ type: 'objective.upsert', data })
  }
  return changes
}
