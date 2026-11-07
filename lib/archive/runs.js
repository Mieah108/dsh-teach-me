/* run 级教学状态的档案面：投影读取、事件规划、数据水位。
 *
 * 阶段与待确认项以前是进程内闭包（lib/stages.js 的 Map），重启即丢；
 * 现在写成 run.state 事件，投影在 state.runs[runId] 上，规则在 state.js 里校验。
 *
 * 这里不做 I/O：producer 在锁内调用 planRunState 生成 change，由 archive.transact
 * 追加并应用。run 级 CAS 只看 runs[runId].revision，与全局 revision 无关 ——
 * 别的会话写档案不会把这里的版本推成冲突。
 */

import { emptyRunProjection, runStateOf as projectionOf } from './state.js'

export { emptyRunProjection }

/** 读某个 run 的投影；没有返回 null（老档案或还没写过 run.state）。 */
export function runStateOf(state, runId) {
  return projectionOf(state, runId)
}

/**
 * 规划一条 run.state：runRevision = 上一次 +1。
 * 校验仍由 state.js 的 applyChange 在 transact 内统一做（写路径不放宽）。
 *
 * @param {{state: object, runId: string, stage: string, pending?: object[], watermarks: object, at?: string}} input
 * @returns {{change: object, runRevision: number}}
 */
export function planRunState({ state, runId, stage, pending = [], watermarks, at }) {
  const previous = runStateOf(state, runId)
  const runRevision = (previous?.revision ?? 0) + 1
  return {
    change: {
      type: 'run.state',
      data: { runId, runRevision, stage, pending, watermarks, at }
    },
    runRevision
  }
}

/**
 * 组装数据水位：当前 journal 位置 + 指定课程各自的 revision。
 * 只记录，不参与并发判定（判定只看 runs[runId].revision）；课程不在档案里就跳过。
 *
 * @param {{state?: object}} archive 已打开的档案（或任何带 state 的对象）
 * @param {string[]} lessonIds
 * @returns {{lastSeq: number|null, lastHash: string|null, lessonRevisions: object}}
 */
export function watermarksOf(archive, lessonIds = []) {
  const state = archive?.state ?? {}
  const lessonRevisions = Object.create(null)
  for (const lessonId of lessonIds ?? []) {
    const revision = state.lessons?.[lessonId]?.revision
    if (Number.isInteger(revision) && revision > 0) lessonRevisions[lessonId] = revision
  }
  return { lastSeq: state.lastSeq ?? null, lastHash: state.lastHash ?? null, lessonRevisions }
}
