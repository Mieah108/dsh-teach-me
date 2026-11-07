/* 产线账本：把「这一步花了多少步」变成可读的数字（ADR-0005）。
   数动作：调用次数、单文件改了几次、渲染几次、问了几次。
   0.6.3-A 起再记三类不同的成本，分开报、不合并：
   1. 工具输出 UTF-8 字节（Buffer.byteLength(JSON.stringify(result),'utf8')，按工具名分组）；
   2. 调用轮次（决策步 = 根调用 / 子调用）与失败、失败后重试；
   3. token 与缓存：只读宿主已上报的 sessionProjections.tokenUsage，
      读不到就写「不可观测」，绝不拿字节换算 token。
   报告只做参考线，不做门禁 —— 超标是让人看一眼，不是拦住人。

   0.6.1 补了四件让报告不再骗人的事：
   1. 进行中：pre-execute 记、result 删，报告里不会再把报表自己的调用显示成「成功 0」；
   2. 失败按「树」去重：嵌套子调用失败与父 run_code 失败是同一棵树上的同一次事故；
   3. 「目标形状」只在「成片 1 次且成功 + still 全过」时说，其余情况分级说清楚；
   4. 脚本改动：bash 里跑脚本/重定向改的文件无法逐次归因，用一次有界 mtime 扫描补上
      「哪些文件被脚本改过」，并把它计入 editBudget 参考线。 */

import fs from 'node:fs'
import path from 'node:path'
import { clip } from './util.js'

/** mtime 扫描的上限：文件数与深度都封顶，报告是参考线，不做全盘遍历。 */
const SCAN_MAX_FILES = 2000
const SCAN_MAX_DEPTH = 4
/** 扫描时跳过的目录：依赖、版本库、档案/中间目录、构建产物。 */
const SCAN_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage'])

const toPosix = (value) => String(value).split(path.sep).join('/')

/** token 的四个桶：彼此不重叠（reasoning 已含在 outputTokens 里）。 */
export const TOKEN_BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/** 宿主没暴露 token 时逐字用这句话：不猜、不用字节换算。 */
export const TOKEN_UNOBSERVABLE = 'token：不可观测（宿主未向插件作用域暴露）'

/**
 * 一次工具结果的上下文成本，单位 UTF-8 字节。
 * 口径固定为 Buffer.byteLength(JSON.stringify(result), 'utf8')：不是 String.length，也不用默认编码。
 * 序列化失败（循环引用等）返回 undefined —— 宁可少记一条，也不猜一个数。
 * @param {unknown} result tools/result 的结果对象
 * @returns {number|undefined}
 */
export function toolResultBytes(result) {
  try {
    return Buffer.byteLength(JSON.stringify(result), 'utf8')
  } catch {
    return undefined
  }
}

/** 四个桶都是有限数字才算一次可用的用量样本。 */
function isUsageView(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    TOKEN_BUCKETS.every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
  )
}

/**
 * 读宿主已上报的 token 用量（累计到当前日志尾）。读不到返回 undefined。
 *
 * 两个读面都试，谁先给全四桶就用谁：
 *  1. sessionProjections.stateOf(session,'tokenUsage') 的原始状态 —— { totals, last }；
 *  2. sessionProjections.snapshot(session,['tokenUsage']) 的 wire view —— 四桶扁平。
 * 任一读面缺失、抛错、或形状不对都算「不可观测」，不拿别的东西换算。
 *
 * @param {object|undefined} projections ctx.get('sessionProjections')
 * @param {object|undefined} session 会话（exec.agent.session）
 * @returns {{uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}|undefined}
 */
export function tokenUsageOf(projections, session) {
  if (projections === null || projections === undefined || typeof projections !== 'object') return undefined
  if (session === undefined || session === null) return undefined
  try {
    if (typeof projections.stateOf === 'function') {
      const state = projections.stateOf(session, 'tokenUsage')
      if (isUsageView(state?.totals)) return state.totals
      if (isUsageView(state)) return state
    }
  } catch {
    // 投影没注册或读面变了：再试 snapshot
  }
  try {
    if (typeof projections.snapshot === 'function') {
      const view = projections.snapshot(session, ['tokenUsage'])?.values?.tokenUsage
      if (isUsageView(view)) return view
    }
  } catch {
    // 读不到就是不可观测
  }
  return undefined
}

