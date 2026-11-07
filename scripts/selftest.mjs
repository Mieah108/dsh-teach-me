#!/usr/bin/env node
/* 不装进 dsh 的预检：用一个假上下文把插件跑一遍。
 *
 * 它不能替代真实安装（服务契约、作用域、客户端都验不了），但能在装之前抓住
 * 九成的低级错误：模块起不来、注册漏了、工具定义形状不对、prompt 文件读不到、
 * lint 规则误报。跑法：node scripts/selftest.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✓' : '×'} ${name}${detail === '' ? '' : ' — ' + detail}`)
}

// —— 假上下文：只实现插件用到的那几个方法 ——
const captured = { tools: [], sections: [], variables: [], skills: [], guards: [], listeners: [], jobs: [] }

let activeQuestions = []

// 学习档案要真实工作区：自测只用一个临时目录，不碰真实课程
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-me-workspace-'))
fs.mkdirSync(path.join(workspaceDir, 'lessons'), { recursive: true })
fs.writeFileSync(path.join(workspaceDir, 'lessons', 'one.html'), '<!doctype html><html><body>自测课</body></html>')

const services = {
  teachPreferences: { ensure: async () => ({ factCheck: 'moderate', depth: 'moderate', collections: {} }) },
  sessionProjections: {
    stateOf: () => ({ questions: { active: activeQuestions, settled: [] } })
  },
  tools: {
    register: (definition) => {
      captured.tools.push(definition)
      return () => {}
    },
    guard: (guard) => {
      captured.guards.push(guard)
      return () => {}
    }
  },
  systemPrompt: {
    section: (section) => {
      captured.sections.push(section)
      return () => {}
    },
    variable: (name, provider) => {
      captured.variables.push({ name, provider })
      return () => {}
    },
    getSectionOrder: () => 100
  },
  skills: {
    register: (registration) => {
      captured.skills.push(registration)
      return () => {}
    }
  },
  workingDirectory: {
    get: () => workspaceDir
  },
  jobs: {
    // 渲染工具只在 execute 时才碰它；假实现够断言 argv 与返回值即可。
    start: (spec) => {
      captured.jobs.push(spec)
      return 'job-test-1'
    }
  }
}

const ctx = {
  get: (name) => services[name],
  provide: () => {},
  inject: (deps, callback) => callback(ctx),
  effect: (factory) => factory(),
  on: (event, listener) => {
    captured.listeners.push({ event, listener })
    return () => {}
  },
  logger: { info: () => {}, warn: (message) => console.log('  warn:', message) }
}

// —— 1. 模块能起来，注册数量对 ——
let plugin
try {
  plugin = await import(path.join(packageRoot, 'lib/index.js'))
  check('插件模块可导入', typeof plugin.apply === 'function', `name=${plugin.name} inject=${JSON.stringify(plugin.inject)}`)
} catch (error) {
  check('插件模块可导入', false, error.message)
  process.exit(1)
}

plugin.apply(ctx, {})
const toolNames = captured.tools.map((tool) => tool.name).sort()
check(
  '十九个工具都注册了（默认未配置动画：D1 起 4 个动画工具不常驻；提问交给宿主官方工具；P4 加自报/暂缓/模型批改/题目登记；P5 加受管检查/注册；0.4.0 加按需打开与教学根；v0.6.3-C 加 commit）',
  toolNames.join(',') ===
    'lesson_lint,teach_assessment_void,teach_commit,teach_defer,teach_evaluate,teach_fact_check_plan,teach_fact_check_record,teach_grade_open,teach_lesson_open,teach_lesson_publish,teach_material_index,teach_question_register,teach_report,teach_review,teach_self_report,teach_stage,teach_status,teach_submission_record,teach_workspace',
  toolNames.join(',')
)
check(
  '未配置动画时不下发 4 个动画工具（D1 条件化）',
  ['teach_animation_inspect', 'teach_animation_register', 'teach_animation_sync', 'teach_animation_render'].every((name) => !toolNames.includes(name)),
  toolNames.filter((name) => name.startsWith('teach_animation')).join(',')
)
check('不再注册同名 ask_user_question', !toolNames.includes('ask_user_question'), toolNames.join(','))
const statusTool = captured.tools.find((tool) => tool.name === 'teach_status')
const statusValue = await statusTool.execute({}, { agent: { id: 'agent-test' } })
check(
  '诊断工具能区分核心/可选/动画',
  typeof statusValue?.text === 'string' &&
    statusValue.text.includes('核心能力') &&
    statusValue.text.includes('可选能力') &&
    ['unconfigured', 'broken', 'degraded', 'ready'].includes(statusValue.animation),
  `healthy=${statusValue?.healthy} animation=${statusValue?.animation}`
)
check('诊断里有学习档案段', typeof statusValue?.text === 'string' && statusValue.text.includes('档案'))

// —— 1b. 档案工具真能发布一课并回到诊断里 ——
const publishTool = captured.tools.find((tool) => tool.name === 'teach_lesson_publish')
const publishValue = await publishTool.execute(
  { lessonId: 'selftest-lesson', path: 'lessons/one.html', title: '自测课' },
  { agent: { id: 'agent-test', session: { id: 'session-test' } } }
)
check('课程能发布进档案', publishValue?.ok === true && fs.existsSync(path.join(workspaceDir, '.dsh-teach-me', 'archive', 'journal')), publishValue?.text)

// 演练（dryRun）只核对、不落盘：committed:false，不写 journal，不出现 revision。
const dryValue = await publishTool.execute(
  { lessonId: 'selftest-dry', path: 'lessons/one.html', title: '演练课', dryRun: true },
  { agent: { id: 'agent-test', session: { id: 'session-test' } } }
)
check(
  '发布演练不落盘（committed:false、无 revision、不新增课程）',
  dryValue?.ok === true && dryValue.committed === false && dryValue.dryRun === true && dryValue.revision === undefined,
  dryValue?.text?.split('\n')[0]
)
const statusAgain = await statusTool.execute({}, { agent: { id: 'agent-test', session: { id: 'session-test' } } })
check(
  '诊断读到刚发布的课，且演练没有多出一课',
  typeof statusAgain?.text === 'string' && statusAgain.text.includes('课程 1'),
  typeof statusAgain?.text === 'string' ? statusAgain.text.split('\n').find((line) => line.includes('课程')) : ''
)

// —— 1c. teach_commit：一次完成发布+登记，同 key 幂等、异内容冲突 ——
const commitTool = captured.tools.find((tool) => tool.name === 'teach_commit')
const commitExec = { agent: { id: 'agent-test', session: { id: 'session-test' } } }
const commitArgs = {
  lessonId: 'selftest-commit',
  path: 'lessons/one.html',
  idempotencyKey: 'selftest-commit-key',
  questions: [{ questionId: 'sc-q1', lessonId: 'selftest-commit', type: 'short', prompt: '自测题：说清一个判据。', answer: '可复现' }]
}
const commitValue = await commitTool.execute(commitArgs, commitExec)
check(
  'commit 一次完成发布与登记',
  commitValue?.ok === true && commitValue.lessonRevision === 1 && commitValue.idempotent === false && commitValue.committed === true,
  `step=${commitValue?.step} lessonRevision=${commitValue?.lessonRevision}`
)
const commitAgain = await commitTool.execute(commitArgs, commitExec)
check(
  'commit 同 key 同内容幂等（不重复写）',
  commitAgain?.ok === true && commitAgain.idempotent === true && commitAgain.committed === false && commitAgain.lessonRevision === 1,
  `step=${commitAgain?.step}`
)
const commitConflict = await commitTool.execute(
  { ...commitArgs, questions: [{ questionId: 'sc-q1', lessonId: 'selftest-commit', type: 'short', prompt: '换个问法？', answer: '可复现' }] },
  commitExec
)
check(
  'commit 同 key 异内容明确冲突且不重试',
  commitConflict?.ok === false && commitConflict.error === 'idempotency-conflict' && commitConflict.recoverable === false && commitConflict.nextAction === 'use-new-key',
  `${commitConflict?.error} / ${commitConflict?.nextAction}`
)

// —— 1c. P4：题目登记 → 原始提交 → 到期复习 → 模型批改入口 ——
const EXEC = { agent: { id: 'agent-test', session: { id: 'session-test' } } }

const questionTool = captured.tools.find((tool) => tool.name === 'teach_question_register')
check(
  '题目登记工具参数里没有判定字段',
  !/verdict|passed|correct|score/i.test(JSON.stringify(questionTool.parameters)) && JSON.stringify(questionTool.parameters).includes('retired'),
  JSON.stringify(questionTool.parameters.properties.status?.enum ?? [])
)
const registered = await questionTool.execute(
  {
    questionId: 'selftest-open',
    lessonId: 'selftest-lesson',
    type: 'explanation',
    prompt: '为什么深网络的梯度会消失？',
    rubric: [{ id: 'mechanism', text: '讲清连乘机制' }]
  },
  EXEC
)
check('开放题能登记进档案', registered?.ok === true && registered.questionRevision === 1, registered?.text)

const submissionTool = captured.tools.find((tool) => tool.name === 'teach_submission_record')
const submissionValue = await submissionTool.execute(
  { questionId: 'selftest-open', rawAnswer: '因为雅可比连乘，谱范数普遍小于 1。', source: 'chat' },
  EXEC
)
// 待复核的提交没有评估：工具出口会剪掉 null，所以字段是缺省而不是 null。
check(
  '开放题原始答案先入库，自己不判分',
  submissionValue?.ok === true && submissionValue.status === 'pending' && (submissionValue.assessmentId === undefined || submissionValue.assessmentId === null),
  submissionValue?.text
)

const gradeTool = captured.tools.find((tool) => tool.name === 'teach_grade_open')
check(
  '模型批改工具参数里没有判定字段',
  !/verdict|passed|correct|score/i.test(JSON.stringify(gradeTool.parameters)) &&
    JSON.stringify(gradeTool.parameters.required) === JSON.stringify(['submissionId'])
)
const graded = await gradeTool.execute({ submissionId: submissionValue.submissionId }, EXEC)
check(
  '没有 llm 时模型批改明确失败且不伪造通过',
  graded?.ok === false && graded.verdict === 'needs_review' && graded.failure === 'llm-unavailable' && graded.text.includes('不是通过'),
  `${graded?.failure} / ${graded?.verdict}`
)

const reviewTool = captured.tools.find((tool) => tool.name === 'teach_review')
const scheduled = await reviewTool.execute({ action: 'schedule', questionId: 'selftest-open', dueAt: '2020-01-01T00:00:00.000Z' }, EXEC)
check('能安排一次到期复习', scheduled?.ok === true && scheduled.reviewId !== undefined, scheduled?.text)
const dueList = await reviewTool.execute({ action: 'due' }, EXEC)
check(
  'teach_review due 列出到期复习的 id 与 overdue 天数',
  dueList?.ok === true && dueList.dueReviews?.some((item) => item.id === scheduled.reviewId && item.overdueDays > 0) && dueList.text.includes(scheduled.reviewId),
  dueList?.text.split('\n')[0]
)

const statusWithArchive = await statusTool.execute({}, EXEC)
check(
  '诊断档案段列出到期复习 id、自报/暂缓与不是通过',
  statusWithArchive.text.includes(scheduled.reviewId) &&
    statusWithArchive.text.includes('自报与暂缓都不是通过') &&
    statusWithArchive.text.includes('待复核 1'),
  statusWithArchive.text.split('\n').find((line) => line.includes('到期复习')) ?? ''
)

const finished = await reviewTool.execute({ action: 'finish', reviewId: scheduled.reviewId, result: 'skipped' }, EXEC)
const dueAfter = await reviewTool.execute({ action: 'due' }, EXEC)
check(
  '跳过复习后队列清空，跳过不产生通过',
  finished?.ok === true && finished.result === 'skipped' && dueAfter.dueCount === 0,
  dueAfter?.text.split('\n')[0]
)
const reportTool = captured.tools.find((tool) => tool.name === 'teach_self_report')
const selfReport = await reportTool.execute({ id: 'selftest-sr', claim: '自测全对', questionId: 'selftest-open' }, EXEC)
check('自报只记 self_report 且明说不是通过', selfReport?.ok === true && selfReport.text.includes('不是评估通过'), selfReport?.text)
const deferTool = captured.tools.find((tool) => tool.name === 'teach_defer')
const deferred = await deferTool.execute({ questionId: 'selftest-open', reason: '先放一放', until: '2026-12-01' }, EXEC)
check('暂缓单独记录且明说不是通过', deferred?.ok === true && /暂缓不是通过/.test(deferred.text) && deferred.until === '2026-12-01T00:00:00.000Z', deferred?.text)
const summaryAfter = await statusTool.execute({}, EXEC)
check(
  '自报与暂缓计数进档案段，通过数仍是 0',
  summaryAfter.text.includes('自报 1 / 暂缓 1') && summaryAfter.text.includes('通过 0'),
  summaryAfter.text.split('\n').find((line) => line.includes('自报')) ?? ''
)
check(
  '提示词段都读了（未配置动画：8 段，60-animation 不常驻）',
  captured.sections.length === 8 && !captured.sections.some((s) => s.name === 'teach:60-animation'),
  `${captured.sections.length} 段：${captured.sections.map((s) => s.name).join(', ')}`
)
check('提示词变量都注册了（4 个包内路径 + 4 个运行期）', captured.variables.length === 8, captured.variables.map((v) => v.name).join(','))
check('动画路径与软上限是变量（提示词里不写死路径）', captured.variables.some((v) => v.name === 'teach_animation_root') && captured.variables.some((v) => v.name === 'teach_animation_soft_limit'))
check('随包技能都注册了', captured.skills.length === 2, captured.skills.map((s) => `${s.name}(${s.source})`).join(', '))
check('技能带资源目录', captured.skills.every((s) => s.resourceBase?.kind === 'directory' && fs.existsSync(s.resourceBase.path)))
check('技能允许模型调用', captured.skills.every((s) => s.invocation?.modelInvocable === true))
check('注册了 pre-execute 监听', captured.listeners.some((l) => l.event === 'tools/pre-execute'))

// waterfall 事件必须调用并返回 next()：返回 undefined 会让调度层的 gate 变 undefined，
// 宿主读 gate.kind 直接崩，症状是整个 run_code 全线失败（真实踩过）。
const preExecute = captured.listeners.find((item) => item.event === 'tools/pre-execute')
let forwarded
try {
  forwarded = await preExecute.listener({ name: 'read', arguments: {}, callId: 'selftest' }, async () => ({ kind: 'allow' }))
} catch (error) {
  forwarded = error
}
check('pre-execute 监听转发 next', forwarded?.kind === 'allow', `拿到 ${JSON.stringify(forwarded?.kind ?? String(forwarded))}`)

// —— 2. 工具定义形状（宿主按 JSON Schema 生成 schema，别用真 spec 对象）——
// 汇总成一条断言：工具数会随配置变化（D1 起 17 / 21），逐条 check 会让"总数"跟着漂，
// 每次加工具都要在证据里解释 −N/+N。形状坏掉的工具名会全部列出来。
const malformedTools = captured.tools.filter(
  (tool) =>
    !(
      typeof tool.description === 'string' &&
      tool.description.length > 20 &&
      tool.parameters !== null &&
      typeof tool.parameters === 'object' &&
      (tool.parameters.type === 'object' || tool.parameters.type === undefined) &&
      typeof tool.output?.schema === 'object' &&
      typeof tool.output?.render === 'function' &&
      typeof tool.execute === 'function'
    )
)
check(
  '所有工具定义形状正确（description/parameters/output.schema/render/execute）',
  malformedTools.length === 0 && captured.tools.length > 0,
  malformedTools.length === 0 ? `${captured.tools.length} 个` : malformedTools.map((tool) => tool.name).join(',')
)

// —— 3. 闸门：候答 + 技能前置 ——
check('三道闸门都注册了（核查预算 + 候答 + 技能前置）', captured.guards.length === 3, String(captured.guards.length))
const guardExec = (name, extra = {}) => ({ name, arguments: {}, agent: { session: {} }, ...extra })
activeQuestions = [{ callId: 'call-1', questions: [] }]
const waitingGuard = captured.guards.find((guard) => typeof guard(guardExec('write')) === 'string')
check('候答闸门已注册', typeof waitingGuard === 'function', String(captured.guards.length))
const blocked = waitingGuard(guardExec('write'))
check('候答时拦住写操作', typeof blocked === 'string' && blocked.includes('call-1'), String(blocked).slice(0, 40))
// run_code 是传输层：整条拦住会把候答期间的读/查/诊断也冻死（0.6.0 真实症状）。
check('候答时放行普通 run_code', waitingGuard(guardExec('run_code')) === undefined)
check(
  '候答时拦住带 sandbox_permissions 的提权 run_code',
  typeof waitingGuard(guardExec('run_code', { arguments: { sandbox_permissions: 'danger-full-access' } })) === 'string'
)
check('候答时放行读', waitingGuard(guardExec('read')) === undefined)
check('候答时放行阶段查询', waitingGuard(guardExec('teach_stage')) === undefined)
activeQuestions = []
check('回答之后自动放行', waitingGuard(guardExec('write')) === undefined)
check('没有会话时不拦', waitingGuard({ name: 'write', arguments: {} }) === undefined)

// 技能闸门：写动画源码/同步/渲染之前必须先加载 teach-animation。
const skillGuard = captured.guards.at(-1)
check('技能闸门已注册', typeof skillGuard === 'function')
const animationWrite = (sessionId) => ({
  name: 'write',
  arguments: { file_path: '/w/.dsh-teach-me/animation-src/0001/demo/Comp.tsx' },
  agent: { session: { id: sessionId } }
})
check(
  '没加载技能时拦动画源码写入',
  typeof skillGuard(animationWrite('session-skill')) === 'string',
  String(skillGuard(animationWrite('session-skill'))).slice(0, 30)
)
check('非动画写入不受技能闸门影响', skillGuard({ ...animationWrite('session-skill'), arguments: { file_path: '/w/lessons/one.html' } }) === undefined)
check(
  '读技能正文放行并成为见证',
  skillGuard({
    name: 'read',
    arguments: { file_path: '/pkg/skills/teach-animation/SKILL.md' },
    agent: { session: { id: 'session-skill' } }
  }) === undefined
)
check('加载后源码写入放行', skillGuard(animationWrite('session-skill')) === undefined)
check(
  'dry_run 同步不需要前置技能',
  skillGuard({ name: 'teach_animation_sync', arguments: { dry_run: true }, agent: { session: { id: 'session-dry' } } }) === undefined
)

// —— 4. lint：拿合成课程页和刻意写坏的文件各跑一遍 ——
const { lintHtml } = await import(path.join(packageRoot, 'lib/lint.js'))
// 干净页的依赖要真实存在：lint 现在按真实 script/link 标签查本地文件
const lintDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-me-lint-'))
fs.mkdirSync(path.join(lintDir, 'assets/mathjax'), { recursive: true })
for (const name of ['course.css', 'course.js', 'mathjax/tex-svg.js']) fs.writeFileSync(path.join(lintDir, 'assets', name), '')
const fixtureGood = `<!doctype html><html><head><link rel="stylesheet" href="assets/course.css"></head><body>
<p>公式 $\\mathbf{q}^\\top$ 在这里，独立公式：</p>
<div class="eq">$$\\frac{\\mathbf{q}\\mathbf{K}^\\top}{\\sqrt{d_k}}$$</div>
<table><thead><tr><th>符号</th><th>含义</th></tr></thead><tbody><tr><td>$\\mathbf{q}$</td><td>查询</td></tr></tbody></table>
<div class="quiz" data-explain="ok" data-scope="ok"><input type="radio" name="q1" data-ok="1"></div>
<script src="assets/course.js"></script><script async src="assets/mathjax/tex-svg.js"></script></body></html>`
check('干净页无硬伤', lintHtml(fixtureGood, path.join(lintDir, 'fixture-good.html')).filter((issue) => issue.level === 'error').length === 0)

const bell = String.fromCharCode(7) // 模拟 \t、\b 之类被代码字符串解释掉的转义
const fixtureBad = `<!doctype html><html><body>
<p>〔这里要填〕</p>
<p>裸公式 a = \\frac{qK^T}{\\sqrt{d_k}}</p>
<p>中文进公式 $\\text{注意力}$</p>
<p>被吃掉的转义：$${bell}heta_i$</p>
<div class="eq">$$\\alpha$$</div>
<p>这三道验收题请做完。</p>
<table><tr><td>没有表头</td></tr></table>
<div class="quiz"><input type="radio" data-ok="1"><input type="radio" data-ok="1"></div>
<img src="does-not-exist.png">
</body></html>`
const badIssues = lintHtml(fixtureBad, path.join(lintDir, 'fixture-bad.html'))
const codes = new Set(badIssues.map((issue) => issue.code))
const expected = ['placeholder', 'bare-latex', 'cjk-in-math', 'control-chars', 'no-mathjax', 'no-course-js', 'no-course-css', 'table-no-thead', 'quiz-correct', 'quiz-scope', 'quiz-count-claim', 'img-missing']
check('坏页每个问题都被抓到', expected.every((code) => codes.has(code)), [...codes].join(','))

// Markdown 也要查：学习记录里踩过 \theta 被吃成 TAB 的坑
const { lintMarkdown } = await import(path.join(packageRoot, 'lib/lint.js'))
const mdBadIssues = lintMarkdown('# 记录\n\n公式 $' + bell + 'heta_i$ 坏了\n\n$$\\alpha\n', path.join(packageRoot, 'fixture-bad.md'))
const mdCodes = new Set(mdBadIssues.map((issue) => issue.code))
check('Markdown 坏页被抓到', mdCodes.has('control-chars') && mdCodes.has('unbalanced'), [...mdCodes].join(','))
check('Markdown 干净页无硬伤', lintMarkdown('# 记录\n\n公式 $\\theta_i$ 正常。\n\n$$\\alpha$$\n', path.join(packageRoot, 'fixture-good.md')).length === 0)

// 随仓库发布的合成例课，所有机器检查相同的输入。
const lessonsDir = path.join(packageRoot, 'templates', 'examples', 'lessons')
const exampleFiles = ['components.html', 'reuse.html']
for (const name of exampleFiles) {
  const file = path.join(lessonsDir, name)
  const issues = lintHtml(fs.readFileSync(file, 'utf8'), file)
  check(`随包例课 ${name} 无硬伤`, issues.every((issue) => issue.level !== 'error'), `${issues.length} 条诊断`)
}

// —— 5. teach_report 能跑 ——
const report = captured.tools.find((tool) => tool.name === 'teach_report')
const reportValue = await report.execute({}, { agent: { id: 'agent-test' } })
check('账本报告可执行', typeof reportValue?.text === 'string' && reportValue.text.includes('账本'), reportValue?.text.split('\n')[0])
check('账本区分根调用与子调用', reportValue.text.includes('根调用') && reportValue.text.includes('子调用'))

// —— 6. teach_stage 十阶齐全 ——
const stageTool = captured.tools.find((tool) => tool.name === 'teach_stage')
// 真实宿主执行工具时一定带 session；阶段要据此解析工作区才能把状态写进档案。
const stageExec = { agent: { id: 'agent-test', session: { id: 'session-test' } } }
const shown = await stageTool.execute({ action: 'show' }, stageExec)
check('阶段工具可执行', typeof shown?.text === 'string' && shown.stage === 'intake', shown?.text.split('\n')[0])
check('阶段工具自述要求每阶调用', /stage/i.test(stageTool.description) && stageTool.description.length > 40)
const advanced = await stageTool.execute({ action: 'advance' }, stageExec)
check('阶段能推进并记住走过的阶', advanced.stage === 'diagnose' && advanced.text.includes('已走过'), advanced.text.split('\n').find((line) => line.includes('已走过')) ?? '')
check(
  '阶段写进档案（persisted/source 如实）',
  advanced.persisted === true && advanced.source === 'archive' && advanced.runRevision === 1,
  `persisted=${advanced.persisted} source=${advanced.source} runRevision=${advanced.runRevision}`
)
// 重启等价：新注册一个阶段工具实例（内存 Map 是空的），只靠档案投影恢复。
let restartedStage
const restartedCtx = {
  get: (name) => (name === 'tools' ? { register: (definition) => { restartedStage = definition; return () => {} } } : undefined),
  effect: (factory) => factory()
}
const { registerStageTool: registerStageToolAgain } = await import(path.join(packageRoot, 'lib/stages.js'))
const { resolveConfig: resolveStageConfig } = await import(path.join(packageRoot, 'lib/config.js'))
registerStageToolAgain(restartedCtx, () => resolveStageConfig({}, undefined), packageRoot, () => workspaceDir)
const restoredStage = await restartedStage.execute({ action: 'show' }, stageExec)
check(
  '重启后从档案恢复阶段（新实例、无内存）',
  restoredStage.stage === 'diagnose' && restoredStage.source === 'archive' && restoredStage.persisted === true,
  `stage=${restoredStage.stage} source=${restoredStage.source} runRevision=${restoredStage.runRevision}`
)
const buildStage = await stageTool.execute({ action: 'set', stage: 'video-build' }, stageExec)
check('阶段清单里的变量已替换（不留 {{ }}）', !buildStage.text.includes('{{'), buildStage.text.split('\n')[0])
check('没配工程时阶段说明指向设置页', buildStage.text.includes('未配置工程') && buildStage.text.includes('设置'), (buildStage.text.match(/动画：.*/) ?? [''])[0])

