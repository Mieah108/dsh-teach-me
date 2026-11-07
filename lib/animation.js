/* 动画工程的四个动作：只读检查、一次性受管接入、把工作区源码镜像进受管工程、在工程里渲染。
 *
 * 为什么不让模型自己写工程目录：工程在会话工作区之外，模型每写一次就要人批一次
 * （实测一节课 16 次）。改成「源码写在工作区 → 插件镜像 → 插件渲染」之后，
 * 写盘发生在会话工作区里（不需要审批），跨目录写入只发生在插件内部，
 * 而插件被 sandbox.js 钉死在用户指定的那一个目录里（ADR-0008）。
 *
 * 归属原则（ADR-0013）：插件只维护 Root.tsx 里标记块之间的内容与 src/videos/_teach-managed/；
 * 接入一次之后，每课的 Composition 由 teach_animation_sync 按约定自动注册。
 *
 * 渲染可能跑几分钟，直接执行会撞上 run_code 的程序预算（默认 120 秒），
 * 所以走后台 job：工具立刻返回 job id，模型用 job_output 取实时输出。
 *
 * 渲染稳定性（2026-10 实测）：这台机器开 5 个并发页面时 Remotion 拿不到 localhost:3000 的响应。
 * 所以渲染命令显式传 --concurrency（最多 2）/ --timeout / --overwrite，不依赖工程的
 * remotion.config.ts；失败自动重试 1 次。成功之后把产物记进教学档案（事件 lesson.artifact）。
 *
 * 端口：不探测、也不传 --port。Remotion 自己会在 3000–3100 里挑空闲端口（4.0.x 的
 * serve-static 就是这样），而显式 --port 是硬绑定 —— 那个端口不可用就直接失败。
 * 真正会互相踩的是「同一工程上两个渲染作业抢同一个产物路径 / 抢内存」，那由两道互斥负责：
 * 进程内的模块级 renderSlots（快路径，key = 工程根 realpath）与跨进程的
 * .dsh-teach/locks/render.lock（复用 archive 的 wx + pid 判活锁，键同样是工程根 realpath）。
 * 后者让「两个会话/两个进程同时渲染同一工程」也挡得住，并且快路径重启清空后仍然有效。
 *
 * 作业本身也落档案（事件 animation.job，0.6.4-D4）：起手写 running、结算写终态，
 * 于是重启后 teach_animation_inspect 还能回答「上次到哪一步」。
 *
 * 已知缺口（只记账、不封闭）：用 bash 直接调 remotion render/still 会绕开这两道互斥与
 * 产物归档；生产账本（lib/ledger.js）只把它计入渲染次数，不拦。见 upgrade-decision §4.4.4(d)。
 *
 * still 的产物带帧号：out/<category>/<slug>-f<frame>.png，封面帧用 -poster.png。
 * 连抽多帧不再互相覆盖，档案里也记下帧号（lesson.artifact.frame），事后能复核抽了哪几帧。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { LockHeldError } from './archive/errors.js'
import { acquirePathLock } from './archive/lock.js'
import { recordAnimationJob, recordArtifact } from './archive/operations.js'
import { animationJobsOf } from './archive/state.js'
import { tryOpenArchive } from './archive/store.js'
import { ProjectError, openProject } from './sandbox.js'
import {
  FILE_RULES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  inspectAnimation,
  readLessonManifests,
  registerManagedNamespace,
  syncLesson
} from './animation-managed.js'

const COMPOSITION = /^[A-Za-z0-9_]+$/

/** 失败后额外重试次数：一次抖动很常见，重试一次就够了（不放大并发）。 */
const RENDER_RETRIES = 1
/** 两次尝试之间的间隔（毫秒）。 */
const RENDER_RETRY_DELAY_MS = 2000
/** Remotion --timeout 的默认值：它是「单帧 delayRender 等待上限」，不是整段渲染预算。 */
const DEFAULT_FRAME_TIMEOUT_MS = 30000

/** inspect 的七个分档；工具输出里原样给模型看。 */
const INSPECT_STATES = ['unconfigured', 'missing-root', 'not-a-project', 'deps-missing', 'invalid-entry', 'not-integrated', 'ready']

function fail(message, code) {
  throw new ProjectError(message, code)
}

function sanitizeName(value, what) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    fail(what + ' 只能用字母、数字、点、下划线、连字符：' + JSON.stringify(value), 'bad-name')
  }
  return value
}

/** 可选的 lessonId：空值给 null；合法性跟档案标识一致（渲染时这一课可能还没发布）。 */
function optionalLessonId(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(value)) {
    fail('lessonId 不是合法标识（字母、数字、点、下划线、冒号、@、连字符）：' + JSON.stringify(value), 'bad-name')
  }
  return value
}

/** 工具注册用的 ctx.get；两种写法都兼容。 */
function serviceOf(ctx, name) {
  return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
}

/**
 * 注册 teach_animation_inspect：只读诊断工程可用性，并给出一次性接入 diff。
 * 绝不写任何文件（测试用目录快照证明 inspect 前后工程无变化）。
 * 另外从教学档案只读地取这个工程的渲染作业：重启后能看出「上次停在哪一步」。
 */
function registerInspectTool(ctx, getConfig, workspaceOf) {
  const tools = serviceOf(ctx, 'tools')
  if (tools === undefined || tools === null) return

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_animation_inspect',
        description:
          'Read-only health check of the configured Remotion project: reports one of unconfigured / missing-root / ' +
          'not-a-project / deps-missing / invalid-entry / not-integrated / ready with a human reason, a structure ' +
          'summary (remotion deps, src/index.ts, src/Root.tsx, existing compositions, shared components, managed ' +
          'namespace) and the one-time integration diff for src/Root.tsx. Also reports, read-only from the teaching ' +
          'archive, this project\'s render jobs (unfinished ones survive a restart). Never writes anything.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {}
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['state', 'ready', 'reason', 'hint'],
            properties: {
              state: { type: 'string', enum: INSPECT_STATES, description: '可用性分档。' },
              ready: { type: 'boolean', description: 'true 表示工程已接入受管命名空间，可以直接 sync。' },
              reason: { type: 'string', description: '人读原因。' },
              hint: { type: 'string', description: '下一步建议。' },
              root: { type: 'string', description: '规范化后的工程根（未配置时为空）。' },
              configured: { type: 'boolean', description: '设置页是否填了工程路径。' },
              diff: { type: 'string', description: '一次性接入 diff（未接入时非空，接入后为空）。' },
              writes: { type: 'array', items: { type: 'string' }, description: '接入将写入的路径（只是预告，不落盘）。' },
              project: { type: 'object', description: '结构摘要：remotion 依赖、入口、共享件、已有 videos/composition。' },
              managed: { type: 'object', description: '受管命名空间现状：标记块、registry、已登记课程。' },
              jobs: {
                type: 'object',
                description:
                  '可选：这个工程在教学档案里的渲染作业（只读）。unfinished 是仍停在 running 的作业（重启后就看这一项），' +
                  'last 是最近一条，hint 说明怎么收尾。档案还没有作业记录时是 total:0 的空汇总；读不到档案时不出现。'
              }
            }
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
        async execute(_args, exec) {
          const inspection = inspectAnimation(getConfig())
          if (inspection.state === 'unconfigured') {
            return {
              state: inspection.state,
              ready: false,
              reason: inspection.reason,
              hint: inspection.hint,
              root: '',
              configured: false,
              diff: '',
              writes: []
            }
          }
          // 可选字段：只读档案里的作业记录。没有工作区/没有档案就整段不出现，
          // 不能用「诊断」把档案目录建出来（inspect 的契约是绝不写任何文件）。
          let jobs
          try {
            jobs = inspectRenderJobs(typeof workspaceOf === 'function' ? workspaceOf(exec?.agent) : undefined, inspection.root)
          } catch {
            jobs = null
          }
          return {
            state: inspection.state,
            ready: inspection.ready === true,
            reason: inspection.reason,
            hint: inspection.hint,
            root: inspection.root,
            configured: inspection.configured === true,
            diff: inspection.diff ?? '',
            writes: inspection.writes ?? [],
            ...(inspection.project === undefined ? {} : { project: inspection.project }),
            ...(inspection.managed === undefined ? {} : { managed: inspection.managed }),
            ...(jobs === null || jobs === undefined ? {} : { jobs })
          }
        }
      }),
    'teach-me.tool(teach_animation_inspect)'
  )
}