/**
 * token 段的文案：可得就分开报四桶，不可得就用固定那句话。
 * @param {object|undefined} usage tokenUsageOf 的返回值
 * @returns {string}
 */
export function tokenCostLine(usage) {
  if (usage === undefined) return TOKEN_UNOBSERVABLE
  return (
    `token：未缓存输入 ${usage.uncachedInputTokens} / 输出 ${usage.outputTokens} / ` +
    `缓存读 ${usage.cacheReadTokens} / 缓存写 ${usage.cacheWriteTokens}（宿主 sessionProjections.tokenUsage，累计到当前日志尾；` +
    'token、字节、缓存、轮次是四类成本，不做换算）。'
  )
}

function shorten(file) {
  if (typeof file !== 'string' || file.length === 0) return '?'
  const parts = file.split('/')
  return parts.length <= 2 ? file : parts.slice(-2).join('/')
}

/** 报告里用来和扫描结果对账的「尾巴」：write/edit 记的是参数里的原始路径，可能是绝对路径。 */
function tailOf(file) {
  return toPosix(String(file)).split('/').slice(-2).join('/')
}

/* 「这次 bash 大概率在改文件」的判据。只用来数次数（改到哪个文件归因不了），
   所以宁可窄一点：误报会让人以为脚本改了很多，比漏报更误导。 */
const SCRIPT_WRITE_PATTERNS = [
  // 解释器跑脚本文件：python3 /tmp/x.py、node build.mjs、bash push.sh
  /\b(?:python3?|node|bun|deno)\s+[^\s;|&]+\.(?:py|mjs|cjs|js|ts|tsx)\b/,
  /\b(?:ba|z|da|k)?sh\s+[^\s;|&]+\.sh\b/,
  // 输出重定向（排除只往 /dev/null 丢日志的）
  /(?:^|[^0-9&>])>>?\s*(?!\/dev\/null\b)(?:"[^"]+"|'[^']+'|[^\s;|&<>]+)/,
  /\|\s*tee\s+(?!\/dev\/null\b)\S+/,
  // 原地改文件
  /\bsed\s+-i\b/,
  /\bperl\s+-i\b/,
  /\b(?:cp|mv|rm|install|ln|truncate)\s+/,
  /\bgit\s+(?:apply|checkout|restore|reset)\b/
]

/**
 * 这条 bash 命令是否可能在改文件（脚本/重定向/原地编辑）。
 * @param {string} command 工具参数里的 command
 * @returns {boolean}
 */
export function looksLikeScriptWrite(command) {
  if (typeof command !== 'string' || command.length === 0) return false
  return SCRIPT_WRITE_PATTERNS.some((pattern) => pattern.test(command))
}

/**
 * 有界 mtime 扫描：会话开始（账本创建）之后被改过的工作区文件。
 * 用来把「脚本改了什么」补进报告；任何一步失败都只返回已扫到的部分，绝不抛错。
 * @param {string} root 教学根
 * @param {number} sinceMs 账本创建时间（ms）
 * @returns {string[]} 工作区相对路径（posix、已排序、去重）
 */
export function scanTouchedFiles(root, sinceMs) {
  const found = []
  const seen = new Set()
  const since = Number.isFinite(sinceMs) ? sinceMs : 0
  const walk = (dir, depth) => {
    if (found.length >= SCAN_MAX_FILES) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= SCAN_MAX_FILES) return
      const name = entry.name
      // 点号目录/文件：档案、git、编辑器临时文件都不算「课程里被改过的文件」
      if (name.startsWith('.')) continue
      if (SCAN_SKIP_DIRS.has(name)) continue
      const absolute = path.join(dir, name)
      if (entry.isDirectory()) {
        if (depth < SCAN_MAX_DEPTH) walk(absolute, depth + 1)
        continue
      }
      // 符号链接不算：不知道它指向哪里，不替它下结论
      if (!entry.isFile()) continue
      let stat
      try {
        stat = fs.statSync(absolute)
      } catch {
        continue
      }
      if (stat.mtimeMs < since) continue
      const relative = toPosix(path.relative(root, absolute))
      if (relative.length === 0 || seen.has(relative)) continue
      seen.add(relative)
      found.push(relative)
    }
  }
  walk(root, 1)
  return found.sort()
}

/**
 * 创建账本：内存里的 per-agent 计数。
 * @returns {{attach: Function, noteAsk: Function, snapshot: Function}}
 */
