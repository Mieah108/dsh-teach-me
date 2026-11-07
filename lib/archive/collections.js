import { openArchive, tryOpenArchive } from './store.js'
import { DEFAULT_COLLECTION, withLearningScope } from './learning-scope.js'
import { assertId, assertString } from './state.js'
import { randomId } from './util.js'
import { ValidationError } from './errors.js'

export function collectionList(state) {
  return [{ id: DEFAULT_COLLECTION, name: state?.collectionInfo?.default?.name ?? '默认集合', archived: state?.collectionInfo?.default?.archived === true },
    ...Object.values(state?.collectionInfo ?? {}).filter((c) => c.id !== DEFAULT_COLLECTION)]
}
export function collectionState(state, id = DEFAULT_COLLECTION) {
  if (id === DEFAULT_COLLECTION) return state.collectionFormat === 1 ? { ...state, collectionId: id } : state
  const child = state.collectionStates?.[id]
  if (!child) throw new ValidationError('教学集合不存在：' + id)
  return { ...child, collectionId: id, workspaceId: state.workspaceId, revision: state.revision, lastSeq: state.lastSeq, lastHash: state.lastHash }
}
export function manageCollection(root, input) {
  return withLearningScope({}, () => {
    const archive = openArchive(root, { create: true })
    archive.initializeLearning()
    const action = input.action
    const id = input.id ?? (action === 'create' || action === 'copy' ? randomId('collection') : DEFAULT_COLLECTION)
    assertId(id, 'collection.id')
    return archive.transact('teach_collection', input.expectedRevision, (draft) => {
      const list = collectionList(draft)
      if (action === 'create' || action === 'copy') {
        if (list.some((c) => c.id === id)) throw new ValidationError('集合 id 已存在')
        const name = assertString(input.name, 'collection.name', { max: 100 }).trim()
        const sourceId = input.sourceId ?? DEFAULT_COLLECTION
        const source = action === 'copy' ? collectionState(draft, sourceId) : null
        return { changes: [{ type: 'collection.created', data: { id, name, sourceId: source ? sourceId : null } }], result: { id, name } }
      }
      if (!list.some((c) => c.id === id)) throw new ValidationError('集合不存在')
      if (!['rename', 'archive', 'restore', 'adopt', 'add'].includes(action)) throw new ValidationError('不支持的集合操作')
      if (action === 'adopt' || action === 'add') {
        assertId(input.lessonId, 'lessonId')
        const source = collectionState(draft, input.sourceId ?? DEFAULT_COLLECTION)
        const version = input.contentVersion ? source.lessonVersions?.[input.lessonId]?.[input.contentVersion] : source.lessonVersions?.[input.lessonId]?.[source.lessons[input.lessonId]?.contentVersion]
        if (!version) throw new ValidationError('没有可采用的已发布版本')
        return { changes: [{ type: 'collection.lesson', data: { id, lessonId: input.lessonId, version, ...(source.factChecks?.[input.lessonId]?.[version.contentVersion] ? { factCheck: source.factChecks[input.lessonId][version.contentVersion] } : {}) } }], result: { id, lessonId: input.lessonId, contentVersion: version.contentVersion } }
      }
      const current = list.find((c) => c.id === id)
      const next = { ...current, ...(action === 'rename' ? { name: assertString(input.name, 'collection.name', { max: 100 }).trim() } : { archived: action === 'archive' }) }
      return { changes: [{ type: 'collection.updated', data: next }], result: next }
    })
  })
}
export function readCollections(root) {
  return withLearningScope({}, () => collectionList(tryOpenArchive(root, { repairIndex: false })?.state))
}