// —— 7. 设置层：配置优先级 ——
const { resolveConfig, DEFAULTS } = await import(path.join(packageRoot, 'lib/config.js'))
const settingsModule = await import(path.join(packageRoot, 'lib/settings.js'))
check('设置行可导入且有名字', typeof settingsModule.apply === 'function' && settingsModule.name === 'teach-settings', settingsModule.name)
const provided = {}
const settingsCtx = { provide: (name, value) => { provided[name] = value }, logger: { warn: () => {} } }
settingsModule.apply(settingsCtx, { animation: { root: '/tmp/proj' } })
check('设置行暴露只读服务', typeof provided.teachSettings?.get === 'function' && provided.teachSettings.get().animation.root === '/tmp/proj')
const settingsJson = typeof settingsModule.Config?.toJSON === 'function' ? JSON.stringify(settingsModule.Config.toJSON()) : ''
check('设置项是 schemastery（能进自动表单）', settingsJson.includes('animation') && settingsJson.includes('softLimitSeconds'), `${settingsJson.length} 字符`)
check('默认没有工程（包里不写机器路径）', resolveConfig({}, undefined).animation.enabled === false && DEFAULTS.animation.root === '')
check('设置页填了路径才启用', resolveConfig({}, { animation: { root: '/tmp/proj' } }).animation.enabled === true)
check('设置页优先于预设行', resolveConfig({ animation: { softLimitSeconds: 90 } }, { animation: { softLimitSeconds: 45 } }).animation.softLimitSeconds === 45)
check('设置页没填的键不覆盖预设行', resolveConfig({ animation: { root: '/row-project' } }, { animation: { softLimitSeconds: 60 } }).animation.root === '/row-project')
check('用户清空路径等于关掉动画', resolveConfig({ animation: { root: '/row-project' } }, { animation: { root: '' } }).animation.enabled === false)
check('软上限落非数时回落 120', resolveConfig({ animation: { softLimitSeconds: '很快' } }, undefined).animation.softLimitSeconds === 120)
check(
  '技能闸门默认开、单帧等待默认 30 秒',
  DEFAULTS.animation.gateSkill === true && DEFAULTS.animation.frameTimeoutMs === 30000,
  `${DEFAULTS.animation.gateSkill} / ${DEFAULTS.animation.frameTimeoutMs}`
)
check('单帧等待坏值回落 30 秒（填 0 不会让渲染必死）', resolveConfig({ animation: { frameTimeoutMs: 0 } }, undefined).animation.frameTimeoutMs === 30000)