/**
 * 注册 teach_animation_register：受管命名空间一次性接入。
 * 默认 dry_run 只返回 diff 与将要写入的路径；confirm: true 才落盘（写前备份 Root.tsx）。
 */
function registerRegisterTool(ctx, getConfig) {
  const tools = serviceOf(ctx, 'tools')
  if (tools === undefined || tools === null) return

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_animation_register',
        description:
          'One-time managed onboarding of the configured Remotion project. Defaults to a dry run: returns the ' +
          'src/Root.tsx diff and the paths that would be written, without touching any file. Call again with ' +
          'confirm: true only after the learner explicitly agrees. The plugin owns just the marked blocks in ' +
          'Root.tsx and the src/videos/_teach-managed/ namespace; hand-written content outside the markers is ' +
          'preserved, the old Root.tsx is backed up under .dsh-teach/managed/, and repeated calls are idempotent.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            confirm: { type: 'boolean', description: 'true = 真的写入（默认 false，只演练）。' }
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['written', 'dryRun', 'state', 'diff', 'writes'],
            properties: {
              written: { type: 'boolean', description: '是否真的写了文件（幂等时 false）。' },
              dryRun: { type: 'boolean', description: '是否是演练（confirm 不为 true）。' },
              changed: { type: 'boolean', description: '是否有内容需要改动。' },
              state: { type: 'string', description: '写入前/后的工程可用性分档。' },
              root: { type: 'string', description: '工程根。' },
              diff: { type: 'string', description: 'src/Root.tsx 的接入 diff（只有演练/有改动时非空）。' },
              writes: { type: 'array', items: { type: 'string' }, description: '需要写入/已写入的路径。' },
              backup: { type: 'string', description: 'Root.tsx 备份位置（相对工程根）。' },
              namespace: { type: 'object', description: '受管命名空间目录与 registry 状态。' },
              hint: { type: 'string', description: '下一步建议。' }
            }
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
        async execute(args) {
          return registerManagedNamespace({ config: getConfig(), confirm: args?.confirm === true })
        }
      }),
    'teach-me.tool(teach_animation_register)'
  )
}

/**
 * 注册 teach_animation_sync：把工作区里的源码整批镜像进工程（只写白名单路径）。
 * 先整批校验再原子发布；dry_run 不创建任何目录/文件。
 */
function registerSyncTool(ctx, getConfig, workspaceOf) {
  const tools = serviceOf(ctx, 'tools')
  if (tools === undefined || tools === null) return

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_animation_sync',
        description:
          "Publish this lesson's animation source from the workspace staging directory " +
          '(<workspace>/.dsh-teach-me/animation-src/<slug>/) into the managed Remotion project ' +
          '(<root>/src/videos/<category>/<slug>/). The whole batch is validated first (type, size, total, regular ' +
          'files, target paths, ownership, revision) and then published atomically: a temporary directory is ' +
          'renamed into place, so a failure leaves nothing half-written and dry_run writes nothing at all. ' +
          'When the project is onboarded (teach_animation_register), the managed registry is rebuilt so the ' +
          "lesson's Composition is registered automatically.",
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'slug'],
          properties: {
            category: { type: 'string', description: '工程里的一级分类，例如 LLM、ComputerArchitecture。' },
            slug: { type: 'string', description: '这一课的目录名，例如 ropim-dataflow。' },
            files: {
              type: 'array',
              description: '只同步这些文件（默认同步全部 .ts/.tsx/.json/.md/.css）；列了不存在或类型不对的文件会报错。',
              items: { type: 'string' }
            },
            revision: {
              type: 'string',
              description: '本次源码修订号（默认用时间戳）。同一 revision 发布不同内容会被拒绝，旧 revision 不能覆盖新的。'
            },
            adopt: {
              type: 'boolean',
              description: '目标目录已存在但没有受管清单时，true 表示确认这个目录归插件所有（默认 false，内容不同就拒绝覆盖）。'
            },
            dry_run: { type: 'boolean', description: '只检查不写入；不会创建任何目录或文件。' }
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['root', 'category', 'slug', 'files', 'written', 'dryRun', 'registered', 'hints'],
            properties: {
              root: { type: 'string', description: '工程根（已规范化）。' },
              category: { type: 'string' },
              slug: { type: 'string' },
              revision: { type: 'string', description: '这次发布的修订号。' },
              staging: { type: 'string', description: '工作区里的源码目录。' },
              files: { type: 'array', items: { type: 'string' }, description: '同步过去的文件（相对工程根）。' },
              written: { type: 'boolean', description: '是否真的写入（dry_run 时为 false）。' },
              dryRun: { type: 'boolean', description: '是否只是演练。' },
              registered: { type: 'boolean', description: '工程是否已接入受管命名空间。' },
              composition: { type: 'string', description: '这一课的 Composition id（没满足注册约定时为空）。' },
              registryWritten: { type: 'boolean', description: '是否重建了受管 registry。' },
              hints: { type: 'array', items: { type: 'string' }, description: '需要注意的后续事项。' },
              hint: { type: 'string', description: '下一步提示。' }
            }
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
        async execute(args, exec) {
          const workspace = workspaceOf(exec?.agent)
          const result = syncLesson({
            config: getConfig(),
            workspace,
            category: args?.category,
            slug: args?.slug,
            files: args?.files,
            revision: args?.revision,
            adopt: args?.adopt === true,
            dryRun: args?.dry_run === true
          })
          return {
            root: result.root,
            category: result.category,
            slug: result.slug,
            revision: result.revision,
            staging: result.staging,
            files: result.files,
            written: result.written,
            dryRun: result.dryRun,
            registered: result.registered,
            composition: result.composition ?? '',
            registryWritten: result.registryWritten === true,
            hints: result.hints,
            hint: result.hint
          }
        }
      }),
    'teach-me.tool(teach_animation_sync)'
  )
}

