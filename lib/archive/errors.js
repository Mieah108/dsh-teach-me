/* 学习档案的错误类型：每种失败都要能让调用方区分「你的输入不对」「别人正在写」
 * 「文件坏了」和「版本落后」，而不是一律 throw new Error。 */

export class ArchiveError extends Error {
  constructor(message, code, detail) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

export class WorkspaceMissingError extends ArchiveError {
  constructor(dir) {
    super(`工作区不存在或不是目录：${dir}`, 'workspace-missing', { dir })
  }
}

export class ArchiveNotInitializedError extends ArchiveError {
  constructor(dir) {
    super(`这个工作区还没有学习档案（${dir}/.dsh-teach-me/archive）；先完成一次课程发布或提交再读档案。`, 'archive-not-initialized', { dir })
  }
}

export class LockHeldError extends ArchiveError {
  constructor(message, detail) {
    super(message, 'workspace-locked', detail)
  }
}

export class RevisionConflictError extends ArchiveError {
  constructor(expected, actual) {
    super(`档案已被别的写入推进：预期版本 ${expected}，现在 ${actual}。先重新读取再写。`, 'revision-conflict', { expected, actual })
  }
}

export class IdempotencyConflictError extends ArchiveError {
  constructor(key) {
    super(`幂等键 ${key} 已经用于另一份内容；不能静默覆盖旧提交。`, 'idempotency-conflict', { key })
  }
}

/** commit 在执行期发现档案事实与预检不符（TOCTOU）。code 是具体的失败原因。 */
export class CommitRejectedError extends ArchiveError {
  constructor(code, message, detail) {
    super(message, code, detail)
  }
}

export class JournalCorruptionError extends ArchiveError {
  constructor(message, detail) {
    super(message, 'journal-corruption', detail)
  }
}

export class UnsupportedSchemaError extends ArchiveError {
  constructor(found, supported) {
    super(`档案 schema 版本 ${found} 比这个插件支持的 ${supported} 新；升级插件或使用备份回滚，不能直接降级读。`, 'schema-unsupported', {
      found,
      supported
    })
  }
}

export class ValidationError extends ArchiveError {
  constructor(message, detail) {
    super(message, 'validation', detail)
  }
}

/** 每个错误码对应的「在哪一步、能不能重试、下一步做什么」。表里没有的码按不可恢复处理。 */
const ERROR_PLANS = {
  'content-changed': { step: 'publish', recoverable: true, nextAction: 'rerun-precheck' },
  'assets-changed': { step: 'publish', recoverable: true, nextAction: 'rerun-precheck' },
  'question-revision-changed': { step: 'register', recoverable: true, nextAction: 'rerun-precheck' },
  validation: { step: 'precheck', recoverable: true, nextAction: 'fix-input' },
  'workspace-unknown': { step: 'precheck', recoverable: true, nextAction: 'confirm-workspace' },
  'workspace-missing': { step: 'precheck', recoverable: true, nextAction: 'confirm-workspace' },
  'archive-not-initialized': { step: 'precheck', recoverable: true, nextAction: 'publish-first' },
  'revision-conflict': { step: 'commit', recoverable: true, nextAction: 'reload-archive' },
  'idempotency-conflict': { step: 'idempotency', recoverable: false, nextAction: 'use-new-key' },
  'workspace-locked': { step: 'commit', recoverable: true, nextAction: 'retry-later' },
  'journal-corruption': { step: 'precheck', recoverable: false, nextAction: 'repair-archive' },
  'schema-unsupported': { step: 'precheck', recoverable: false, nextAction: 'upgrade-plugin' }
}

/**
 * 把错误翻译成结构化回执：commit 用它，旧工具暂不接（§4.3 Q-C4：分批跟进）。
 * @returns {{code: string, step: string, cause: string, recoverable: boolean, nextAction: string}}
 */
export function describeError(error) {
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'error'
  const plan = ERROR_PLANS[code] ?? { step: 'unknown', recoverable: false, nextAction: 'report' }
  return {
    code,
    step: plan.step,
    cause: error instanceof Error ? error.message : String(error),
    recoverable: plan.recoverable,
    nextAction: plan.nextAction
  }
}
