/* 教学根工具：学习者说「把这里当工作区」时，把档案与课程钉在他指定的目录里。
 *
 * 2026-10 的真实会话里，学习者让模型在会话下新建 teach-test 当工作区，结果档案落在
 * 会话根、课程落在 teach-test/、动画 staging 又落在会话根的 .dsh-teach-me —— 一个会话
 * 三个根，把 teach-test 拷走就丢了档案。这里给一个显式绑定点，默认行为不变。
 *
 * 解析优先级：配置 workspace.teachingRoot > 会话内绑定 > 会话工作区本身（见 workspace.js）。 */

import fs from 'node:fs'
import path from 'node:path'
import { archiveDirOf, legacyArchiveDirOf } from './archive/store.js'
import { atomicWrite, ensureRealDir } from './archive/util.js'
import { resolveSessionRoot, resolveTeachingRoot, teachingRootSource } from './workspace.js'

const BINDING_DIR = '.dsh-teach-me'
const BINDING_FILE = 'teaching-root.json'

function archiveStateOf(root) {
  for (const dir of [archiveDirOf(root), legacyArchiveDirOf(root)]) {
    try {
      if (fs.statSync(path.join(dir, 'journal')).isDirectory()) return 'ready'
    } catch {
      // 没有就看下一个候选（新布局优先，旧布局兜底）
    }
  }
  return 'missing'
}

function failure(text, error) {
  return { text, ok: false, error }
}

/**
 * 注册 teach_workspace。
 * @param {object} ctx 预设作用域上下文
 * @param {object} config 配置
 * @param {Function} workspaceOf 已解析教学根的工作区函数
 * @param {Function} getConfig 现取配置（拿 teachingRoot）
 * @returns {boolean} 是否注册成功
 */