/** 找工程里的 remotion 可执行文件；没有就报清楚。 */
function remotionBinary(root) {
  const local = path.join(root, 'node_modules', '.bin', 'remotion')
  let stat
  try {
    stat = fs.statSync(local)
  } catch {
    fail('工程里没有 node_modules/.bin/remotion —— 先在工程目录安装依赖（npm install / pnpm install）。', 'deps-missing')
  }
  if (!stat.isFile()) fail(local + ' 不是普通文件（可能是断链），先在工程目录重新安装依赖。', 'deps-missing')
  return local
}

/** 等一条管道读完；进程已退出但后代仍握着 fd 时，最多等 5 秒。 */
function endOf(stream, timeoutMs = 5000) {
  if (stream === undefined || stream === null || stream.closed === true) return Promise.resolve()
  return new Promise((resolve) => {
    let finished = false
    const done = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      stream.removeListener?.('close', done)
      stream.removeListener?.('end', done)
      stream.removeListener?.('error', done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    stream.once('close', done)
    stream.once('end', done)
    stream.once('error', done)
  })
}

/* —————————————————————— 渲染稳定性：并发、互斥、重试、归档 —————————————————————— */

/**
 * 渲染并发：最多 2，跟着 CPU 数走。
 * 实测这台机器开 5 个并发页面时预览页拿不到 localhost:3000 的响应，所以上限钉死在 2；
 * 单核机器至少给 1，避免出现 --concurrency 0。
 * @param {number} [cpuCount] CPU 数（测试可注入）
 * @returns {number} 1 或 2
 */
export function renderConcurrency(cpuCount = os.cpus()?.length ?? 1) {
  const count = Number.isFinite(cpuCount) && cpuCount > 0 ? Math.trunc(cpuCount) : 1
  return Math.max(1, Math.min(2, count))
}

/**
 * 拼 remotion 的渲染参数：现有参数顺序不变，显式选项追加在最后。
 *
 * --concurrency / --timeout / --overwrite 都写在命令行上，不依赖工程的
 * remotion.config.ts —— 那是共享工程的全局配置，插件不该靠改它来让渲染稳定。
 *
 * --timeout 是 Remotion 的单帧 delayRender 上限（不是整段预算），所以传的是
 * frameTimeoutMs（默认 30 秒）；整段预算由 startRenderHooks 的计时器管。
 * @param {object} options
 * @param {'still'|'render'} options.mode
 * @param {string} options.composition
 * @param {string} options.relOut 工程内相对产物路径
 * @param {number} [options.frame] still 的帧号
 * @param {number} [options.frameTimeoutMs] 单帧 delayRender 上限（毫秒）
 * @param {number} [options.concurrency]
 * @returns {string[]}
 */
export function buildRenderArgs({
  mode,
  composition,
  relOut,
  frame = 0,
  frameTimeoutMs = DEFAULT_FRAME_TIMEOUT_MS,
  concurrency = renderConcurrency()
}) {
  const argv = [mode === 'still' ? 'still' : 'render', 'src/index.ts', composition, relOut]
  if (mode === 'still') argv.push('--frame', String(frame))
  argv.push('--overwrite')
  argv.push('--concurrency', String(concurrency))
  const perFrame = Math.max(1, Math.trunc(Number(frameTimeoutMs) || DEFAULT_FRAME_TIMEOUT_MS))
  argv.push('--timeout', String(perFrame))
  return argv
}

/**
 * still 的产物路径：带帧号，连抽多帧不再互相覆盖。
 *
 * 平铺在 `out/<类别>/` 下、不建子目录 —— 现有的写入围栏
 * （sandbox.js 的 `^out/<类别>/<文件>\.(mp4|png|json|txt)$`）原样够用，
 * 不需要为它放宽权限。封面帧（poster）单独一个名字，不跟帧号抢。
 * @param {object} options
 * @param {string} options.category
 * @param {string} options.slug
 * @param {number} [options.frame] still 的帧号（poster 时只用于记录）
 * @param {boolean} [options.poster] true = 封面帧
 * @returns {string} 工程内相对路径
 */
export function stillRelOut({ category, slug, frame = 0, poster = false }) {
  const safeFrame = Math.max(0, Math.trunc(Number(frame) || 0))
  return 'out/' + category + '/' + slug + (poster === true ? '-poster' : '-f' + safeFrame) + '.png'
}

/**
 * 同一个工程上一次只允许一个渲染作业（进程内互斥）。
 *
 * 为什么需要它：Remotion 自己会在 3000–3100 里挑空闲端口，两个作业并行不会撞端口；
 * 真正会踩的是同一课的两个作业抢同一个产物路径（still 与 render 都带 --overwrite），
 * 以及并发起两个 Chromium 把内存和 CPU 打爆。所以挡的是「同一工程上的并发作业」，
 * 不是端口。
 *
 * 键是工程根的 realpath：不同工程互不影响，同一工程的第二个作业在起进程前就失败。
 * 只活在内存里 —— 宿主重启或插件重载即清空，不落盘、不写工程目录。
 * @returns {{size: () => number, peek: (root: string) => object|undefined, acquire: Function, release: Function}}
 */
export function createRenderSlots() {
  const active = new Map()
  return {
    size: () => active.size,
    peek: (root) => active.get(root),
    /**
     * 占用一个槽位。
     * @returns {object|null} 占用成功返回槽位对象；这个工程已有作业时返回 null
     */
    acquire(root, info = {}) {
      if (active.has(root)) return null
      const slot = { mode: '', composition: '', relOut: '', jobId: '', startedAt: Date.now(), ...info }
      active.set(root, slot)
      return slot
    },
    /**
     * 释放槽位。
     * 带上 jobId 时只释放自己的那一个：迟到的 finally 抢不走后来者的槽，
     * 后来者的 jobId 还没回填时也不认领（那段窗口里按 root 放行会把别人的作业放开）。
     * @returns {boolean} 是否真的释放了
     */
    release(root, jobId) {
      const slot = active.get(root)
      if (slot === undefined) return false
      if (typeof jobId === 'string' && jobId.length > 0 && slot.jobId !== jobId) return false
      active.delete(root)
      return true
    }
  }
}

/** 模块级槽位表：整个插件实例共用（同一工程跨会话也挡得住）。 */
const renderSlots = createRenderSlots()

/* —————————————————————— 跨进程互斥（0.6.4-D4） —————————————————————— */

/** 跨进程渲染锁的文件名（在 animationLockDir 下；不与档案的 workspace.lock 混用）。 */
const RENDER_LOCK_NAME = 'render.lock'

/**
 * 跨进程互斥的锁目录：<工程根>/.dsh-teach/locks。
 *
 * 为什么不放工作区：键是「工程根 realpath」。同一个受管工程可能被两个会话、甚至两个
 * 插件进程同时渲染，而工作区各是各的。.dsh-teach/ 已经是插件在工程里的自有目录
 * （受管清单在 .dsh-teach/managed 下），锁文件是临时的：拿到才存在、结算即删，
 * 崩溃留下的由 pid 判活回收。
 * @param {string} projectRoot 工程根（openProject 已 realpath）
 * @returns {string} 绝对路径
 */
export function animationLockDir(projectRoot) {
  return path.join(projectRoot, '.dsh-teach', 'locks')
}

/**
 * 取一个工程的跨进程渲染锁（键 = 工程根 realpath）。
 *
 * 复用 archive 的 wx + pid 判活锁（lib/archive/lock.js 的 acquirePathLock），不是在动画里
 * 另写一份：两个进程同时渲染同一工程时，第二个拿不到 wx 文件就报 LockHeldError，
 * 报错里带持锁者的 pid / host / 时间，以及后续回填的 jobId / 模式 / 产物。
 *
 * timeoutMs 默认 0：渲染互斥要「立刻说不」，不排队等一个几分钟的渲染。
 * @param {string} projectRoot 工程根（openProject 已 realpath）
 * @param {{info?: object, timeoutMs?: number, pollMs?: number, label?: string}} [options]
 * @returns {{file: string, owner: string, info: object, update: Function, relocate: Function, release: Function}}
 */
export function acquireAnimationLock(projectRoot, { info = {}, timeoutMs = 0, pollMs = 25, label = 'animation-render' } = {}) {
  return acquirePathLock(animationLockDir(projectRoot), {
    timeoutMs,
    pollMs,
    label,
    name: RENDER_LOCK_NAME,
    subject: '动画工程',
    info
  })
}

/** 锁被占时给模型的可读原因：谁在跑、哪一个 job、怎么收场，都不猜。 */
function renderLockBusyMessage(error) {
  const holder = error?.detail?.holder ?? {}
  const pid = Number.isInteger(holder.pid) ? 'pid ' + holder.pid : 'pid 未知'
  const host = typeof holder.host === 'string' && holder.host.length > 0 ? ' @ ' + holder.host : ''
  const since = typeof holder.startedAt === 'string' && holder.startedAt.length > 0 ? '，自 ' + holder.startedAt : ''
  const jobId = typeof holder.jobId === 'string' && holder.jobId.length > 0 ? holder.jobId : '（job id 还没回填）'
  const what = [typeof holder.mode === 'string' ? holder.mode : '', typeof holder.composition === 'string' ? holder.composition : '']
    .filter((part) => part.length > 0)
    .join(' ')
  const output = typeof holder.output === 'string' && holder.output.length > 0 ? ' → ' + holder.output : ''
  return (
    '这个工程正被另一个进程渲染（' + pid + host + since + '，job id：' + jobId + (what.length > 0 ? '，' + what : '') + output + '）。' +
    '跨进程互斥按工程根算：同一工程一次只跑一个渲染作业。用 job_output 看它的进度，要停就 job_kill ' + jobId + '，' +
    '等它结束（或那个进程退出）再起这一单。不要去杀端口上的进程 —— 那很可能就是它自己。'
  )
}

/* —————————————————————— 作业持久化（animation.job，0.6.4-D4） —————————————————————— */

/** 作业终态：hooks.done 的 status 直接映射成事件里的 state（未知一律按 failed 记）。 */
function terminalJobState(outcome) {
  const status = outcome?.status
  return status === 'completed' || status === 'failed' || status === 'killed' ? status : 'failed'
}

/**
 * 只读：这一课当前在档案里的 revision（拿不到或还没发布就给 null）。
 * 起手时定格一次，作业事件与产物事件都用这一版 —— 渲染期间别人发布了新课也不改这次绑定。
 * @param {string|undefined} workspace 会话工作区（档案在那里）
 * @param {string|null} lessonId 课程 id
 * @returns {number|null}
 */
export function lessonRevisionIn(workspace, lessonId) {
  if (lessonId === null || lessonId === undefined) return null
  if (typeof workspace !== 'string' || workspace.length === 0) return null
  try {
    const archive = tryOpenArchive(workspace, { repairIndex: false })
    const revision = archive?.state?.lessons?.[lessonId]?.revision
    return Number.isInteger(revision) && revision > 0 ? revision : null
  } catch {
    return null
  }
}

/** 写一条作业状态进档案；失败只写 job 日志（记账不能把渲染的终态改掉）。 */
function noteJobState({ workspace, info, state, log }) {
  if (typeof workspace !== 'string' || workspace.length === 0) return null
  try {
    return recordAnimationJob(workspace, { ...info, state })
  } catch (error) {
    const write = typeof log === 'function' ? log : () => {}
    write('\n[teach-me] 作业状态没记进教学档案（渲染不受影响）：' + (error instanceof Error ? error.message : String(error)) + '\n')
    return null
  }
}

/**
 * 只读：这个工程在档案里留下的渲染作业（重启后回答「上次到哪一步」）。
 * 档案不存在、读不出来或没有记录都返回 null/空 —— inspect 是诊断，不能因为档案问题失败。
 * @param {string|undefined} workspace 会话工作区（档案在那里）
 * @param {string} projectRoot 工程根 realpath
 * @returns {{total: number, unfinished: object[], last: object|null, hint?: string}|null}
 */
export function inspectRenderJobs(workspace, projectRoot) {
  if (typeof workspace !== 'string' || workspace.length === 0) return null
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) return null
  let archive
  try {
    archive = tryOpenArchive(workspace, { repairIndex: false })
  } catch {
    return null
  }
  if (archive === null) return null
  const jobs = animationJobsOf(archive.state, { root: projectRoot })
  if (jobs.length === 0) return { total: 0, unfinished: [], last: null }
  const pick = (job) => ({
    jobId: job.jobId,
    state: job.state,
    mode: job.mode,
    composition: job.composition,
    output: job.output,
    lessonRevision: job.lessonRevision,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  })
  const unfinished = jobs.filter((job) => job.state === 'running').map(pick)
  const last = pick(jobs[jobs.length - 1])
  return {
    total: jobs.length,
    unfinished,
    last,
    ...(unfinished.length === 0
      ? {}
      : {
          hint:
            '档案里还有 ' + unfinished.length + ' 个未收尾的渲染作业（最近的 job id：' + unfinished[unfinished.length - 1].jobId +
            '，自 ' + (unfinished[unfinished.length - 1].startedAt ?? '?') + '）。进程内作业表重启就清空了，这条来自档案：' +
            '先确认那个进程还在不在（' + animationLockDir(projectRoot) + '/' + RENDER_LOCK_NAME + ' 里有 pid），' +
            '不在了就重跑这一单；产物没归档的话档案里不会有 lesson.artifact。'
        })
  }
}