// —— 8. 权限围栏：只能写工程根里允许的路径 ——
const { openProject, ProjectError } = await import(path.join(packageRoot, 'lib/sandbox.js'))
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teach-me-selftest-'))
const projectDir = path.join(tmpRoot, 'project')
fs.mkdirSync(path.join(projectDir, 'src/videos/LLM/demo'), { recursive: true })
fs.mkdirSync(path.join(projectDir, 'out/LLM'), { recursive: true })
const outsideDir = path.join(tmpRoot, 'outside')
fs.mkdirSync(outsideDir, { recursive: true })
try { fs.symlinkSync(outsideDir, path.join(projectDir, 'escape-link'), 'dir') } catch {}
const guard = openProject(projectDir)
const denied = (rel) => {
  try {
    guard.checkWritable(rel)
    return false
  } catch (error) {
    return error instanceof ProjectError
  }
}
check('允许写新课源码', guard.checkWritable('src/videos/LLM/demo/index.tsx') === 'src/videos/LLM/demo/index.tsx')
check('允许写 Root.tsx', guard.checkWritable('src/Root.tsx') === 'src/Root.tsx')
check('允许写成片', guard.checkWritable('out/LLM/demo.mp4') === 'out/LLM/demo.mp4')
check('禁写 package.json', denied('package.json'))
check('禁写 node_modules', denied('node_modules/remotion/index.js'))
check('禁写 .git', denied('.git/config'))
check('禁写锁文件', denied('pnpm-lock.yaml'))
check('禁写路径逃逸 ../', denied('../outside.txt'))
check('禁写绝对路径', denied('/etc/passwd'))
check('禁写软链逃逸', denied('escape-link/evil.ts'))
check('读工程外文件被拒', denied('../../etc/hosts'))
check('根不存在时报 root-missing', (() => {
  try {
    openProject(path.join(tmpRoot, 'nope'))
    return false
  } catch (error) {
    return error instanceof ProjectError && error.code === 'root-missing'
  }
})())
const wrote = guard.write('src/videos/LLM/demo/index.tsx', 'export default 1\\n')
check('写入与读回一致', wrote === 'src/videos/LLM/demo/index.tsx' && guard.read('src/videos/LLM/demo/index.tsx') === 'export default 1\\n')
fs.rmSync(tmpRoot, { recursive: true, force: true })

