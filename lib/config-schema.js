/* 设置行的 schemastery 结构。
 *
 * 只有 volatile 字段会出现在设置页、且能被用户改；entryRole 属于部署时的
 * 行属性，不进入表单，但必须声明，否则 Schema.resolve 会把它裁掉。
 */

import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  entryRole: z
    .string()
    .description('宿主行写 host，教学预设行写 runtime；旧配置缺省时按入口模块兼容。'),

  teaching: z.object({
    factCheck: z.string().description('默认事实核查：none / loose / moderate / strict；仅新会话采用。').volatile(),
    depth: z.string().description('默认讲解深度：shallow / moderate / deep；仅新会话采用。').volatile()
  }),

  prompt: z.object({
    stageLayering: z.boolean().description('按阶段族分层提示词（实验性，默认关闭；启用后未知阶段仍保留全量）。')
  }),

  animation: z.object({
    root: z
      .string()
      .description('Remotion 工程根目录（绝对路径）。留空 = 关闭动画。插件只被允许在这个目录里读写。')
      .volatile(),
    softLimitSeconds: z
      .number()
      .step(1)
      .min(10)
      .max(600)
      .description('一节课动画的软性上限（秒）。判据仍是「讲完」，超了在分镜里说明即可。')
      .volatile(),
    missing: z
      .string()
      .description('工程没配置或不存在时怎么办：skip = 安静跳过，warn = 在阶段回执里提醒。')
      .volatile(),
    staging: z
      .boolean()
      .description('是否把每课的动画源码放在工作区的 .dsh-teach-me/ 里再由插件同步进工程。')
      .volatile(),
    gateSkill: z
      .boolean()
      .description('写动画源码、同步或渲染之前，是否要求先在会话里加载 teach-animation 技能。技能不可用时自动放行。')
      .volatile(),
    frameTimeoutMs: z
      .number()
      .step(1000)
      .min(1000)
      .description('Remotion 单帧 delayRender 等待上限（毫秒）。不是整段渲染预算，整段预算由作业计时器负责。')
      .volatile()
  }),

  ledger: z.object({
    editBudget: z.number().step(1).min(1).description('单文件编辑次数参考线，超了在交付报告里点名。').volatile(),
    stepBudget: z.number().step(1).min(10).description('整课根调用步数参考线。').volatile()
  }),

  stages: z.object({
    allowSkip: z
      .boolean()
      .description('允许跳过教学阶段。true = 清单（跳阶只提醒）；false = 强制（set 只能进下一阶或留在当前阶，跨阶拒绝）。')
      .volatile()
  }),

  ask: z.object({
    gateWhileWaiting: z
      .boolean()
      .description('等学习者回答期间，是否拒绝依赖答案的写操作（默认是；读与状态查询始终放行）。')
      .volatile()
  }),

  workspace: z.object({
    teachingRoot: z
      .string()
      .description('教学根目录：绝对路径，或相对会话工作区的子目录。留空 = 用会话工作区本身；档案（.dsh-teach-me/archive）与课程路径都相对它。')
      .volatile()
  }),

  // 首次安装的欢迎页。宿主设置服务只允许写 volatile 字段（dsh-settings 的
  // isVolatilePath / volatileForm），所以这个标记必须自己是一个固定路径上的
  // volatile 字段，否则「关掉后不再出现」根本写不进去。
  // 语义：字段还是 false = 没看过（新装或从旧版本升上来），关一次写 true，此后不再弹。
  welcome: z.object({
    seen: z
      .boolean()
      .default(false)
      .description('首次安装的欢迎页是否已经看过。用户关闭后写 true，不再出现。')
      .volatile()
  })
})