/** 受管清单里这一课的时长（帧）；清单缺失或没声明时返回 null。 */
function lessonDurationInFrames(project, category, slug) {
  const manifest = readLessonManifests(project).find((item) => item?.category === category && item?.slug === slug)
  const frames = manifest?.entry?.durationInFrames
  return Number.isFinite(frames) && frames > 0 ? Math.trunc(frames) : null
}

/** 流式计算产物的 sha256（成片可能几百 MB，不整份读进内存）；读不了返回 null。 */
function sha256OfFile(file) {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    let stream
    try {
      stream = fs.createReadStream(file)
    } catch {
      resolve(null)
      return
    }
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', () => resolve(null))
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 渲染成功后把产物写进教学档案（事件 lesson.artifact）。
 *
 * 只记能确证的东西：产物路径、内容 sha256、以及受管清单里的帧数/fps（拿不到就 null）。
 * still 额外记帧号与「这是不是封面帧」—— 平铺命名之后，帧号是复核「抽了哪几帧」的唯一依据。
 * 没有会话工作区、产物不在、档案写失败都只写 job 日志 —— 成片已经渲出来了，
 * 不能让归档问题把 job 终态从 completed 改成失败。
 * @param {object} options
 * @param {string|undefined} options.workspace 会话工作区（档案在那里）
 * @param {string|null} [options.lessonId] 可缺省：只记 path 也允许
 * @param {number|null} [options.lessonRevision] 渲染起手时定格的课程 revision（产物绑课程版本）
 * @param {object} options.project Remotion 工程句柄
 * @param {string} options.category
 * @param {string} options.slug
 * @param {'still'|'render'} options.mode
 * @param {string} options.relOut 工程内相对产物路径
 * @param {number|null} [options.frame] still 的帧号；render 不带
 * @param {boolean} [options.poster] still 是否是封面帧
 * @param {(text: string) => void} [options.log] 写 job 日志
 * @param {Function} [options.record] 写档函数（默认 recordArtifact；测试可注入）
 * @returns {Promise<object|null>} 记下的字段；没记成返回 null
 */
export async function recordRenderArtifact({
  workspace,
  lessonId = null,
  lessonRevision = null,
  project,
  category,
  slug,
  mode,
  relOut,
  frame = null,
  poster = false,
  log = () => {},
  record = recordArtifact
}) {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    log('\n[teach-me] 没有会话工作区，这次渲染没有写进教学档案（成片不受影响）。\n')
    return null
  }
  const absolute = path.join(project.root, relOut)
  const digest = await sha256OfFile(absolute)
  if (digest === null) {
    log('\n[teach-me] 产物读不出来（' + absolute + '），档案未记录。\n')
    return null
  }
  const manifest = readLessonManifests(project).find((item) => item?.category === category && item?.slug === slug)
  const fps = Number.isFinite(manifest?.entry?.fps) && manifest.entry.fps > 0 ? manifest.entry.fps : null
  // frames 是这次产物的帧数：still 就是一帧；render 取受管清单里声明的总帧数
  let frames = null
  let durationMs = null
  if (mode === 'still') {
    frames = 1
    // still 的 durationMs 没有意义（一帧不是一段时长）；以前拿 fps 除出一个 33ms 纯属误导
  } else if (Number.isFinite(manifest?.entry?.durationInFrames) && manifest.entry.durationInFrames > 0) {
    frames = manifest.entry.durationInFrames
    // durationMs 是成片时长（frames / fps），不是这次渲染的墙钟耗时
    if (fps !== null) durationMs = Math.round((frames / fps) * 1000)
  }
  const stillFrame = mode === 'still' && Number.isFinite(frame) ? Math.max(0, Math.trunc(frame)) : null
  try {
    const recorded = record(workspace, {
      lessonId,
      // 产物绑课程 revision：起手时定格的那一版；没有课程或没发布就是 null（读取方兼容老日志）
      lessonRevision,
      path: relOut.split(path.sep).join('/'),
      sha256: digest,
      frames,
      durationMs,
      fps,
      frame: stillFrame,
      poster: stillFrame === null ? false : poster === true
    })
    log(
      '\n[teach-me] 产物已记入教学档案：' +
        relOut +
        (stillFrame === null ? '' : '（第 ' + stillFrame + ' 帧' + (poster === true ? '，封面' : '') + '）') +
        '\n'
    )
    return recorded
  } catch (error) {
    log('\n[teach-me] 写教学档案失败（成片不受影响）：' + (error instanceof Error ? error.message : String(error)) + '\n')
    return null
  }
}