// —— 9. 动画工具：inspect/register/sync/render（D1 起「配了工程」才注册）——
// 默认配置（未配置动画）不下发这 4 个工具；这里用「配了但目录不存在」的工程再跑一遍
// runtime，验证工具形状与失败语义。
const toolsBefore = captured.tools.length
const sectionsBefore = captured.sections.length
plugin.apply(ctx, { animation: { root: path.join(os.tmpdir(), 'teach-me-missing-project') } })
// 第二次 apply 会把整套工具重注册一遍（21 个），这里只挑出动画那 4 个。
const repluggedTools = captured.tools.slice(toolsBefore)
const animationTools = repluggedTools.filter((tool) => tool.name.startsWith('teach_animation_'))
check(
  '配了动画工程后 4 个动画工具出现（该次共 23 个）',
  animationTools.length === 4 &&
    repluggedTools.length === 23 &&
    animationTools.map((tool) => tool.name).sort().join(',') ===
      'teach_animation_inspect,teach_animation_register,teach_animation_render,teach_animation_sync',
  animationTools.map((tool) => tool.name).join(',')
)
const animatedSections = captured.sections.slice(sectionsBefore).map((section) => section.name)
check('配了动画工程后 60-animation 段回来', animatedSections.includes('teach:60-animation'), animatedSections.join(','))
const syncTool = animationTools.find((tool) => tool.name === 'teach_animation_sync')
const renderTool = animationTools.find((tool) => tool.name === 'teach_animation_render')
const inspectTool = animationTools.find((tool) => tool.name === 'teach_animation_inspect')
const registerTool = animationTools.find((tool) => tool.name === 'teach_animation_register')
check('sync 工具形状正确', syncTool.parameters?.required?.includes('category') === true && syncTool.parameters?.required?.includes('slug') === true)
check('render 工具有 mode: still|render', JSON.stringify(renderTool.parameters).includes('still') && JSON.stringify(renderTool.parameters).includes('render'))
const inspectStates = inspectTool?.output?.schema?.properties?.state?.enum ?? []
check(
  'inspect 工具给出七档可用性',
  inspectStates.join(',') === 'unconfigured,missing-root,not-a-project,deps-missing,invalid-entry,not-integrated,ready',
  inspectStates.join(',')
)
const inspected = await inspectTool.execute({}, { agent: { id: 'agent-test' } })
check(
  '工程目录不存在时 inspect 报 missing-root 且不写文件',
  inspected?.state === 'missing-root' && inspected?.ready === false && inspected?.diff === '' && inspected?.writes?.length === 0,
  String(inspected?.state)
)
let registerError
try {
  await registerTool.execute({ confirm: true }, { agent: { id: 'agent-test' } })
} catch (error) {
  registerError = error
}
check(
  '工程目录不存在时 register 明确失败',
  registerError?.code === 'missing-root' || registerError?.code === 'root-missing',
  String(registerError?.code)
)
check(
  'register 默认是 dry_run',
  registerTool.parameters?.properties?.confirm?.type === 'boolean' &&
    JSON.stringify(registerTool.parameters?.required ?? []) === '[]',
  String(registerTool.parameters?.properties?.confirm?.type)
)