export function registerWorkspaceTool(ctx, config, workspaceOf, getConfig) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return false
  if (config?.tools?.archive === false) return false

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_workspace',
        status: 'read',
        description:
          'Read or bind the teaching root for this session. status shows where the archive (.dsh-teach-me/archive) and lesson paths resolve today and why; ' +
          'bind points them at a directory the learner named ("use this folder as my workspace") so the archive lives next to the ' +
          'lessons instead of at the session root; unbind removes that binding. The plugin setting workspace.teachingRoot wins over ' +
          'a binding, so bind reports that instead of writing something that cannot take effect.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['status', 'bind', 'unbind'], description: 'status 只读；bind 绑定；unbind 解除绑定。' },
            path: { type: 'string', description: 'bind 必填：绝对路径，或相对会话工作区的子目录。' }
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'ok'],
            properties: {
              text: { type: 'string', description: '人读回执。' },
              ok: { type: 'boolean', description: '这次调用是否完成。' },
              error: { type: 'string', description: '失败代码。' },
              action: { type: 'string' },
              root: { type: 'string', description: '解析出来的教学根。' },
              sessionRoot: { type: 'string', description: '会话工作区。' },
              source: { type: 'string', description: 'config / binding / session。' },
              archive: { type: 'string', description: 'ready / missing。' }
            }
          },
          render: (_args, value) => [{ type: 'text', text: value.text }]
        },
        execute(args, exec) {
          const action = args?.action
          let sessionRoot
          try {
            sessionRoot = resolveSessionRoot(ctx, exec?.agent)
          } catch (error) {
            return failure('没有处理：' + (error instanceof Error ? error.message : String(error)), error?.code ?? 'workspace-unknown')
          }
          const settings = typeof getConfig === 'function' ? getConfig() : undefined
          const configured = typeof settings?.workspace?.teachingRoot === 'string' ? settings.workspace.teachingRoot.trim() : ''
          let root
          let source = 'session'
          try {
            root = resolveTeachingRoot(sessionRoot, { teachingRoot: configured })
            source = teachingRootSource(sessionRoot, { teachingRoot: configured })
          } catch (error) {
            // 绑定已失效时，仍要允许 bind/unbind 修复指针。
            if (action !== 'bind' && action !== 'unbind') {
              return failure('没有处理：' + error.message, error?.code ?? 'workspace-unknown')
            }
            root = sessionRoot
          }
          const base = { action, root, sessionRoot, source, archive: archiveStateOf(root) }

          if (action === 'status' || action === undefined) {
            const why = source === 'config' ? '（来自设置 workspace.teachingRoot）' : source === 'binding' ? '（来自会话内绑定）' : '（会话工作区本身）'
            return {
              ...base,
              ok: true,
              text:
                '教学根：' + root + why + '\n' +
                '会话工作区：' + sessionRoot + '\n' +
                '档案：' + (base.archive === 'ready' ? '已建立（.dsh-teach-me/archive）' : '还没有 .dsh-teach-me/archive') +
                (source === 'session' ? '\n课程放到子目录里时，档案就落在会话根；想让它跟着课程走，用 action:"bind" 指过去。' : '')
            }
          }

          if (action === 'bind') {
            if (configured !== '') {
              return failure('没有绑定：设置里固定了 workspace.teachingRoot=' + configured + '，它的优先级更高，绑定不会生效。要改就改设置。', 'config-wins')
            }
            const asked = typeof args?.path === 'string' ? args.path.trim() : ''
            if (asked === '') return failure('没有绑定：bind 需要 path（绝对路径或相对会话工作区的子目录）。', 'path-required')
            const target = path.isAbsolute(asked) ? asked : path.resolve(sessionRoot, asked)
            let stat
            try {
              stat = fs.statSync(target)
            } catch {
              return failure('没有绑定：目录不存在：' + asked, 'path-missing')
            }
            if (!stat.isDirectory()) return failure('没有绑定：不是目录：' + asked, 'path-not-directory')
            const bindingDir = path.join(sessionRoot, BINDING_DIR)
            try {
              ensureRealDir(bindingDir)
              atomicWrite(path.join(bindingDir, BINDING_FILE), JSON.stringify({ root: target, boundAt: new Date().toISOString() }, null, 2) + '\n')
            } catch (error) {
              return failure('没有绑定：' + error.message, 'bind-failed')
            }
            return {
              action,
              ok: true,
              root: target,
              sessionRoot,
              source: 'binding',
              archive: archiveStateOf(target),
              text:
                '教学根已绑到：' + target + '\n' +
                '之后档案（.dsh-teach-me/archive）与课程路径都相对它解析。' +
                (archiveStateOf(target) === 'missing' ? '这个目录还没有 .dsh-teach-me/archive，下一次发布课程时会建在那里。' : '')
            }
          }

          if (action === 'unbind') {
            const file = path.join(sessionRoot, BINDING_DIR, BINDING_FILE)
            const existed = [BINDING_FILE, 'workspace.json'].some((name) => fs.existsSync(path.join(sessionRoot, BINDING_DIR, name)))
            try {
              const bindingDir = path.dirname(file)
              // 不创建目录；存在时拒绝父目录链接，避免删除工作区外的指针。
              try {
                fs.lstatSync(bindingDir)
                ensureRealDir(bindingDir)
              } catch (error) {
                if (error?.code !== 'ENOENT') throw error
              }
              fs.rmSync(file, { force: true })
              fs.rmSync(path.join(bindingDir, 'workspace.json'), { force: true })
            } catch (error) {
              return failure('没有解除：' + (error instanceof Error ? error.message : String(error)), 'unbind-failed')
            }
            let next
            try {
              next = resolveTeachingRoot(sessionRoot, { teachingRoot: configured })
            } catch (error) {
              return failure('绑定已解除，但教学根仍无法解析：' + error.message, error?.code ?? 'workspace-unknown')
            }
            return {
              action,
              ok: true,
              root: next,
              sessionRoot,
              source: teachingRootSource(sessionRoot, { teachingRoot: configured }),
              archive: archiveStateOf(next),
              text: existed ? '已解除绑定，教学根回到：' + next : '本来就没有绑定，教学根仍是：' + next
            }
          }

          return failure('没有处理：action 只能是 status、bind 或 unbind。', 'bad-action')
        }
      }),
    'teach-me.tool(teach_workspace)'
  )
  return true
}