/* —————————————————————————— 后台渲染作业 —————————————————————————— */

/**
 * 启动一个受管渲染作业：同步返回 cancel + done（宿主 JobRegistry 的契约）。
 *
 * done 永不 reject，并负责把启动失败、非零退出、超时、取消、正常完成
 * 结算成一个 JobOutcome；stdio 读完、子进程范围退出后才算终态。
 *
 * retries > 0 时，一次失败（非零退出或启动失败）会等 retryDelayMs 后重跑一次，
 * 日志里写明这是第几次尝试；超时与取消不重试（预算已经花完 / 那是人的决定）。
 * @param {object} options
 * @param {object} options.subprocess 宿主 subprocess 服务
 * @param {object} options.jobHandle 宿主 JobHandle
 * @param {object} options.spec SubprocessSpawnSpec
 * @param {string} options.command 展示用命令
 * @param {number} options.timeoutMs 超时毫秒（整体预算，重试不重置）
 * @param {number} [options.retries] 失败后额外重试次数（默认 0）
 * @param {number} [options.retryDelayMs] 重试间隔毫秒（默认 2000）
 * @param {number} [options.cleanupTimeoutMs] 退出确认的等待上限（默认 10000）
 * @returns {{cancel: (reason?: string) => void, done: Promise<object>}}
 */
