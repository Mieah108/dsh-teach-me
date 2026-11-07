import { learningScope, DEFAULT_COLLECTION, withLearningScope } from './learning-scope.js'
import { snapshotLesson, versionView } from './versions.js'
import { collectionState } from './collections.js'
/* 学习档案的打开、校验、事务与重建。
 *
 * 目录结构（全部在 <教学根>/.dsh-teach-me/archive/ 下，一个工作区只有一个隐藏目录）：
 *   workspace.json        身份与 schema 版本
 *   journal/YYYY-MM.jsonl 追加式提交日志（权威）
 *   index.json            可重建投影（落后或损坏都从日志重建）
 *   locks/workspace.lock  跨进程写锁
 *   backups/              迁移/修复前备份
 *
 * 0.5.0 之前档案在 <教学根>/.teach；旧布局在第一次打开时整体挪进
 * .dsh-teach-me/archive（同一文件系统上的 rename，原子且不复制），挪不动就继续读旧位置，
 * 绝不在两个地方各写一半。
 *
 * 一次提交 = 一行日志 + 一次原子替换的索引。先日志后索引：
 * 索引写失败时日志已经是权威，下次打开会重建，不会丢已确认的提交。 */

import fs from 'node:fs'
import path from 'node:path'
import { ArchiveNotInitializedError, JournalCorruptionError, RevisionConflictError, UnsupportedSchemaError, ValidationError, WorkspaceMissingError } from './errors.js'
import { acquireLock } from './lock.js'
import { appendJournal, journalFiles, readJournal } from './journal.js'
import { FORWARD_COMPAT_EVENT_TYPES, SCHEMA_VERSION, applyChange, emptyState, summarize } from './state.js'
import { readSnapshot, writeSnapshot } from './snapshot.js'
import { atomicWrite, backupArchiveFiles, canonicalJson, ensureRealDir, nowIso, randomId, readJson, stamp } from './util.js'

const IDENTITY_FILE = 'workspace.json'
const INDEX_FILE = 'index.json'

/** 插件在这个工作区里唯一的隐藏目录。档案、动画 staging、教学根指针都放在它下面。 */
export const TEACH_DIRNAME = '.dsh-teach-me'
/** 档案在隐藏目录里的子目录名。 */
export const ARCHIVE_DIRNAME = 'archive'
/** 0.5.0 之前的档案目录，只用于迁移。 */
const LEGACY_ARCHIVE_DIRNAME = '.teach'

/**
 * 档案目录（<root>/.dsh-teach-me/archive）。
 * @param {string} root 教学根
 * @returns {string} 绝对路径
 */
export function archiveDirOf(root) {
  return path.join(root, TEACH_DIRNAME, ARCHIVE_DIRNAME)
}

/**
 * 旧布局的档案目录（<root>/.teach），只给迁移与诊断用。
 * @param {string} root 教学根
 * @returns {string} 绝对路径
 */
export function legacyArchiveDirOf(root) {
  return path.join(root, LEGACY_ARCHIVE_DIRNAME)
}

/**
 * 定位档案目录，必要时把旧布局整体搬进来。
 *
 * 迁移只在「新位置不存在、旧位置存在」时发生，用 rename（同盘原子），失败就退回旧位置继续
 * 读写，不新建空档案 —— 否则一次权限问题会把一位学习者的历史切成两半。
 * @param {string} root 教学根
 * @param {{migrate?: boolean}} [options] 纯读时禁用布局迁移
 * @returns {{dir: string, migrated: boolean, from?: string, legacy?: boolean}}
 */
