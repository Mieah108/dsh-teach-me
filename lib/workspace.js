/* 工作区解析：工作区未知时必须明确失败，不再猜。
 *
 * 旧实现解析失败会依次退回 workingDirectory.defaultDirectory 和 process.cwd()。
 * 结果是写操作可能落在插件进程的启动目录，而不是学习者正在看的工作区（审计 R6）。
 * 现在只认「这条会话的 workingDirectory」：拿不到就抛 WorkspaceError，让工具把
 * 「先确认工作区」这句话原样交给模型，而不是静默写到别处。
 */

import fs from 'node:fs'
import path from 'node:path'

export class WorkspaceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WorkspaceError'
    this.code = 'workspace-unknown'
  }
}

function sessionOf(ctx, agent) {
  if (agent?.session !== undefined && agent.session !== null) return agent.session
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  return agents?.get?.(agent?.id)?.session
}

/**
 * 解析当前会话的工作区。
 * @param {object} ctx 运行期上下文
 * @param {object} [agent] 工具执行时的 agent
 * @returns {string} 绝对路径
 * @throws {WorkspaceError} 宿主没有目录服务、会话未就绪或目录为空
 */
export function resolveWorkspace(ctx, agent, options = {}) {
  return resolveTeachingRoot(resolveSessionRoot(ctx, agent), options)
}

/**
 * 只解析会话工作区（用户打开的那个目录），不套教学根。绑定/诊断要用它。
 * @param {object} ctx 运行期上下文
 * @param {object} [agent] 工具执行时的 agent
 * @returns {string} 绝对路径
 * @throws {WorkspaceError} 宿主没有目录服务、会话未就绪或目录为空
 */
export function resolveSessionRoot(ctx, agent) {
  const workingDirectory = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
  if (workingDirectory === undefined || workingDirectory === null || typeof workingDirectory.get !== 'function') {
    throw new WorkspaceError('宿主没有提供工作目录服务，无法定位学习工作区；先确认会话已经进入工作区。')
  }
  const session = sessionOf(ctx, agent)
  if (session === undefined || session === null) {
    throw new WorkspaceError('还不知道这条会话的工作区：先让学习者打开或指定一个工作区，再写课程与动画。')
  }
  let dir
  try {
    dir = workingDirectory.get(session)
  } catch (error) {
    throw new WorkspaceError(
      `工作目录服务读不到这条会话的工作区：${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new WorkspaceError('这条会话还没有工作区；先让学习者打开或指定一个工作区，再写课程与动画。')
  }
  return dir
}

/** 教学根指针放在会话工作区的隐藏目录里（学习者说「把这里当工作区」时写它）。
 *  和档案共用同一个 .dsh-teach-me：指针在会话根，档案在教学根，一个目录名、两种用途。 */
const BINDING_DIR = '.dsh-teach-me'
const BINDING_FILE = 'teaching-root.json'
/** 0.5.0 之前叫 workspace.json，读的时候兼容。 */
const LEGACY_BINDING_FILE = 'workspace.json'

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * 读会话里的教学根绑定。存在但损坏时明确失败，避免把后续写入重定向到会话根。
 * @param {string} sessionRoot 会话工作区
 * @returns {string|undefined} 绑定到的绝对路径
 */
export function readTeachingRootBinding(sessionRoot) {
  for (const name of [BINDING_FILE, LEGACY_BINDING_FILE]) {
    try {
      const raw = fs.readFileSync(path.join(sessionRoot, BINDING_DIR, name), 'utf8')
      const parsed = JSON.parse(raw)
      const root = parsed !== null && typeof parsed === 'object' && typeof parsed.root === 'string' ? parsed.root : ''
      if (root.trim().length === 0) throw new Error('缺少有效 root')
      return path.isAbsolute(root) ? root : path.resolve(sessionRoot, root)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw new WorkspaceError('教学根绑定读不出来（' + name + '）：' + error.message + '；请重新绑定或解除绑定。')
    }
  }
  return undefined
}

/**
 * 教学根解析：配置 > 会话内绑定 > 会话工作区本身。
 * 配了但不存在时明确失败，不退回去 —— 静默写错地方是这个插件栽过的跟头。
 * @param {string} sessionRoot 会话工作区
 * @param {{ teachingRoot?: string }} [options] 来自配置
 * @returns {string} 教学根绝对路径
 */
export function resolveTeachingRoot(sessionRoot, options = {}) {
  const configured = typeof options?.teachingRoot === 'string' ? options.teachingRoot.trim() : ''
  if (configured !== '') {
    const absolute = path.isAbsolute(configured) ? configured : path.resolve(sessionRoot, configured)
    if (!isDirectory(absolute)) throw new WorkspaceError('配置的教学根不存在或不是目录：' + configured)
    return absolute
  }
  const bound = readTeachingRootBinding(sessionRoot)
  if (bound !== undefined) {
    if (!isDirectory(bound)) throw new WorkspaceError('绑定的教学根不存在或不是目录：' + bound + '；请重新绑定或解除绑定。')
    return bound
  }
  return sessionRoot
}

/**
 * 教学根是从哪儿来的：config / binding / session。诊断与回执用。
 * @param {string} sessionRoot 会话工作区
 * @param {{ teachingRoot?: string }} [options] 来自配置
 * @returns {'config'|'binding'|'session'} 来源
 */
export function teachingRootSource(sessionRoot, options = {}) {
  const configured = typeof options?.teachingRoot === 'string' ? options.teachingRoot.trim() : ''
  if (configured !== '') return 'config'
  const bound = readTeachingRootBinding(sessionRoot)
  if (bound !== undefined) return 'binding'
  return 'session'
}

/** 只读场景用：解析不到就返回 undefined，由调用方给占位说明。 */
export function tryResolveWorkspace(ctx, agent, options = {}) {
  try {
    return resolveWorkspace(ctx, agent, options)
  } catch {
    return undefined
  }
}