export function createLedger(getConfig) {
  const agents = new Map()

  const stateFor = (agentId) => {
    const key = String(agentId ?? '')
    let state = agents.get(key)
    if (state === undefined) {
      state = {
        at: Date.now(),
        calls: new Map(),
        okCalls: new Map(),
        files: new Map(),
        renders: 0,
        renderOk: 0,
        stills: 0,
        stillOk: 0,
        asks: 0,
        answeredAsks: 0,
        questions: 0,
        failures: 0,
        steps: 0,
        subCalls: 0,
        // 已派发、还没结算的调用：callId -> 工具名。报表据此标「进行中」。
        inflight: new Map(),
        // 每棵树只记第一次失败的工具名：rootCallId -> name（子调用先到，所以嵌套失败优先）。
        firstFailByTree: new Map(),
        // 失败树集合：一次事故（嵌套失败 + 父 run_code 失败）只算一棵。
        failedRoots: new Set(),
        // 按工具名的原始失败次数（同一棵树里失败两次就记两次）。
        rawFails: new Map(),
        // 每棵树第一次失败的工具名计数（报表「最先失败的是」用）。
        failCalls: new Map(),
        // bash 里跑脚本/重定向改文件的调用次数（改到哪个文件归因不了）。
        scripts: 0,
        // auto 权限下审查通道吞掉/拒绝的调用次数。
        reviewFailures: 0,
        // 工具输出字节：name -> UTF-8 字节合计；name -> 已结算的结果条数。
        // 只算真正落地过的结果（失败回执也算：它同样进入模型的上下文）。
        outBytes: new Map(),
        outResults: new Map(),
        // 失败后重试：同一工具名出现过失败之后又被调用一次，就记 1 次重试。
        retries: 0,
        retryByName: new Map()
      }
      agents.set(key, state)
    }
    return state
  }

  const bump = (map, key, field) => {
    const current = map.get(key) ?? { write: 0, edit: 0, read: 0 }
    current[field] = (current[field] ?? 0) + 1
    map.set(key, current)
  }

  const bumpCount = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)

  const callKeyOf = (execution) => {
    const key = execution?.callId
    return typeof key === 'string' && key.length > 0 ? key : undefined
  }

  const recordCall = (execution) => {
    const name = String(execution?.name ?? '')
    const args = execution?.arguments ?? {}
    const state = stateFor(execution?.agent?.id)
    state.calls.set(name, (state.calls.get(name) ?? 0) + 1)
    const callKey = callKeyOf(execution)
    if (callKey !== undefined) state.inflight.set(callKey, name)

    // 步 = 根调用（模型的一次工具往返）；run_code 里的嵌套调用算子调用。
    // 上一次报告把 209 个子调用当成 209 步，误导了成本判断，这里分开数。
    const isRootCall = execution?.parent === undefined || execution?.parent === null
    if (isRootCall) state.steps += 1
    else state.subCalls += 1

    // 重试只在「这个名字已经失败过」之后才算：失败的下一步再调它就是在重试。
    if ((state.rawFails.get(name) ?? 0) > 0) {
      state.retries += 1
      bumpCount(state.retryByName, name)
    }

    const file = typeof args?.file_path === 'string' ? args.file_path : typeof args?.path === 'string' ? args.path : undefined
    if (file !== undefined) {
      if (name === 'write') bump(state.files, file, 'write')
      else if (name === 'edit') bump(state.files, file, 'edit')
      else if (name === 'read') bump(state.files, file, 'read')
    }

    const command = typeof args?.command === 'string' ? args.command : ''
    if (command.length > 0) {
      if (/\bremotion\s+render\b/.test(command)) state.renders += 1
      if (/\bremotion\s+still\b/.test(command)) state.stills += 1
    }
    // 只有 bash 的参数里带 command；run_code 里嵌套的 bash 也是子派发，args 原样可见。
    if (name === 'bash' && looksLikeScriptWrite(command)) state.scripts += 1
    if (name === 'teach_animation_render') {
      if (args?.mode === 'still') state.stills += 1
      else state.renders += 1
    }
    if (name === 'ask_user_question') {
      state.asks += 1
      state.questions += Array.isArray(args?.questions) ? args.questions.length : 0
    }
  }

  /** auto-review 的错误文案（宿主侧固定措辞）：被审查通道吞掉，或被审查判据拒绝。 */
  const isReviewFailure = (message, info) => {
    if (info !== null && typeof info === 'object' && info.code === 'AUTO_REVIEW_DENIED') return true
    if (typeof message !== 'string') return false
    return /Auto review of tool\b.*\bfailed\b/.test(message) || /Auto review rejected tool\b/.test(message)
  }

  /** 结算一次工具结果：只有没报错才算成功；账本不把尝试当产出。 */
  const recordResult = (execution, result) => {
    const name = String(execution?.name ?? '')
    const args = execution?.arguments ?? {}
    const state = stateFor(execution?.agent?.id)
    const callKey = callKeyOf(execution)
    if (callKey !== undefined) state.inflight.delete(callKey)

    // 字节先记、再看成败：失败回执也会进上下文，不能只统计成功的。
    const bytes = toolResultBytes(result)
    if (bytes !== undefined) {
      state.outBytes.set(name, (state.outBytes.get(name) ?? 0) + bytes)
      state.outResults.set(name, (state.outResults.get(name) ?? 0) + 1)
    }

    if (result?.isError === true) {
      state.failures += 1
      bumpCount(state.rawFails, name)

      // 一次事故 = 一棵调用树：嵌套子调用先失败，父 run_code 再失败也是同一棵树。
      const tree = execution?.rootCallId ?? execution?.callId
      const treeKey = typeof tree === 'string' && tree.length > 0 ? tree : name
      if (!state.failedRoots.has(treeKey)) {
        state.failedRoots.add(treeKey)
        state.firstFailByTree.set(treeKey, name)
        bumpCount(state.failCalls, name)
      }

      const message = result?.error?.message
      if (isReviewFailure(message, result?.error?.info)) state.reviewFailures += 1
      return
    }
    state.okCalls.set(name, (state.okCalls.get(name) ?? 0) + 1)
    const command = typeof args?.command === 'string' ? args.command : ''
    if (name === 'teach_animation_render') {
      if (args?.mode === 'still') state.stillOk += 1
      else state.renderOk += 1
    }
    if (/\bremotion\s+render\b/.test(command)) state.renderOk += 1
    if (/\bremotion\s+still\b/.test(command)) state.stillOk += 1
    if (name === 'ask_user_question' && Array.isArray(result?.value?.answers) && result.value.answers.length > 0) {
      state.answeredAsks += 1
    }
  }

  return {
    attach(ctx) {
      if (!getConfig().ledger.enabled) return
      try {
        // tools/pre-execute 是 waterfall：必须调用并返回 next()。
        // 如果这个监听器返回 undefined，这一趟的 gate 就是 undefined，
        // 调度层读 gate.kind 会抛 "Cannot read properties of undefined
        // (reading 'kind')"，症状是整个 run_code 程序全线失败。
        ctx.on('tools/pre-execute', (execution, next) => {
          try {
            recordCall(execution)
          } catch {
            // 账本只做统计，绝不影响工具执行
          }
          return next()
        })
        // tools/result 是最终结果（含失败），用它区分「尝试过」和「真的成了」。
        ctx.on('tools/result', (execution, result) => {
          try {
            recordResult(execution, result)
          } catch {
            // 统计失败不影响工具结果
          }
        })
      } catch {
        // 事件不可用就退化成只有 teach_report 里的静态提醒
      }
    },
    noteAsk(agentId, count) {
      const state = stateFor(agentId)
      state.asks += 1
      state.questions += Number(count) || 0
    },
    snapshot(agentId) {
      return stateFor(agentId)
    }
  }
}