export function resolveArchiveDir(root, { migrate = true } = {}) {
  const parent = path.join(root, TEACH_DIRNAME)
  // 新布局多了一层父目录，不能只检查 archive 本身。
  try {
    const stat = fs.lstatSync(parent)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ValidationError(`档案父目录必须是真实目录，不允许符号链接：${parent}`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const next = archiveDirOf(root)
  if (fs.existsSync(next)) return { dir: next, migrated: false }
  const legacy = legacyArchiveDirOf(root)
  if (fs.existsSync(legacy)) {
    if (!migrate) return { dir: legacy, migrated: false, legacy: true }
    let lock
    try {
      fs.mkdirSync(path.join(root, TEACH_DIRNAME), { recursive: true })
      lock = acquireLock(legacy, { timeoutMs: 0, label: 'layout-migration' })
      fs.renameSync(legacy, next)
      lock.relocate(next)
      return { dir: next, migrated: true, from: legacy }
    } catch {
      // 另一进程可能已经完成迁移；不能返回消失的旧路径并在那儿另建空档案。
      if (fs.existsSync(next)) return { dir: next, migrated: false }
      // 挪不动（只读、跨设备、被占用）：继续用旧位置，不产生第二份档案。
      return { dir: legacy, migrated: false, legacy: true }
    } finally {
      if (lock !== undefined && fs.existsSync(next) && !fs.existsSync(legacy)) lock.relocate(next)
      lock?.release()
    }
  }
  return { dir: next, migrated: false }
}

function workspaceReal(dir) {
  let real
  try {
    real = fs.realpathSync.native(dir)
  } catch {
    throw new WorkspaceMissingError(dir)
  }
  if (!fs.statSync(real).isDirectory()) throw new WorkspaceMissingError(dir)
  return real
}

function writeIdentity(archiveDir, identity) {
  atomicWrite(path.join(archiveDir, IDENTITY_FILE), JSON.stringify(identity, null, 2) + '\n')
}

function readIdentity(archiveDir) {
  const file = path.join(archiveDir, IDENTITY_FILE)
  let identity
  try {
    // 初次发布身份用 link，另一个进程可能看到发布后、临时名删除前的两个链接。
    identity = readJson(file, { allowHardLinks: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new JournalCorruptionError(`工作区身份文件读不出来：${file}`, { file, cause: String(error) })
  }
  if (!Number.isInteger(identity?.schemaVersion)) {
    throw new JournalCorruptionError(`工作区身份文件缺少 schemaVersion：${file}`, { file, identity })
  }
  if (identity.schemaVersion > SCHEMA_VERSION) throw new UnsupportedSchemaError(identity.schemaVersion, SCHEMA_VERSION)
  if (typeof identity.workspaceId !== 'string' || identity.workspaceId.length === 0 ||
      typeof identity.createdAt !== 'string' || Number.isNaN(Date.parse(identity.createdAt))) {
    throw new JournalCorruptionError('工作区身份缺少有效 workspaceId/createdAt：' + file)
  }
  return identity
}

function createArchiveDirs(archiveDir) {
  ensureRealDir(archiveDir)
  for (const name of ['journal', 'locks', 'backups']) ensureRealDir(path.join(archiveDir, name))
}

/**
 * 顺序重放日志（重放路径）。
 *
 * 只有登记在 FORWARD_COMPAT_EVENT_TYPES 里的类型允许跳过：旧版本读新档案时不认识
 * `run.state`，不能因此把整份档案判成损坏，否则回滚代码 = 档案不可用。
 * 其它任何错误一律往外抛 —— 跳过通道不比一个类型名更宽；写路径（transact）不经过这里。
 *
 * @param {object[]} entries readJournal 的 entries
 * @param {object[]} [tolerated] 调用方持有的数组，跳过的事件按条记录进去
 * @param {object} [initial] 已校验的快照投影；省略时从空状态完整重放
 */
function applyEntries(entries, tolerated = [], initial = emptyState()) {
  const state = initial
  for (const entry of entries) {
    for (const change of entry.changes) {
      try {
        applyChange(state, change, { at: entry.at, actor: entry.actor, seq: entry.seq })
      } catch (error) {
        // 三条同时满足才跳过：校验错误 + 明确是「未知类型」+ 类型在登记表里。
        // 已知类型（例如 run.state）的载荷坏掉仍然 rethrow：那是日志损坏，不是版本差异。
        const unknownType = error instanceof ValidationError && error.detail?.kind === 'unknown-event-type'
        if (!unknownType || !FORWARD_COMPAT_EVENT_TYPES.has(change?.type)) throw error
        tolerated.push({ type: change.type, seq: entry.seq, revision: entry.revision, message: error.message })
      }
    }
    state.revision = entry.revision
    state.lastSeq = entry.seq
    state.lastHash = entry.hash
  }
  return state
}

function indexPayload(state) {
  return {
    schemaVersion: SCHEMA_VERSION,
    workspaceId: state.workspaceId,
    revision: state.revision,
    lastSeq: state.lastSeq,
    lastHash: state.lastHash,
    updatedAt: nowIso(),
    state
  }
}

function writeIndex(archiveDir, state) {
  atomicWrite(path.join(archiveDir, INDEX_FILE), JSON.stringify(indexPayload(state)) + '\n')
}

function readIndex(archiveDir) {
  const file = path.join(archiveDir, INDEX_FILE)
  try {
    return readJson(file)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return { corrupt: true, error: String(error) }
  }
}

function backupIndex(archiveDir) {
  const file = path.join(archiveDir, INDEX_FILE)
  if (!fs.existsSync(file)) return null
  const backupDir = path.join(archiveDir, 'backups', `${stamp()}-index`)
  ensureRealDir(backupDir)
  const target = path.join(backupDir, INDEX_FILE)
  fs.copyFileSync(file, target)
  return target
}

/**
 * 打开（或初始化）一个工作区的档案。
 * 读路径会校验日志哈希链；索引缺失/落后/损坏时从日志重建并原子写回
 * （repairIndex:false 可在纯读场景关掉写回，日志仍是权威）。
 */
export function openArchive(workspace, { create = false, repairIndex = true, useSnapshot = true } = {}) {
  const root = workspaceReal(workspace)
  const resolved = resolveArchiveDir(root, { migrate: repairIndex })
  const archiveDir = resolved.dir
  let exists = false
  try {
    const stat = fs.lstatSync(archiveDir)
    if (stat.isSymbolicLink()) {
      throw new ValidationError(`档案目录是符号链接，拒绝把学习档案写到别处：${archiveDir}`, { archiveDir })
    }
    exists = stat.isDirectory()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!exists && !create) throw new ArchiveNotInitializedError(root)
  if (!exists) createArchiveDirs(archiveDir)

  let identity = readIdentity(archiveDir)
  if (identity === null) {
    if (!create) throw new ArchiveNotInitializedError(root)
    if (journalFiles(archiveDir).length > 0) throw new JournalCorruptionError('身份文件缺失但日志仍在，拒绝生成新身份：' + archiveDir)
    const identityValue = { schemaVersion: SCHEMA_VERSION, workspaceId: randomId('ws'), createdAt: nowIso() }
    const temporary = path.join(archiveDir, '.dsh-teach-tmp-identity-' + randomId('init'))
    try {
      atomicWrite(temporary, JSON.stringify(identityValue, null, 2) + '\n')
      try {
        // link 只在目标不存在时发布完整身份，不让另一个进程读到半份 JSON。
        fs.linkSync(temporary, path.join(archiveDir, IDENTITY_FILE))
        fs.unlinkSync(temporary)
        identity = identityValue
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        identity = readIdentity(archiveDir)
        if (identity === null) throw error
      }
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }

  if (identity.schemaVersion < SCHEMA_VERSION && repairIndex) {
    // 旧版本：先整份备份身份/日志/索引，再升级身份文件。日志若本来就为空，
    // reload 会补上 workspace.initialized；非空日志照常重放到新 schema。
    const backup = backupArchiveFiles(archiveDir, 'migration-v' + identity.schemaVersion + '-to-v' + SCHEMA_VERSION)
    identity = {
      ...identity,
      schemaVersion: SCHEMA_VERSION,
      migratedAt: nowIso(),
      migratedFrom: identity.schemaVersion,
      migrationBackup: backup
    }
    writeIdentity(archiveDir, identity)
  }

  const archive = new Archive(root, archiveDir, identity)
  archive.useSnapshot = useSnapshot
  archive.reload({ repairIndex })
  if (archive.state.lastSeq === 0 && (create || repairIndex)) archive.initialize('system')
  return archive
}

/**
 * 只读打开：没有档案时返回 null，不创建目录。
 * repairIndex:false 时连索引自愈都不写盘 —— 纯读队列（teach_review due）用它。
 */
export function tryOpenArchive(workspace, options = {}) {
  try {
    return openArchive(workspace, options)
  } catch (error) {
    if (error?.code === 'archive-not-initialized') return null
    throw error
  }
}

function cloneProjection(source) {
  const copy = structuredClone(source)
  const restore = (before, after) => {
    if (!before || typeof before !== 'object') return
    if (Object.getPrototypeOf(before) === null) Object.setPrototypeOf(after, null)
    for (const key of Object.keys(before)) restore(before[key], after[key])
  }
  restore(source, copy)
  return copy
}

class Archive {
  constructor(root, archiveDir, identity) {
    this.root = root
    this.archiveDir = archiveDir
    this.workspaceId = identity.workspaceId
    this.createdAt = identity.createdAt
    this.globalState = null
    this.warnings = []
    // 重放时被跳过的向前兼容事件（见 state.js 的 FORWARD_COMPAT_EVENT_TYPES）。
    this.toleratedChanges = []
  }

  get state() {
    const selected = collectionState(this.globalState, learningScope().collectionId ?? DEFAULT_COLLECTION)
    return versionView(selected, learningScope())
  }

  /** 首次显式写入升级，备份权威日志和身份；只读打开绝不调用。 */
  initializeLearning() {
    if (this.globalState.collectionFormat === 1) return
    const lock = acquireLock(this.archiveDir, { label: 'learning-migration' })
    try {
      this.reload({ repairIndex: false })
      if (this.globalState.collectionFormat === 1) return
      backupArchiveFiles(this.archiveDir, 'before-learning-collections')
      const changes = [{ type: 'learning.initialized', data: {} }]
      for (const lesson of Object.values(this.globalState.lessons)) {
        const version = snapshotLesson(this.root, this.archiveDir, this.globalState, lesson)
        changes.push({ type: 'lesson.versioned', data: { lessonId: lesson.id, version } })
      }
      // 下方共用事务需要自己持锁；先释放迁移锁，再通过 CAS 防止重复迁移。
      const revision = this.globalState.revision
      lock.release()
      withLearningScope({}, () => this.transact('learning-migration', revision, (draft) => ({ changes: draft.collectionFormat === 1 ? [] : changes, result: {} })))
    } finally { lock.release() }
  }

  get path() {
    return this.archiveDir
  }

  /** 同一条提示只留一次：一次调用里可能 reload 多次（每次事务都在锁内重读），重复行会原样进 teach_status。 */
  addWarning(message) {
    if (!this.warnings.includes(message)) this.warnings.push(message)
  }

  /** 从日志重建内存状态；索引落后时顺带修复索引（只读调用可关掉写回）。 */
  reload({ repairIndex = true, useSnapshot = this.useSnapshot } = {}) {
    const journal = readJournal(this.archiveDir)
    const index = readIndex(this.archiveDir)
    // 索引不可信；快照仅用于显式生成过的派生缓存，日志仍先全链校验。
    const snapshot = useSnapshot ? readSnapshot(this.archiveDir, this.workspaceId, journal) : { state: null, reason: 'disabled' }
    let tolerated = snapshot.state === null ? [] : [...snapshot.tolerated]
    let state
    let usedSnapshot = snapshot.state !== null
    let fallback = snapshot.reason
    try {
      state = usedSnapshot ? applyEntries(journal.entries.slice(snapshot.seq), tolerated, snapshot.state) : applyEntries(journal.entries, tolerated)
    } catch (error) {
      if (!usedSnapshot) throw error
      usedSnapshot = false
      fallback = '快照尾部重放失败：' + error.message
      tolerated = []
      state = applyEntries(journal.entries, tolerated)
    }
    this.replayInfo = {
      usedSnapshot, snapshotSeq: usedSnapshot ? snapshot.seq : 0,
      replayedEntries: journal.entries.length - (usedSnapshot ? snapshot.seq : 0), fallbackReason: fallback
    }
    if (!usedSnapshot && fallback !== 'missing' && fallback !== 'disabled') this.addWarning('快照不可用，已全量重放：' + fallback)
    // F4：保留本次重放的来源快照，不写入index，不再次读取可能已推进的journal。
    this.journalEntries = journal.entries
    this.toleratedChanges = tolerated
    if (state.workspaceId !== null && state.workspaceId !== this.workspaceId) {
      throw new JournalCorruptionError(
        `日志属于另一个工作区（日志 ${state.workspaceId}，身份文件 ${this.workspaceId}），拒绝混用。`,
        { journalWorkspaceId: state.workspaceId, identityWorkspaceId: this.workspaceId }
      )
    }
    if (state.workspaceId === null && journal.entries.length > 0) {
      throw new JournalCorruptionError('日志里有提交，但没有 workspace.initialized 事件；需要显式恢复。', { lastSeq: journal.lastSeq })
    }
    state.workspaceId = state.workspaceId ?? this.workspaceId
    state.createdAt = state.createdAt ?? this.createdAt
    state.revision = journal.revision
    state.lastSeq = journal.lastSeq
    state.lastHash = journal.lastHash
    if (tolerated.length > 0) {
      const types = [...new Set(tolerated.map((item) => item.type))].join('、')
      this.addWarning(
        `档案里有 ${tolerated.length} 条本版本不认识的事件（${types}），已按向前兼容声明跳过；` +
          '相关状态退回内存，事件本身仍完整保留在日志里（升级版本可重新读出来）。'
      )
    }
    const indexOk = index !== null && index.corrupt !== true &&
      index.workspaceId === this.workspaceId && index.revision === state.revision &&
      index.lastSeq === state.lastSeq && index.lastHash === state.lastHash &&
      canonicalJson(index.state) === canonicalJson(state)
    if (indexOk) {
      this.globalState = state
      return state
    }
    if (index?.corrupt && repairIndex) {
      const backup = backupIndex(this.archiveDir)
      this.addWarning(`索引损坏，已备份到 ${backup} 并从日志重建`)
    } else if (journal.lastSeq > 0 && tolerated.length === 0) {
      // 有跳过事件时索引必然对不上（旧版本的投影里没有新版本才有的根键）；
      // 上面那条降级提示已经说明原因，不再叠加「索引落后」的噪音。
      this.addWarning('索引落后于日志，已从日志重建')
    }
    if (repairIndex) writeIndex(this.archiveDir, state)
    this.globalState = state
    return state
  }

  /** 首次打开时写入 identity 事件；整个过程只在空日志上发生。 */
  initialize(actor = 'system') {
    if (this.globalState.lastSeq !== 0) return this.globalState
    this.transact(actor, undefined, (draft) => ({
      changes: draft.lastSeq !== 0 ? [] : [{ type: 'workspace.initialized', data: { workspaceId: this.workspaceId, createdAt: this.createdAt } }],
      result: { workspaceId: this.workspaceId, revision: 1 }
    }))
    return this.globalState
  }

  /** 锁内重新读，发现别人推进了就按 expectedRevision 报冲突。 */
  _refreshLocked(expectedRevision) {
    this.reload()
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== this.globalState.revision) {
      throw new RevisionConflictError(expectedRevision, this.globalState.revision)
    }
  }

  /**
   * 执行一次事务。producer(draft, context) 返回 {changes, result}；
   * changes 为空表示幂等命中、不写日志；非空则作为一行提交。
   */
  transact(actor, expectedRevision, producer, { timeoutMs } = {}) {
    if (typeof producer !== 'function') throw new ValidationError('transact 需要 producer 函数')
    if (actor !== 'learning-migration' && learningScope().enabled && this.globalState.lastSeq > 0 && this.globalState.collectionFormat !== 1) this.initializeLearning()
    this.archiveDir = resolveArchiveDir(this.root, { migrate: false }).dir
    const lock = acquireLock(this.archiveDir, { timeoutMs })
    try {
      this._refreshLocked(expectedRevision)
      const globalDraft = cloneProjection(this.globalState)
      const collectionId = learningScope().collectionId ?? DEFAULT_COLLECTION
      const draft = versionView(collectionState(globalDraft, collectionId), learningScope())
      // structuredClone 会丢掉 null prototype，恢复按 id 索引的字典语义。
      for (const [key, value] of Object.entries(this.state)) {
        if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === null) Object.setPrototypeOf(draft[key], null)
      }
      const produced = producer(draft, { workspaceId: this.workspaceId, revision: this.globalState.revision })
      if (produced === null || typeof produced !== 'object') throw new ValidationError('事务没有返回结果')
      let changes = Array.isArray(produced.changes) ? produced.changes : []
      const at = nowIso(produced.at)
      if (changes.length === 0) return { ...produced.result, revision: draft.revision, committed: false }

      for (const change of changes) applyChange(draft, change, { at, actor })
      if (globalDraft.collectionFormat === 1 && actor !== 'learning-migration') {
        const affected = new Set(changes.flatMap((c) => c.type === 'lesson.published' ? [c.data.id] : c.type === 'question.upsert' ? [c.data.lessonId] : c.type === 'material.indexed' ? Object.keys(draft.lessons) : []))
        for (const id of affected) {
          const version = snapshotLesson(this.root, this.archiveDir, draft, draft.lessons[id])
          const event = { type: 'lesson.versioned', data: { lessonId: id, version } }
          applyChange(draft, event, { at, actor })
          changes.push(event)
        }
      }
      if (collectionId !== DEFAULT_COLLECTION) {
        changes = [{ type: 'collection.transaction', data: { id: collectionId, changes } }]
      }
      // 从权威投影应用一次，避免 producer/历史版本视图的局部状态意外写进全局。
      const next = cloneProjection(this.globalState)
      for (const change of changes) applyChange(next, change, { at, actor })
      const revision = this.globalState.revision + 1
      next.revision = revision
      next.lastSeq = this.globalState.lastSeq + 1
      const entry = appendJournal(this.archiveDir, { seq: next.lastSeq, revision, actor, changes, at })
      next.lastHash = entry.hash
      this.globalState = next
      try {
        writeIndex(this.archiveDir, next)
      } catch (error) {
        // 日志已经 fsync：不能把已提交报告成失败，诱发重复写入。
        this.addWarning('提交已落日志，但索引写回失败，下次打开可重建：' + error.message)
      }
      return { ...produced.result, revision, committed: true }
    } finally {
      lock.release()
    }
  }

  summary() {
    return { ...summarize(this.state), lastSeq: this.globalState.lastSeq, workspaceId: this.workspaceId }
  }

  /** 显式维护：持同一档案写锁，全量重放生成快照，不改变 journal/index。 */
  createSnapshot() {
    this.archiveDir = resolveArchiveDir(this.root, { migrate: false }).dir
    const lock = acquireLock(this.archiveDir, { label: 'create-snapshot' })
    try {
      this.reload({ repairIndex: false, useSnapshot: false })
      if (this.globalState.lastSeq < 1) throw new ValidationError('空档案不能生成快照')
      return writeSnapshot(this.archiveDir, this.globalState, this.toleratedChanges)
    } finally {
      lock.release()
    }
  }

  /** 显式重建索引；返回重建前后的信息。 */
  rebuild() {
    const lock = acquireLock(this.archiveDir, { label: 'rebuild-index' })
    try {
      const before = readIndex(this.archiveDir)
      const journal = readJournal(this.archiveDir)
      const tolerated = []
      const state = applyEntries(journal.entries, tolerated)
      this.toleratedChanges = tolerated
      this.journalEntries = journal.entries
      this.replayInfo = { usedSnapshot: false, snapshotSeq: 0, replayedEntries: journal.entries.length, fallbackReason: 'rebuild' }
      if (state.workspaceId !== this.workspaceId) {
        throw new JournalCorruptionError('日志的 workspaceId 与身份文件不一致，不能重建', {
          journal: state.workspaceId,
          identity: this.workspaceId
        })
      }
      state.revision = journal.revision
      state.lastSeq = journal.lastSeq
      state.lastHash = journal.lastHash
      backupIndex(this.archiveDir)
      writeIndex(this.archiveDir, state)
      this.globalState = state
      return {
        rebuilt: true,
        revision: state.revision,
        lastSeq: state.lastSeq,
        previousIndexRevision: before?.revision ?? null,
        // 重建也会跳过向前兼容事件：索引按当前投影重写，日志仍是唯一权威。
        tolerated: tolerated.length
      }
    } finally {
      lock.release()
    }
  }
}