export function startRenderHooks({
  subprocess,
  jobHandle,
  spec,
  command,
  timeoutMs,
  retries = 0,
  retryDelayMs = 2000,
  cleanupTimeoutMs = 10000
}) {
  const append = (text) => { try { jobHandle.append(text) } catch { /* 作业视图已销毁，不影响退出结算。 */ } }
  const cleanupMs = Number.isFinite(cleanupTimeoutMs) ? Math.max(1, cleanupTimeoutMs) : 10000
  const maxAttempts = 1 + (Number.isFinite(retries) && retries > 0 ? Math.trunc(retries) : 0)
  const timeoutDetail = 'timeout after ' + Math.round(timeoutMs / 1000) + 's'
  let child
  let timer
  let terminationTimer
  let retryTimer
  let cancelled = false
  let timedOut = false
  let attempt = 0
  let attemptActive = false
  let settled = false
  let resolveOutcome
  const outcome = new Promise((resolve) => {
    resolveOutcome = resolve
  })

  const settle = (status, detail) => {
    if (settled) return
    settled = true
    if (terminationTimer !== undefined) clearTimeout(terminationTimer)
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = undefined
    resolveOutcome(detail === undefined ? { status } : { status, detail })
  }

  /** 失败收尾：还有次数就排下一次尝试，否则写日志并结算。 */
  const failAttempt = (detail, finalMessage) => {
    if (settled) return
    attemptActive = false
    if (cancelled) {
      if (settled !== true) append('\n[teach-me] 已取消。\n')
      settle('killed', 'cancelled')
      return
    }
    if (timedOut) {
      settle('failed', timeoutDetail)
      return
    }
    if (attempt < maxAttempts) {
      append(
        '\n[teach-me] 第 ' +
          attempt +
          ' 次尝试失败（' +
          detail +
          '），' +
          Math.round(retryDelayMs / 1000) +
          ' 秒后重试（第 ' +
          (attempt + 1) +
          '/' +
          maxAttempts +
          ' 次尝试）。\n'
      )
      retryTimer = setTimeout(() => {
        retryTimer = undefined
        startAttempt()
      }, retryDelayMs)
      return
    }
    if (finalMessage.length > 0) append(finalMessage)
    settle('failed', detail)
  }

  const stopChild = (detail) => {
    if (settled) return
    if (terminationTimer !== undefined) clearTimeout(terminationTimer)
    try { child?.terminate() } catch { /* 仍须靠后面的界限结算。 */ }
    terminationTimer = setTimeout(() => settle('failed', detail + '; exit unconfirmed'), cleanupMs)
  }

  const onTimeout = () => {
    timedOut = true
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    append('\n[teach-me] 超过 ' + Math.round(timeoutMs / 1000) + ' 秒，正在终止。\n')
    if (attemptActive !== true) {
      // 在等重试时超时：没有进程可终止，直接结算
      settle('failed', timeoutDetail)
      return
    }
    stopChild(timeoutDetail)
  }

  const startAttempt = () => {
    if (settled || cancelled || timedOut) return
    attempt += 1
    if (maxAttempts > 1) append('\n[teach-me] 第 ' + attempt + '/' + maxAttempts + ' 次尝试。\n')
    let current
    try {
      current = subprocess.spawn(spec)
    } catch (error) {
      append('\n[teach-me] 启动失败：' + (error instanceof Error ? error.message : String(error)) + '\n')
      failAttempt('startup failed', '')
      return
    }
    child = current
    attemptActive = true
    append('$ ' + command + '\n')
    try {
      current.stdout?.on('error', () => {})
      current.stderr?.on('error', () => {})
      current.stdout?.on('data', (chunk) => append(String(chunk)))
      current.stderr?.on('data', (chunk) => append(String(chunk)))
      Promise.resolve(current.done).then(
        async (exit) => {
          await Promise.all([endOf(current.stdout, Math.min(5000, cleanupMs)), endOf(current.stderr, Math.min(5000, cleanupMs))])
          if (settled) return
          try {
            let waitTimer
            try {
              await Promise.race([
                current.waitForExit(AbortSignal.timeout(cleanupMs)),
                new Promise((_, reject) => { waitTimer = setTimeout(() => reject(new Error('scope timeout')), cleanupMs) })
              ])
            } finally { clearTimeout(waitTimer) }
          } catch {
            // 提供方观察不到进程范围时，以子进程 exit 为准；下面记一条诊断
            append('\n[teach-me] 进程范围退出确认失败；终态按子进程退出码结算。\n')
          }
          const detail = exit.exitCode === null ? 'signal: ' + String(exit.signal) : 'exit code: ' + exit.exitCode
          if (cancelled) {
            attemptActive = false
            if (settled !== true) append('\n[teach-me] 已取消。\n')
            settle('killed', 'cancelled')
            return
          }
          if (timedOut) {
            attemptActive = false
            append('\n[teach-me] 已按超时终止。\n')
            settle('failed', timeoutDetail)
            return
          }
          if (exit.exitCode === 0) {
            attemptActive = false
            append('\n[teach-me] 渲染完成。\n')
            settle('completed')
            return
          }
          failAttempt(detail, '\n[teach-me] 渲染失败：' + detail + '\n')
        },
        async (error) => {
          append('\n[teach-me] 启动失败：' + (error instanceof Error ? error.message : String(error)) + '\n')
          // done 拒绝不等于进程已退出，不能直接重试并留下旧进程。
          stopChild('startup failed')
          try {
            await current.waitForExit(AbortSignal.timeout(cleanupMs))
            settle('failed', 'startup failed')
          } catch {
            settle('failed', 'startup failed; exit unconfirmed')
          }
        }
      ).catch((error) => {
        append('\n[teach-me] 进程结果处理失败：' + String(error) + '\n')
        stopChild('provider failed')
        settle('failed', 'provider failed')
      })
    } catch (error) {
      append('\n[teach-me] 进程句柄无效：' + String(error) + '\n')
      stopChild('startup failed')
      settle('failed', 'startup failed')
    }
  }

  // 整体预算从首次启动前开始，启动抛错与重试等待同样计入。
  timer = setTimeout(onTimeout, timeoutMs)
  startAttempt()

  return {
    cancel() {
      if (cancelled || settled) return
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
      append('\n[teach-me] 收到取消请求，正在终止。\n')
      if (attemptActive !== true || child === undefined) {
        // 没有在跑的尝试（例如正等重试）：直接结算，别等一个永远不会来的 done
        settle('killed', 'cancelled')
        return
      }
      stopChild('cancelled')
    },
    done: outcome
  }
}

/**
 * 注册 teach_animation_render：后台跑 still 或 render，立刻返回 job id。
 */
