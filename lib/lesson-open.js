import { learningScope } from './archive/learning-scope.js'
/* 发布后定位课程。模型直接调用原生 sidebar_open，宿主负责记录和权限审查；
 * 工具不可用时，从「教学模式 · 选课」打开。 */

import path from 'node:path'
import { openArchive } from './archive/store.js'
import { pruneEmpty } from './archive/util.js'
import { isAutoReview } from './permission.js'

const SIDEBAR_TOOL = 'sidebar_open'

function failure(text, error) {
  return { text, ok: false, error, opened: false }
}

/** 最近发布的一课（没有显式 lessonId 时用）。 */
function latestLesson(state) {
  const lessons = Object.values(state.lessons)
  if (lessons.length === 0) return undefined
  return lessons.sort((left, right) => String(right.publishedAt ?? '').localeCompare(String(left.publishedAt ?? '')))[0]
}

/**
 * 注册 teach_lesson_open。
 * @param {object} ctx 预设作用域上下文
 * @param {object} config 配置
 * @param {Function} workspaceOf 解析当前会话工作区
 * @returns {boolean} 是否注册成功
 */
export function registerLessonOpenTool(ctx, config, workspaceOf) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return false
  if (config?.tools?.archive === false) return false

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_lesson_open',
        description:
          'Resolve the sidebar target for one published lesson after teach_commit, or after publish and question registration. ' +
          'If the receipt includes a plan and sidebar_open is visible, call the native sidebar_open tool once with target and title from the plan. ' +
          'Otherwise, or if sidebar_open fails, tell the learner to open the lesson from the sidebar lesson list.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            lessonId: { type: 'string', description: '要打开的课程 id；省略时打开最近发布的一课。' }
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'ok', 'opened'],
            properties: {
              text: { type: 'string', description: '人读回执。' },
              ok: { type: 'boolean', description: '这次调用本身是否完成（不代表一定弹出）。' },
              opened: { type: 'boolean', description: '是否真的让侧栏打开了课程。' },
              via: { type: 'string', description: '打开方式：plan（由模型调用原生工具）或 none（从选课页打开）。' },
              reason: { type: 'string', description: '原因代码：sidebar-open-ready / auto-review / sidebar-open-unavailable / collection-changed。' },
              plan: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'target'],
                description: '直接调用原生 sidebar_open。只把 target 和 title 作为参数。',
                properties: {
                  name: { type: 'string', description: '要派发的工具名，固定 sidebar_open。' },
                  target: { type: 'string', description: '传给 sidebar_open 的 target（课程 HTML 绝对路径）。' },
                  title: { type: 'string', description: '传给 sidebar_open 的 title。' }
                }
              },
              lessonId: { type: 'string' },
              title: { type: 'string' },
              path: { type: 'string', description: '工作区相对路径。' },
              error: { type: 'string' }
            }
          },
          render: (_args, value) => [{ type: 'text', text: value.text }]
        },
        async execute(args, exec) {
          const requested = typeof args?.lessonId === 'string' && args.lessonId.length > 0 ? args.lessonId : null
          let root
          try {
            root = workspaceOf(exec?.agent)
          } catch (error) {
            return failure('没有打开：' + (error instanceof Error ? error.message : String(error)), error?.code ?? 'workspace-unknown')
          }
          let archive
          try {
            archive = openArchive(root, { create: false })
          } catch (error) {
            return failure('没有打开：这条会话还没有学习档案。' + (error instanceof Error ? error.message : String(error)), 'archive-missing')
          }
          const lesson = requested === null ? latestLesson(archive.state) : archive.state.lessons[requested]
          if (lesson === undefined) {
            return failure(
              requested === null ? '没有打开：档案里还没有已发布课程，先用 teach_lesson_publish 发布。' : '没有打开：课程 ' + requested + ' 还没发布。',
              'lesson-not-found'
            )
          }

          const target = path.join(root, lesson.path)
          const base = { lessonId: lesson.id, title: lesson.title, path: lesson.path }
          // 通用 sidebar_open 只接受文件路径，无法携带集合上下文；切换后不误开同路径的另一集合。
          const preferences = ctx.get?.('teachPreferences')
          if (preferences && learningScope().collectionId) {
            const saved = await preferences.ensure(exec?.agent?.session?.id ?? exec?.agent?.id)
            const selected = saved.collections[archive.root] ?? 'default'
            if (selected !== learningScope().collectionId) return {
              ...base, ok: true, opened: false, via: 'none', reason: 'collection-changed',
              text: '课程已保存在本次请求的原教学集合 ' + learningScope().collectionId + '。当前会话已切换集合；请在选课页选择原集合后打开，不重定向本次发布。'
            }
          }
          const sidebar = tools.get?.(SIDEBAR_TOOL, exec?.agent, exec?.toolSet)
          if (sidebar === undefined) {
            return pruneEmpty({
              ...base,
              text:
                '课程 ' + lesson.id + ' 已发布，但当前宿主没有可被模型驱动的侧栏（缺 ' + SIDEBAR_TOOL + ' 工具），所以没有自动弹出。' +
                '告诉学习者：从侧栏「教学模式 · 选课」里点「打开」，或在文件树里打开 ' + lesson.path + '。',
              ok: true,
              opened: false,
              via: 'none',
              reason: 'sidebar-open-unavailable'
            })
          }
          return pruneEmpty({
            ...base,
            text: '课程 ' + lesson.id + ' 已发布。请直接调用原生 sidebar_open，只传 plan 中的 target 和 title。' +
              '若工具不可用或调用失败，请让学习者从侧栏「教学模式 · 选课」打开。',
            ok: true,
            opened: false,
            via: 'plan',
            reason: isAutoReview(ctx, exec?.agent?.session) ? 'auto-review' : 'sidebar-open-ready',
            plan: { name: SIDEBAR_TOOL, target, title: lesson.title }
          })
        }
      }),
    'teach-me.tool(teach_lesson_open)'
  )
  return true
}