// —— 10. 预设与包清单自洽 ——
const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
check('包名与插件行一致', pkg.name === 'dsh-teach-me')
check('清单有 main/exports', typeof pkg.main === 'string' && typeof pkg.exports === 'object')
check('bundle patch 是数组', Array.isArray(pkg.dsh?.bundle?.patch))
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'skills/UPSTREAM.json'), 'utf8'))
check('技能快照清单在', Object.keys(manifest.skills).length === 2, Object.keys(manifest.skills).join(','))
for (const [name, info] of Object.entries(manifest.skills)) {
  check(`技能快照 ${name} 文件数`, fs.readdirSync(path.join(packageRoot, 'skills', name)).length > 0 && Array.isArray(info.files) && info.files.length > 0, `${info.files?.length ?? 0} 个`)
}

// —— 11. 客户端半：设置 → 教学模式 这一页 ——
const clientSource = fs.readFileSync(path.join(packageRoot, 'client.js'), 'utf8')
let clientDef
const fakeWindow = { __ModuleLoader__: { load: (def) => { clientDef = def } } }
new Function('window', clientSource)(fakeWindow)
check('client.js 注册了模块工厂', clientDef !== undefined && typeof clientDef.factory === 'function')
check('客户端工厂 id 等于包名', clientDef.id === pkg.name, String(clientDef.id))
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn()
}
const clientModule = clientDef.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error('unexpected require: ' + name)
})
check('客户端半导出 inject 与 apply', Array.isArray(clientModule.inject) && typeof clientModule.apply === 'function', clientModule.inject.join(','))
check(
  '客户端半 inject 声明了 slots/locale/configForms/sidebarRightTabs/sidebarRight',
  JSON.stringify(clientModule.inject) === JSON.stringify(['slots', 'locale', 'configForms', 'sidebarRightTabs', 'sidebarRight']),
  clientModule.inject.join(',')
)