function registerRenderTool(ctx, getConfig, workspaceOf, deps = {}) {
  const tools = serviceOf(ctx, 'tools')
  if (tools === undefined || tools === null) return

  ctx.effect(
    () =>
      tools.register({
        name: 'teach_animation_render',
        description:
          'Render a still frame or the final video of a composition inside the configured Remotion project. ' +
          'Runs as a background job (renders take minutes) and returns its job id immediately: ' +
          'poll it with job_output, stop it with job_kill. A still lands at ' +
          '<root>/out/<category>/<slug>-f<frame>.png (frame-named, so repeated stills never overwrite each other); ' +
          'with poster: true it lands at <root>/out/<category>/<slug>-poster.png and defaults to the last frame from the ' +
          'managed manifest. The final video lands at <root>/out/<category>/<slug>.mp4. The composition id comes from ' +
          'teach_animation_sync (managed registry). Concurrency (at most 2), a per-frame timeout and overwrite are passed ' +
          'explicitly on the command line, so the shared remotion.config.ts is never edited and the port is left to ' +
          'Remotion (it scans 3000-3100 itself). Only one render/still per project may run at a time - also across ' +
          'processes, via a lock on the project root realpath: a second call fails fast with the running job id (or the ' +
          'other process holder). Job state is persisted as animation.job, so teach_animation_inspect can tell after a ' +
          'restart where the last render stopped. A failed attempt is retried once 2s later, and a successful render is ' +
          'recorded into the teaching archive as lesson.artifact (bound to the lesson revision). Never call remotion ' +
          'render/still from bash: that bypasses this per-project cross-process lock and the artifact record - the ledger ' +
          'only counts it.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'slug', 'composition', 'mode'],
          properties: {
            category: { type: 'string', description: '工程里的一级分类，与 sync 一致。' },
            slug: { type: 'string', description: '这一课的目录名，与 sync 一致。' },
            composition: { type: 'string', description: 'Root.tsx 里注册的 composition id，例如 RopimDataflow（sync 返回的那个）。' },
            mode: { type: 'string', enum: ['still', 'render'], description: 'still 抽一帧预检；render 出成片。' },
            lessonId: {
              type: 'string',
              description: '可选：这次渲染属于哪一节课（写进教学档案 lesson.artifact 用）；拿不到就不填，只记产物路径。'
            },
            frame: { type: 'number', description: 'mode=still 时的帧号（默认 0；给了清单就校验范围）。' },
            poster: {
              type: 'boolean',
              description:
                '仅 mode=still：true 表示这一帧是封面帧，产物写 <slug>-poster.png；不给 frame 时自动取这一课末帧（受管清单 durationInFrames-1）。'
            },
            timeoutSeconds: { type: 'number', description: '最长运行秒数（默认 900，上限 1800）。' }
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['jobId', 'mode', 'output', 'command'],
            properties: {
              jobId: { type: 'string', description: '后台 job id，用 job_output 读输出、job_kill 停掉。' },
              mode: { type: 'string' },
              output: { type: 'string', description: '产物路径（相对工程根）。' },
              command: { type: 'string', description: '实际执行的命令（只读展示）。' },
              frame: { type: 'number', description: 'still 实际渲染的帧号（render 不带这个字段）。' },
              poster: { type: 'boolean', description: '这一帧是否是封面帧（poster: true 时才有意义的 true）。' },
              hint: { type: 'string' }
            }
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
        },
        async execute(args, exec) {
          const category = sanitizeName(args?.category, 'category')
          const slug = sanitizeName(args?.slug, 'slug')
          const composition = String(args?.composition ?? '')
          if (!COMPOSITION.test(composition)) fail('composition 只能包含字母、数字、下划线：' + JSON.stringify(composition), 'bad-name')
          const mode = args?.mode === 'render' ? 'render' : args?.mode === 'still' ? 'still' : undefined
          if (mode === undefined) fail('mode 只能是 still 或 render。', 'bad-mode')
          const poster = args?.poster === true
          if (poster && mode !== 'still') {
            fail('poster 只对 mode=still 有意义：封面帧是一张抽出来的图，成片本身不产生封面。', 'poster-needs-still')
          }

          const config = getConfig()
          if (!config.animation?.enabled) fail('还没有配置动画工程；这一课先不做动画。', 'not-configured')
          const project = openProject(config.animation.root)
          if (!project.exists('package.json')) fail(project.root + ' 里没有 package.json，这不是一个 Remotion 工程。', 'not-a-project')
          if (!project.exists('src/index.ts')) fail(project.root + '/src/index.ts 不存在，根组件入口找不到。', 'no-entry')

          const binary = remotionBinary(project.root)

          // 帧号：显式给了就用（负数、越界都由下面的范围校验拦，不在这里静默夹紧）；
          // poster 没给帧就取这一课的末帧（受管清单里的 durationInFrames - 1）
          const frameArg = Number.isFinite(args?.frame) ? Math.trunc(args.frame) : undefined
          const durationFrames = mode === 'still' ? lessonDurationInFrames(project, category, slug) : null
          let frame = frameArg ?? 0
          if (mode === 'still' && poster && frameArg === undefined) {
            if (durationFrames === null) {
              fail(
                '要抽封面帧（poster: true）却没给 frame，而受管清单里查不到这一课的 durationInFrames。先 sync 一次，或显式传 frame。',
                'unknown-duration'
              )
            }
            frame = durationFrames - 1
          }
          if (mode === 'still' && durationFrames !== null && (frame < 0 || frame >= durationFrames)) {
            fail('帧号 ' + frame + ' 超出这一课的范围（0–' + (durationFrames - 1) + '）。', 'frame-out-of-range')
          }

          // still 带帧号（poster 用 -poster），连抽多帧不互相覆盖；成片仍是 out/<类别>/<slug>.mp4
          const relOut = mode === 'still' ? stillRelOut({ category, slug, frame, poster }) : 'out/' + category + '/' + slug + '.mp4'
          project.checkWritable(relOut)

          const lessonId = optionalLessonId(args?.lessonId)
          const configuredTimeout = Number.isFinite(args?.timeoutSeconds) ? Math.trunc(args.timeoutSeconds) : 900
          // 整段预算（交给 job 计时器）；--timeout 是 Remotion 的单帧上限，单独从配置取
          const timeoutMs = Math.min(Math.max(configuredTimeout, 30), 1800) * 1000
          const frameTimeoutMs = Number.isFinite(config.animation?.frameTimeoutMs)
            ? config.animation.frameTimeoutMs
            : DEFAULT_FRAME_TIMEOUT_MS
          const concurrency = renderConcurrency()
          // 显式传 --concurrency / --timeout / --overwrite，不读工程的 remotion.config.ts；
          // 也不传 --port —— Remotion 自己在 3000–3100 里挑空闲端口，显式绑定反而会被占用挡死
          const argv = buildRenderArgs({ mode, composition, relOut, frame, frameTimeoutMs, concurrency })

          const jobs = serviceOf(ctx, 'jobs')
          if (jobs === undefined || jobs === null) {
            fail('后台作业服务不可用：这个预设里需要 tool-jobs（宿主默认带）。', 'no-jobs')
          }
          const subprocess = serviceOf(ctx, 'subprocess')
          if (subprocess === undefined || subprocess === null || typeof subprocess.spawn !== 'function') {
            fail('宿主没有 subprocess 服务，不能安全地起渲染进程；这一课先不渲染。', 'no-subprocess')
          }

          // 互斥（第一道，进程内快路径）：同一个工程一次只跑一个渲染作业（端口不用管，Remotion 会自己换）
          const slots = typeof deps?.renderSlots === 'object' && deps.renderSlots !== null ? deps.renderSlots : renderSlots
          const slot = slots.acquire(project.root, { mode, composition, relOut })
          if (slot === null) {
            const holder = slots.peek(project.root) ?? {}
            const holderJob = typeof holder.jobId === 'string' && holder.jobId.length > 0 ? holder.jobId : '（id 还没回填）'
            fail(
              '这个工程上已经有一个渲染作业在跑（' +
                String(holder.mode ?? '?') +
                ' ' +
                String(holder.composition ?? '?') +
                ' → ' +
                String(holder.relOut ?? '?') +
                '，job id：' +
                holderJob +
                '）。同一工程一次只跑一个：用 job_output 看它的进度，要停就 job_kill ' +
                holderJob +
                '，等它结束再起这一单。不要去杀端口上的进程 —— 那很可能就是它自己。',
              'render-busy'
            )
          }

          // 互斥（第二道，跨进程）：键 = 工程根 realpath，锁文件在 <工程根>/.dsh-teach/locks/。
          // 进程内槽位重启就清空，这一道才是「两个进程同时渲染同一工程」的屏障。
          let renderLock
          try {
            renderLock = acquireAnimationLock(project.root, {
              info: { mode, composition, output: relOut, lessonId: lessonId ?? '', jobId: '' }
            })
          } catch (error) {
            slots.release(project.root)
            if (error instanceof LockHeldError) fail(renderLockBusyMessage(error), 'render-busy')
            fail(
              '拿不到这个工程的跨进程渲染锁（' +
                animationLockDir(project.root) +
                '）：' +
                (error instanceof Error ? error.message : String(error)) +
                '。工程不可写时渲染本来也写不出 out/。',
              'lock-unavailable'
            )
          }

          try {
            let executable
            try {
              executable = await subprocess.resolveExecutable(binary)
            } catch (error) {
              fail('找不到可执行的 remotion（' + binary + '）：' + (error instanceof Error ? error.message : String(error)), 'deps-missing')
            }
            const command = executable + ' ' + argv.join(' ')
            const spec = {
              argv: [executable, ...argv],
              cwd: project.root,
              // 显式 stdio 与最小环境：CI 固定，其余由 subprocess 服务剔掉凭据后继承
              stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
              graceMs: 5000,
              env: { CI: '1' }
            }

            let workspace
            try {
              workspace = workspaceOf(exec?.agent)
            } catch {
              // 没有工作区就不能写档案；渲染照常，只记 path 的机会都没有
              workspace = undefined
            }

            // 课程版本在起手时定格：作业事件与产物事件都用它（拿不到/还没发布就是 null）
            const lessonRevision = lessonRevisionIn(workspace, lessonId)
            const jobInfo = { jobId: '', root: project.root, composition, mode, output: relOut, lessonRevision }

            const jobId = jobs.start({
              owner: exec?.agent?.session?.id ?? exec?.agent?.id,
              kind: 'teach-animation',
              label: mode + ' ' + composition + ' → ' + relOut,
              toolCall: exec?.callId === undefined ? undefined : { callId: exec.callId, rootCallId: exec.rootCallId ?? exec.callId },
              run: (jobHandle) => {
                // 作业一起手就回填 id：被互斥挡下的第二个调用才说得出「谁在跑」
                slot.jobId = String(jobHandle?.id ?? '')
                // 跨进程锁里也补上 job id：别的进程拿不到锁时要能说出是谁在跑
                try {
                  renderLock.update({ jobId: slot.jobId })
                } catch {
                  // 锁内信息回填失败不阻断渲染
                }
                // 起手先落一条 running：进程此刻死掉，重启后的 inspect 也能看到这个未完成作业
                noteJobState({
                  workspace,
                  info: { ...jobInfo, jobId: slot.jobId },
                  state: 'running',
                  log: (text) => jobHandle.append(text)
                })
                const hooks = startRenderHooks({
                  subprocess,
                  jobHandle,
                  spec,
                  command,
                  timeoutMs,
                  retries: RENDER_RETRIES,
                  retryDelayMs: RENDER_RETRY_DELAY_MS
                })
                // 作业结算（成功/失败/取消/超时）立刻释放互斥槽：抢的是渲染进程，不是归档
                hooks.done
                  .finally(() => {
                    try {
                      slots.release(project.root, slot.jobId)
                    } catch {
                      // 释放失败不该影响作业终态
                    }
                    try {
                      // 跨进程锁跟着作业结算释放；进程崩了留下的锁由 pid 判活回收
                      renderLock.release()
                    } catch {
                      // 锁文件删不掉不阻断作业终态：下次拿锁时按 pid 判活处理
                    }
                  })
                  .catch(() => {})
                // 结算：先把终态写进档案（同 jobId 覆盖），成功才归档；
                // 归档失败只写 job 日志，不改 job 终态（成片已经渲出来了）
                hooks.done
                  .then((outcome) => {
                    noteJobState({
                      workspace,
                      info: { ...jobInfo, jobId: slot.jobId },
                      state: terminalJobState(outcome),
                      log: (text) => jobHandle.append(text)
                    })
                    if (outcome?.status !== 'completed') return undefined
                    return recordRenderArtifact({
                      workspace,
                      lessonId,
                      lessonRevision,
                      project,
                      category,
                      slug,
                      mode,
                      relOut,
                      frame: mode === 'still' ? frame : null,
                      poster: mode === 'still' ? poster : false,
                      log: (text) => jobHandle.append(text)
                    })
                  })
                  .catch(() => {})
                return hooks
              }
            })

            return {
              jobId: String(jobId ?? ''),
              mode,
              output: relOut,
              command,
              ...(mode === 'still' ? { frame } : {}),
              poster: mode === 'still' ? poster : false,
              hint:
                '渲染在后台跑（显式并发，失败自动重试 1 次）：用 job_output 读进度；出片后会记进教学档案（lesson.artifact' +
                (mode === 'still' ? '，含帧号' : '') +
                '）。' +
                '别用 bash 直接调 remotion render/still：那会绕过本工具的跨进程互斥与产物归档' +
                '（生产账本只会计数，不会替你归档）。' +
                (mode === 'still'
                  ? '这一帧在 <root>/' + relOut + '：要嵌进课程的那张拷到工作区 out/ 或 assets/。'
                  : '把 <root>/' + relOut + ' 拷到课程页的 assets/ 或工作区 out/ 嵌入；封面帧用 mode=still + poster:true 单独抽。')
            }
          } catch (error) {
            // 起不来（可执行文件找不到、jobs.start 抛错等）：槽位与跨进程锁都要还回去，别把工程锁死
            slots.release(project.root)
            try {
              renderLock.release()
            } catch {
              // 与上面同理：残留锁由 pid 判活回收
            }
            throw error
          }
        }
      }),
    'teach-me.tool(teach_animation_render)'
  )
}

/**
 * 注册四个动画工具。
 * @param {object} ctx 预设作用域上下文
 * @param {() => object} getConfig 现取配置（设置页可能刚改过）
 * @param {(agent: object) => string} workspaceOf 取会话工作区
 * @param {object} [options] 测试注入口（options.render.renderSlots），运行期不传
 */
export function registerAnimationTools(ctx, getConfig, workspaceOf, options = {}) {
  const config = getConfig()
  if (!config.tools?.animation) return
  registerInspectTool(ctx, getConfig, workspaceOf)
  registerRegisterTool(ctx, getConfig)
  registerSyncTool(ctx, getConfig, workspaceOf)
  // options.render 是测试注入口（互斥槽位），运行期走模块级 renderSlots
  registerRenderTool(ctx, getConfig, workspaceOf, options.render)
}

export { FILE_RULES, MAX_FILE_BYTES, MAX_TOTAL_BYTES }