/** 每个工具名还在跑的调用数（进行中）。 */
function pendingByTool(state) {
  const pending = new Map()
  for (const name of state.inflight.values()) pending.set(name, (pending.get(name) ?? 0) + 1)
  return pending
}

/**
 * 渲染形状：只有「成片 1 次且成功 + still 至少 1 次且全过」才叫目标形状。
 * 其余情况分级说清楚，别用一句话盖过去（still 9/10 也曾经被判成「目标形状」）。
 * @param {object} state 账本状态
 * @returns {string[]} 一到多行
 */
export function renderShapeLines(state) {
  const attempts = state.renders
  const ok = state.renderOk
  const stills = state.stills
  const stillOk = state.stillOk
  const facts = `渲染 ${attempts} 次（成功 ${ok}），still 预检 ${stills} 次（成功 ${stillOk}）`
  if (attempts === 0 && stills === 0) {
    return ['这一课没有渲染或 still 记录：不做动画就是常态；做了动画却没记录时，检查是不是在 bash 里直接跑了 remotion（账本只认 teach_animation_render 与 remotion still/render 命令）。']
  }
  const targetShape = attempts === 1 && ok === 1 && stills >= 1 && stillOk === stills
  const lines = [facts + (targetShape ? ' —— 这就是目标形状：still 全过、成片只渲一次。' : '。')]
  if (targetShape) return lines
  if (attempts > 1) lines.push(`重渲了 ${attempts} 次（只成功 ${ok} 次）：成片只该渲一次；重渲前先把 gating 的错全改完。`)
  else if (attempts === 1 && ok === 0) lines.push('渲染了一次但没成功：先看日志里的第一个错，别连着再渲。')
  else if (attempts === 0) lines.push('还没有渲成片：still 预检过了再召一次 teach_animation_render。')
  if (stills === 0) {
    if (attempts > 0) lines.push('没有 still 预检记录：成片是盲渲的；下一次先抽首帧、每拍中段、转场中点、末帧再渲。')
  } else if (stillOk !== stills) {
    lines.push(`still 有失败：尝试 ${stills} 次、成功 ${stillOk} 次（${stills - stillOk} 次没出图）；先把预检里的错改完再渲成片。`)
  }
  return lines
}