const seats = []
const injectedSeats = []
let servedSeed
let localeDict
let classroomDefinition
const formStub = {
  getSnapshot: () => ({ status: 'ready', writable: true, value: { animation: { root: '/tmp/anim-project', softLimitSeconds: 120 } } }),
  mutate: async () => ({})
}
const clientCtx = {
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  locale: {
    register: (ns, dicts) => {
      localeDict = dicts.zh
      return () => {}
    },
    bind: (ns) => (key) => (localeDict && localeDict[key] !== undefined ? localeDict[key] : key)
  },
  configForms: {
    get: (ns) => {
      check('客户端半按行 id 取配置', ns === 'teach-settings', String(ns))
      return formStub
    },
    whileServed: (namespaces, register) => {
      servedSeed = namespaces
      register()
      return () => {}
    }
  },
  sidebarRightTabs: {
    register: (definition) => {
      classroomDefinition = definition
      return () => {}
    }
  },
  connection: {
    rpc: { call: async () => ({ ok: true, value: {} }) }
  },
  slots: {
    inject: (seat, register) => {
      injectedSeats.push(seat)
      register()
      return () => {}
    },
    register: (seat, component) => {
      seats.push({ seat, component })
      return () => {}
    }
  }
}
clientModule.apply(clientCtx)
const settingsSeats = seats.filter((item) => item.seat && item.seat.name === 'settings.section')
check('客户端半只注册一个设置页', settingsSeats.length === 1, String(settingsSeats.length))
const seatSpec = settingsSeats[0]
check('设置页 id 是 teach-me', seatSpec?.seat?.id === 'teach-me', String(seatSpec?.seat?.id))
check('设置页 order 是 60', seatSpec?.seat?.order === 60, String(seatSpec?.seat?.order))
check('设置页只在 teach-settings 被服务时挂', JSON.stringify(servedSeed) === JSON.stringify(['teach-settings']), JSON.stringify(servedSeed))
check(
  '客户端半注册课堂 tab 类型',
  classroomDefinition !== undefined && classroomDefinition.kind === 'teach-classroom' && classroomDefinition.priority === 'extension',
  classroomDefinition?.kind ?? 'missing'
)
check(
  '课堂 tab 只接管 lessons/*.html',
  classroomDefinition?.canOpen('dsh-resource://file/session/s1/lessons/one.html') === true &&
    classroomDefinition?.canOpen('dsh-resource://file/session/s1/notes/one.html') === false,
  String(classroomDefinition?.canOpen?.('dsh-resource://file/session/s1/lessons/one.html'))
)
check(
  '客户端半注册课堂 body/title 插槽',
  injectedSeats.includes('sidebar.right.pane.tab') && injectedSeats.includes('sidebar.right.pane.tab.title'),
  injectedSeats.join(',')
)
const paneSeats = seats.filter((item) => item.seat && item.seat.name === 'sidebar.right.pane.tab')
const classroomBody = paneSeats.find((item) => item.seat.key === 'dsh-teach-me')
const coursesBody = paneSeats.find((item) => item.seat.key === 'dsh-teach-me/courses')
const classroomFace = classroomBody?.seat?.inject?.('session-test')
check(
  '课堂 body 拿到 session、按地址/按课 id 打开与 RPC 句柄',
  classroomFace?.sessionId === 'session-test' &&
    typeof classroomFace.address === 'function' &&
    typeof classroomFace.lesson === 'function' &&
    typeof classroomFace.callRpc === 'function' &&
    typeof classroomFace.openCourses === 'function',
  Object.keys(classroomFace ?? {}).join(',')
)
const coursesFace = coursesBody?.seat?.inject?.('session-test')
check(
  '选课列表 body 拿到 session 与“按课 id 打开”',
  coursesFace?.sessionId === 'session-test' && typeof coursesFace.openLessonById === 'function' && typeof coursesFace.callRpc === 'function',
  String(coursesBody?.seat?.key)
)
check('设置页标题走 locale', typeof seatSpec?.seat?.label === 'function' && typeof seatSpec.seat.label() === 'string' && seatSpec.seat.label().length > 0, seatSpec?.seat?.label?.())
const face = seatSpec?.seat?.inject?.()
check('设置页拿到 config 句柄与写函数', face?.hooks?.config === formStub && typeof face.write === 'function')
let rendered
try {
  rendered = seatSpec.component({
    t: (key) => (localeDict && localeDict[key] !== undefined ? localeDict[key] : key),
    useConfig: (selector) => selector(formStub.getSnapshot()),
    write: async () => true
  })
  check('设置页能渲染', rendered !== undefined && rendered !== null)
  const nodes = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    nodes.push(node)
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  }
  walk(rendered)
  const find = (predicate) => nodes.find(predicate)
  const rootLabel = find((node) => node.type === 'label' && node.props?.htmlFor === 'teach-me-animation-root')
  const rootInput = find((node) => node.type === 'input' && node.props?.id === 'teach-me-animation-root')
  const notice = find((node) => node.props?.role === 'status')
  check('设置页字段有可点击的 label', rootLabel !== undefined && rootInput !== undefined)
  check('路径输入框说明了提示位置', rootInput?.props?.['aria-describedby'] === 'teach-me-animation-root-hint')
  check('保存状态对读屏可播报', notice?.props?.['aria-live'] === 'polite')
} catch (error) {
  check('设置页能渲染', false, String(error && error.message))
}
const loadingSeat = seatSpec.component({
  t: (key) => key,
  useConfig: (selector) => selector({ status: 'loading', writable: false, value: undefined }),
  write: async () => true
})
check('设置页在未就绪时也能渲染', loadingSeat !== undefined && loadingSeat !== null)
check('清单 declares dsh.client', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client?.platform))
check('导出了 ./client 子路径', pkg.exports?.['./client'] === './client.js', String(pkg.exports?.['./client']))
check('files 含 client.js', Array.isArray(pkg.files) && pkg.files.includes('client.js'))

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：' + failed.map((f) => f.name).join('、'))
  process.exitCode = 1
}
