/* 请求/课堂的集合与版本上下文。AsyncLocalStorage 保持并行任务隔离，不用进程级当前集合。 */
import { AsyncLocalStorage } from 'node:async_hooks'
const scopes = new AsyncLocalStorage()
export const learningScope = () => scopes.getStore() ?? {}
export const withLearningScope = (scope, task) => scopes.run(Object.freeze({ ...scope }), task)
export const DEFAULT_COLLECTION = 'default'
