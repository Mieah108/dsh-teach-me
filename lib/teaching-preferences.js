/* 宿主侧会话偏好；工作区复制不带走它。写入成功后才替换内存值。 */
import { z } from 'zod'
export const FACT_CHECK = ['none', 'loose', 'moderate', 'strict']
export const DEPTH = ['shallow', 'moderate', 'deep']
export const preferencesSchema = z.object({
  factCheck: z.enum(FACT_CHECK), depth: z.enum(DEPTH),
  collections: z.record(z.string(), z.string()), createdAt: z.string()
})
export const preferencesDomain = {
  name: 'teach_session_preferences', version: 1,
  tables: { sessions: { valueSchema: preferencesSchema } }
}
export function defaultPreferences(config = {}) {
  return { factCheck: FACT_CHECK.includes(config.teaching?.factCheck) ? config.teaching.factCheck : 'moderate',
    depth: DEPTH.includes(config.teaching?.depth) ? config.teaching.depth : 'moderate', collections: {}, createdAt: new Date().toISOString() }
}
export function createTeachingPreferences(getDomain, getConfig) {
  let opening
  const domain = () => {
    if (!opening) opening = Promise.resolve().then(() => {
      const facility = getDomain()
      if (!facility?.open) throw new Error('宿主 storage.domain 未就绪，教学设置尚未保存')
      return facility.open(preferencesDomain)
    }).catch((error) => { opening = undefined; throw error })
    return opening
  }
  const chains = new Map()
  const serial = (id, task) => {
    const result = (chains.get(id) ?? Promise.resolve()).catch(() => {}).then(task)
    chains.set(id, result)
    result.finally(() => { if (chains.get(id) === result) chains.delete(id) }).catch(() => {})
    return result
  }
  const ensure = (id) => serial(id, async () => {
    const table = (await domain()).table('sessions')
    const stored = table.get(id)
    if (stored) return structuredClone(stored)
    const initial = defaultPreferences(getConfig())
    await table.put(id, initial)
    return structuredClone(initial)
  })
  return {
    ensure,
    async update(id, patch, root) {
      await ensure(id)
      return serial(id, async () => {
        const table = (await domain()).table('sessions')
        const current = table.get(id)
        const next = preferencesSchema.parse({ ...current,
          ...(patch.factCheck === undefined ? {} : { factCheck: patch.factCheck }),
          ...(patch.depth === undefined ? {} : { depth: patch.depth }),
          collections: patch.collectionId === undefined ? current.collections : { ...current.collections, [root]: patch.collectionId }
        })
        await table.put(id, next)
        return structuredClone(next)
      })
    },
    async close() { if (opening) await (await opening).close() }
  }
}