/**
 * 注册 teach_report：交付前把账本摊开，顺带过一遍产线判据。
 * @param {object} ctx 预设作用域上下文
 * @param {() => object} getConfig 现取配置
 * @param {object} ledger createLedger 的返回值
 * @param {object} [stageTool] registerStageTool 的返回值（给「当前阶段」一行）
 * @param {(agent: object) => string} [workspaceOf] 解析教学根：只用于脚本改动的 mtime 归因，拿不到就跳过
 */
export function registerReportTool(ctx, getConfig, ledger, stageTool, workspaceOf) {
  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
  const initial = getConfig()
  if (!initial.tools.report || tools === undefined || tools === null) return

  /** 教学根：解析不到就返回 undefined，绝不让报告失败。 */
  const workspaceFor = (agent) => {
    if (typeof workspaceOf !== 'function') return undefined
    try {
      const root = workspaceOf(agent)
      return typeof root === 'string' && root.length > 0 ? root : undefined
    } catch {
      return undefined
    }
  }

  /** 宿主投影服务：读不到就返回 undefined（token 段会写「不可观测」，不猜）。 */
  const projectionsOf = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('sessionProjections') : ctx.sessionProjections
    } catch {
      return undefined
    }
  }

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_report',
        description:
          'Report the production ledger for this session before delivering: steps (root tool calls), sub-calls, ' +
          'tool mix with successes, failures and calls still running, how many call trees failed, how many times each ' +
          'file was edited (plus files touched by bash scripts, attributed by mtime), renders and stills with the ' +
          'render-shape verdict, questions asked. Reads from the plugin, costs nothing, and is meant to be read once at the end.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['text', 'steps'],
            properties: {
              text: { type: 'string', description: '人读报告。' },
              steps: { type: 'integer', description: '根调用步数（模型往返次数）。' }
            }
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
        },
        async execute(_args, exec) {
          const state = ledger.snapshot(exec?.agent?.id)
          const total = [...state.calls.values()].reduce((sum, count) => sum + count, 0)
          const steps = state.steps > 0 ? state.steps : Math.max(0, total - state.subCalls)
          const minutes = Math.max(1, Math.round((Date.now() - state.at) / 60000))
          const lines = [
            `账本：${steps} 步（根调用）· ${state.subCalls} 个子调用，${minutes} 分钟（会话内统计，重启即清零）。`,
            '',
            '步的定义：每个根工具调用算一步；嵌套子调用单独记录。'
          ]

          const live = getConfig()
          const pending = pendingByTool(state)
          const failByName = state.rawFails ?? new Map()
          const callList = [...state.calls.entries()].sort((left, right) => right[1] - left[1])
          lines.push(
            '调用分布：' +
              (callList.length === 0
                ? '（还没有调用）'
                : callList
                    .map(([name, count]) => {
                      const ok = state.okCalls.get(name) ?? 0
                      const failed = failByName.get(name) ?? 0
                      // 进行中只数「已派发、还没结算」的调用；被 pre-execute 拒掉的不在这里（见下方单独一行）。
                      const running = pending.get(name) ?? 0
                      return failed === 0 && running === 0
                        ? `${name}×${count}（成功 ${ok}）`
                        : `${name}×${count}（成功 ${ok}、失败 ${failed}、进行中 ${running}）`
                    })
                    .join('、'))
          )

          if (state.failedRoots.size > 0) {
            const firstFails = [...state.failCalls.entries()].sort((left, right) => right[1] - left[1])
            lines.push(
              `其中 ${state.failures} 次调用报错/被拒，来自 ${state.failedRoots.size} 棵树（同一次事故的嵌套与父调用算一棵）；` +
                `最先失败的是：${firstFails.map(([name, count]) => `${name}×${count}`).join('、')}。失败的尝试不当作完成。`
            )
          } else if (state.failures > 0) {
            // 理论上不会出现：失败一定归属于某棵树。保底别把数字吞掉。
            lines.push(`其中 ${state.failures} 次调用报错/被拒；失败的尝试不当作完成。`)
          }
          if (state.reviewFailures > 0) {
            lines.push(
              `其中 ${state.reviewFailures} 次是 auto 权限的审查通道吞掉/拒绝的（不是你写错）：续跑时把同一次调用重发一次通常就好；` +
                '连续发生就请学习者用 /permission 换回 ask 或 workspace-write。'
            )
          }
          // 被 auto 审查（或别的闸门）在 pre-execute 阶段拒掉的调用从来没进过 calls，
          // 但 result 会来：这类失败只算在失败里，单独点名，别让「调用分布」看起来自相矛盾。
          const allNames = new Set([...state.calls.keys(), ...failByName.keys()])
          let unrecorded = 0
          for (const name of allNames) {
            const count = state.calls.get(name) ?? 0
            const ok = state.okCalls.get(name) ?? 0
            const running = pending.get(name) ?? 0
            const failedCount = failByName.get(name) ?? 0
            unrecorded += Math.max(0, failedCount - Math.max(0, count - ok - running))
          }
          if (unrecorded > 0) {
            lines.push(`另有 ${unrecorded} 次失败没有对应的调用记录（pre-execute 就被拒了：auto 审查或闸门），只算在失败里。`)
          }

          // 工具输出成本：字节、token、缓存、轮次四类分开写，不合并成一个节省百分比。
          // 字节口径固定 UTF-8（见 toolResultBytes）；token 只读宿主上报，读不到就逐字写不可观测。
          const byteTotal = [...state.outBytes.values()].reduce((sum, bytes) => sum + bytes, 0)
          const resultTotal = [...state.outResults.values()].reduce((sum, count) => sum + count, 0)
          const byteTop = [...state.outBytes.entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 5)
          const retryList = [...(state.retryByName ?? new Map()).entries()]
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 5)
          lines.push('', "工具输出成本（UTF-8 字节，口径 Buffer.byteLength(JSON.stringify(result),'utf8')）：")
          lines.push(
            resultTotal === 0
              ? '- 合计 0 B：还没有已结算的工具结果。'
              : `- 合计 ${byteTotal} B，来自 ${resultTotal} 次结果（失败回执也算：它同样进入上下文）。`
          )
          lines.push(
            byteTop.length === 0
              ? '- Top 5：（无）'
              : '- Top 5：' +
                  byteTop.map(([name, bytes]) => `${name} ${bytes} B×${state.outResults.get(name) ?? 0}`).join('、')
          )
          lines.push(
            `- 调用轮次：决策步 ${steps}（根调用）/ 子调用 ${state.subCalls}；失败 ${state.failures} 次，` +
              `失败后重试 ${state.retries} 次` +
              (retryList.length > 0 ? `（${retryList.map(([name, count]) => `${name}×${count}`).join('、')}）` : '') +
              '。重试 = 同一工具名失败之后又被调用一次。'
          )
          const tokenUsage = tokenUsageOf(projectionsOf(), exec?.agent?.session)
          lines.push(tokenCostLine(tokenUsage))

          // 文件表：write/edit 计数 + bash 脚本改动的 mtime 归因（后者次数未知，按 ≥1 次算）。
          // 同一个文件可能被用绝对路径和相对路径各写过一次：按显示名合并，别在表里出现两行同名。
          const byDisplay = new Map()
          for (const [file, counts] of state.files.entries()) {
            const write = counts.write ?? 0
            const edit = counts.edit ?? 0
            if (write + edit === 0) continue
            const display = shorten(file)
            const current = byDisplay.get(display) ?? { file: display, write: 0, edit: 0, script: false, tails: new Set() }
            current.write += write
            current.edit += edit
            current.tails.add(tailOf(file))
            byDisplay.set(display, current)
          }
          const touched = [...byDisplay.values()]
          const knownTails = new Set([...byDisplay.values()].flatMap((item) => [...item.tails]))
          const root = workspaceFor(exec?.agent)
          let scriptFiles = []
          let scanSkipped = false
          if (state.scripts > 0 || touched.length > 0) {
            if (root === undefined) scanSkipped = state.scripts > 0
            else scriptFiles = scanTouchedFiles(root, state.at).filter((relative) => !knownTails.has(tailOf(relative)))
          }
          const rows = [
            ...touched.map(({ tails, ...item }) => ({ ...item, edits: item.write + item.edit, total: item.write + item.edit })),
            ...scriptFiles.map((relative) => ({
              key: relative,
              file: shorten(relative),
              write: 0,
              edit: 0,
              script: true,
              edits: 0,
              total: 1
            }))
          ].sort((left, right) => right.total - left.total || left.file.localeCompare(right.file))
          if (rows.length > 0) {
            lines.push('', '改过的文件：')
            for (const item of rows.slice(0, 12)) {
              lines.push(
                `- ${item.file}：` +
                  (item.script
                    ? state.scripts > 0
                      ? '写 0 次、改 0 次（脚本改过，次数未知，按 mtime 归因）'
                      : '写 0 次、改 0 次（会话内被改过、没有 write/edit 记录，次数未知，按 mtime 归因）'
                    : `写 ${item.write} 次、改 ${item.edit} 次`)
              )
            }
            if (rows.length > 12) lines.push(`  （还有 ${rows.length - 12} 个文件没逐条列出）`)
          }
          if (state.scripts > 0) {
            lines.push(
              '',
              `另 ${state.scripts} 次在 bash 里跑脚本/重定向改文件（python3、node、sed -i、> 之类）：改到哪个文件无法逐次归因` +
                (scanSkipped ? '，这次也没拿到教学根做 mtime 对照。' : '；上面标「脚本改过」的就是 mtime 对得上的文件。')
            )
          }

          // editBudget 同时管脚本归因的文件：它们的真实改动次数不知道，按至少 1 次算，
          // 所以这里只可能报「已知次数超标」；脚本多的课下面还会单独提醒次数偏低。
          const over = rows.filter((item) => item.total > live.ledger.editBudget)
          if (over.length > 0) {
            lines.push(
              '',
              `超过单文件 ${live.ledger.editBudget} 次参考线：` +
                over.map((item) => `${item.file}(${item.total})`).join('、') +
                '（脚本改过的文件按至少 1 次算）'
            )
            lines.push('下一课改成整段写入：先在脑内定稿再落一次，别拿小 edit 当自动补全。')
          } else if (scriptFiles.length > 0) {
            lines.push(
              '',
              `单文件都没过 ${live.ledger.editBudget} 次参考线；但上表有文件没被 write/edit 记过（次数未知）；` +
                '它们按至少 1 次算，已经用 write/edit 记过的文件不重复加。'
            )
          }

          lines.push('', renderShapeLines(state).join('\n'))

          if (state.asks > 0) {
            lines.push('', `提问 ${state.asks} 批（${state.questions} 个问题，${state.answeredAsks} 批拿到回答）。提问不占程序预算，但每批都要等回答。`)
          }
          if (steps > live.ledger.stepBudget) {
            lines.push('', `步数 ${steps} 已过参考线 ${live.ledger.stepBudget}：看看有没有重读同一张文件、重复自检或原地改字。`)
          }

          // 传整个 agent 而不是 id：阶段工具要据此读档案投影（跨会话/重启一致）。
          const stage = stageTool?.stageOf?.(exec?.agent ?? exec?.agent?.id)
          if (stage !== undefined) {
            const note = typeof stage.note === 'string' ? stage.note.trim() : ''
            lines.push('', note.length > 0 ? `当前阶段：${stage.stage}（${clip(note, 40)}）` : `当前阶段：${stage.stage}`)
          }
          lines.push('', '交付前再问自己三句：题目自足吗？任一帧停住看得懂吗？学习记录写了吗？')
          return { text: lines.join('\n'), steps }
        }
      }),
    'teach-me.tool(teach_report)'
  )
}
