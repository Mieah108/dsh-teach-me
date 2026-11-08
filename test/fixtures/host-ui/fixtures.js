/**
 * Host UI bench fixtures: the data every host surface (settings / courses / classroom) is rendered with.
 *
 * 这个文件同时被两侧读：
 *   - `scripts/qa-host-ui.mjs`（Node）读 `SURFACES` 拿状态清单、等待条件与交互；
 *   - `test/fixtures/host-ui/entry.js`（浏览器，esbuild 打包）读同一份数据造 props 与 RPC 桩。
 * 因此这里必须是纯数据 + 纯函数，不碰 window/document，也不 import 任何东西。
 *
 * 状态约定：每个 state = { id, snapshot?, rpc?, interaction?, waitFor }
 *   - snapshot：设置面 useConfig 拿到的配置快照（形状与 client.js 的 TeachSettingsSection 对齐）
 *   - rpc：callRpc 端点 → 回执。值可以是回执对象（自动 Promise.resolve）、
 *           "pending"（永不 resolve，用来截住 loading 态）或 (payload) => 回执。
 *   - interaction："refresh" 表示截图前先点一下课堂面的「刷新状态」，把 classroom/status 的
 *           汇总行也渲染出来（这一行只有刷新后才有）。
 *   - waitFor：截图前的稳定条件。{ selector, count, text, frame }，由 runner 解释，
 *     保证「等的是这个状态一定有的东西」，不是盲等。
 */

/** 设置面与侧栏面共用的会话 id（课堂/选课 props 里都有）。 */
export const SESSION_ID = "session-1";

/** 侧栏课堂页签的课程名，和课程列表第一条同名。 */
const LESSON_TITLE = "傅里叶变换：从振动到频谱";

/** 100 个字符的课程名：侧栏 300px 里必须省略号截断，且不能把「打开」挤掉。 */
const LONG_TITLE = "为什么一段看似复杂的周期信号拆成若干条正弦波之后就变得可以计算：从傅里叶级数到离散傅里叶变换的完整推导，以及频谱泄漏、窗函数与采样定理在工程实现中的取舍与验证方法——附完整推导、数值实验与课后练习答案";

/** 课堂页签自己的 useTabInfo 回执：按 lessonId 打开，同时给出文件地址。 */
export const TAB_INFO = {
	tab: {
		title: LESSON_TITLE,
		navigation: {
			address: "dsh-resource://file/session/session-1/lessons/fourier.html",
			params: { lessonId: "lesson-fourier" }
		}
	}
};

/** 课程页面里的 4 道题（父页只数条数、透传 nonce；题目内容由 iframe 自己渲染）。 */
const QUESTIONS = [
	{ id: "q1", revision: 1, kind: "single-choice", prompt: "采样率 16 Hz 时，4 Hz 正弦的离散频谱第一次出现在哪个频率？", choices: ["2 Hz", "4 Hz", "8 Hz", "12 Hz"] },
	{ id: "q2", revision: 2, kind: "short-answer", prompt: "为什么矩形窗会把单频信号的能量摊到相邻频点？", choices: [] },
	{ id: "q3", revision: 1, kind: "single-choice", prompt: "窗越长，主瓣宽度会怎样变化？", choices: ["变窄", "不变", "变宽", "先窄后宽"] },
	{ id: "q4", revision: 1, kind: "multi-choice", prompt: "下面哪些做法能减小频谱泄漏？", choices: ["加汉宁窗", "加长观测时间", "直接截断", "零填充"] }
];

/** classroom/open 的回执：父页拿 url 挂 iframe，拿 nonce 校验 postMessage。 */
const CLASSROOM_OPEN = {
	url: "./lesson-stub.html",
	title: LESSON_TITLE,
	lessonId: "lesson-fourier",
	revision: 3,
	sessionId: SESSION_ID,
	expiresAt: "2026-11-02T12:00:00.000Z",
	nonce: "nonce-bench-1",
  reading: { maxRatio: .8, position: { ratio: .4 } },
	questions: QUESTIONS
};

/** classroom/status 的回执：刷新时只用 counts、pendingCount 与最近有效结论。 */
const CLASSROOM_STATUS = {
	lesson: { id: "lesson-fourier", title: LESSON_TITLE, revision: 3, questionCount: QUESTIONS.length },
	questions: QUESTIONS,
	submissions: [
		{ questionId: "q1", questionRevision: 1, rawAnswer: "3 Hz", effectiveVerdict: "failed", verdictAt: "2026-11-01T09:12:00.000Z", submittedAt: "2026-11-01T09:11:00.000Z" },
		{ questionId: "q2", questionRevision: 2, rawAnswer: "矩形窗的频谱是 sinc，和信号卷积后主瓣会拖到相邻频点。", effectiveVerdict: "passed", verdictAt: "2026-11-01T09:20:00.000Z", submittedAt: "2026-11-01T09:19:00.000Z" }
	],
	pending: [{ questionId: "q3", submittedAt: "2026-11-01T09:25:00.000Z" }],
	pendingCount: 1
};

/** 已发布的课程清单：一屏里同时给出健康、失效、长标题、0 题、改版这几种行。 */
const CATALOG_LESSONS = [
	{
		id: "lesson-fourier",
		title: LESSON_TITLE,
		revision: 3,
		questionCount: 4,
		publishedAt: "2026-10-28",
		lastVerdict: "passed",
		lastSubmittedAt: "2026-11-01T09:20:00.000Z",
		lastVerdictAt: "2026-11-01T09:20:00.000Z"
	},
	{
		id: "lesson-convolution",
		title: "卷积与滤波：谁在给信号做减法",
		revision: 2,
		questionCount: 3,
		publishedAt: "2026-10-30",
		lastVerdict: "failed",
		lastSubmittedAt: "2026-10-31T14:05:00.000Z",
		lastVerdictAt: "2026-10-31T14:05:00.000Z",
		lastVerdictStale: true,
		lastVerdictStaleReason: "题目已改版",
		// 两个方向给不同的值：missingPageIds 是「页面写了、档案没登记」，unmappedQuestionIds 是
		// 「档案登记了、页面没排进去」。两者的界面文案必须分开，混用就是把方向说反。
		missingPageIds: ["q7", "q8"],
		unmappedQuestionIds: ["q6"]
	},
	{
		// 已提交、还没评估：catalog 支持这种状态，界面不能把它说成「尚未作答」。
		id: "lesson-submitted",
		title: "离散频谱：泄漏从哪里来",
		revision: 2,
		questionCount: 3,
		publishedAt: "2026-10-27",
		lastSubmittedAt: "2026-11-02T08:40:00.000Z"
	},
	{
		id: "lesson-long-title",
		title: LONG_TITLE,
		revision: 1,
		questionCount: 2,
		publishedAt: "2026-10-25",
		openable: true
	},
	{
		id: "lesson-zero-questions",
		title: "采样定理：两倍够不够",
		revision: 1,
		questionCount: 0,
		publishedAt: "2026-10-24",
		openable: true
	},
	{
		id: "lesson-window-functions",
		title: "窗函数选型：主瓣、旁瓣与代价",
		revision: 3,
		questionCount: 5,
		publishedAt: "2026-10-28",
		openable: true
	}
];

/** 设置面四档快照。root 为空时不写 softLimitSeconds，这就是「没配」的样子。 */
const ANIMATION_READY = {
	root: "/srv/remotion-projects/lesson-animations-2026",
	softLimitSeconds: 120,
	missing: "warn",
	staging: true
};

export const SETTINGS_SNAPSHOTS = {
	ready: { status: "ready", writable: true, value: { animation: { ...ANIMATION_READY } } },
	empty: { status: "ready", writable: true, value: {} },
	readonly: { status: "ready", writable: false, value: { animation: { ...ANIMATION_READY } } },
	loading: { status: "loading" },
	"invalid-limit": { status: "ready", writable: true, value: { animation: { ...ANIMATION_READY, softLimitSeconds: 601 } } }
};

/** 课程清单一句话回执的四个非就绪档。 */
const COLLECTIONS = [{ id: "default", name: "信号与系统 · 第一轮", archived: false }, { id: "second", name: "推导复习", archived: false }, { id: "archived", name: "旧学习计划", archived: true }];
const COLLECTION_BASE = { collectionId: "default", collections: COLLECTIONS };
const CATALOG_READY = { ok: true, value: { ...COLLECTION_BASE, initialized: true, lessons: CATALOG_LESSONS.map((lesson, index) => ({ ...lesson, reading: index < 3 ? { maxRatio: [1, .8, .4][index] } : null })), openable: true, reading: { percent: 37, count: 6, unrecorded: 3 } } };
/** 足够长、能滚动的课程清单：验证吸顶顶栏和内容经过模糊层。 */
const CATALOG_SCROLL = { ok: true, value: { ...CATALOG_READY.value, lessons: Array.from({ length: 24 }, (_, index) => ({ ...CATALOG_LESSONS[index % CATALOG_LESSONS.length], id: "scroll-lesson-" + index, title: "滚动测试课程 " + (index + 1), questionCount: 3 })), reading: { percent: 50, count: 24, unrecorded: 12 } } };
const CATALOG_NO_ARCHIVE = { ok: true, value: { ...COLLECTION_BASE, initialized: false, lessons: [] } };
const CATALOG_EMPTY = { ok: true, value: { ...COLLECTION_BASE, initialized: true, lessons: [] } };
const CATALOG_FAILED = { ok: false, error: { code: "workspace-mismatch" } };

const PREFS = { ok: true, value: { ...COLLECTION_BASE, factCheck: "moderate", depth: "moderate" } };
export const SURFACES = {
  dock: { id: "dock", states: [
    { id: "collapsed", rpc: { "preferences/get": PREFS }, waitFor: { text: "教学设置" } },
    { id: "expanded", beforeInteraction: { text: "教学设置" }, interaction: { textKey: "teachingSettings", rpcCalls: 0 }, rpc: { "preferences/get": PREFS }, waitFor: { text: "事实核查等级" } },
    { id: "error", beforeInteraction: { text: "教学设置" }, interaction: { textKey: "teachingSettings", rpcCalls: 0 }, rpc: { "preferences/get": { ok: false, error: { message: "会话设置尚未保存，请重试" } } }, waitFor: { text: "会话设置尚未保存，请重试" } }
  ] },
	settings: {
		id: "settings",
		title: "教学模式设置页",
		/**
		 * 等待条件只用「结构」或「fixture 数据里的字符串」，不抄文案原文：
		 * 这份 bench 要在设计改版前后跑同一套 fixture，改版会改措辞、甚至改措辞渲染的位置，
		 * 但不会改 fixture 里的数据。文案 key 版本（textKey）也支持，留给需要时用。
		 * 通用兜底由 runner 负责：挂载 + RPC 落地 + DOM 静默，这一段保证异步渲染真的画完了。
		 */
		states: [
			{ id: "ready", snapshot: SETTINGS_SNAPSHOTS.ready, waitFor: { selector: "#qa-root input" } },
			{ id: "empty", snapshot: SETTINGS_SNAPSHOTS.empty, waitFor: {} },
			{ id: "readonly", snapshot: SETTINGS_SNAPSHOTS.readonly, waitFor: {} },
			{ id: "loading", snapshot: SETTINGS_SNAPSHOTS.loading, waitFor: {} },
			{ id: "invalid-limit", snapshot: SETTINGS_SNAPSHOTS["invalid-limit"], waitFor: {} }
		]
	},
	welcome: {
		id: "welcome",
		title: "首次安装欢迎页",
		/**
		 * 只渲染弹层正文（`TeachWelcomeBody`）：外壳是宿主的 `Modal`（portal 到 body、
		 * 焦点陷阱、Esc），bench 不复制宿主组件，所以探针仍然只看 `#qa-root`。
		 * 宽度由 `--widths` 覆盖；「已看过不显示」「只读不显示」由单测钉住，这里只画内容。
		 */
		states: [
			{ id: "default", waitFor: { selector: ".tsm-welcome" } }
		]
	},
	courses: {
		id: "courses",
		title: "选课侧栏",
		states: [
			// 第五课标题来自 fixture 数据：它出现 = 5 行都渲染完了。
			{ id: "ready", rpc: { "classroom/catalog": CATALOG_READY }, waitFor: { text: "窗函数选型：主瓣、旁瓣与代价" } },
			// 滚动后截图：验证顶栏吸顶、课程行从模糊层下经过。
			{ id: "scrolled", rpc: { "classroom/catalog": CATALOG_SCROLL }, interaction: { scroll: "courses" }, waitFor: { text: "滚动测试课程 24" } },
			{ id: "no-archive", rpc: { "classroom/catalog": CATALOG_NO_ARCHIVE }, waitFor: {} },
			{ id: "empty", rpc: { "classroom/catalog": CATALOG_EMPTY }, waitFor: {} },
			{ id: "loading", rpc: { "classroom/catalog": "pending" }, waitFor: {} },
			{ id: "error", rpc: { "classroom/catalog": CATALOG_FAILED }, waitFor: {} }
		]
	},
	classroom: {
		id: "classroom",
		title: "课堂侧栏",
		states: [
			// 新版打开后会自己读一次 status 填常驻账目行；旧版只在「刷新」时读。两边都给，互不干扰。
			{ id: "ready", rpc: { "classroom/open": { ok: true, value: CLASSROOM_OPEN }, "classroom/status": { ok: true, value: CLASSROOM_STATUS } }, waitFor: { selector: "#qa-root iframe", frame: "lesson-stub.html" } },
			// 侧栏被拉宽时也检查顶栏排版（pane 覆盖只在 bench 生效）。
			{ id: "wide", pane: 1100, rpc: { "classroom/open": { ok: true, value: CLASSROOM_OPEN }, "classroom/status": { ok: true, value: CLASSROOM_STATUS } }, waitFor: { selector: "#qa-root iframe", frame: "lesson-stub.html" } },
			// 课程页滚动后截图：验证首屏不遮、内容经过顶栏模糊层、inset 跟顶栏等高。
			{ id: "scrolled", interaction: { scroll: "classroom" }, rpc: { "classroom/open": { ok: true, value: CLASSROOM_OPEN }, "classroom/status": { ok: true, value: CLASSROOM_STATUS } }, waitFor: { selector: "#qa-root iframe", frame: "lesson-stub.html" } },
			{ id: "refreshed", interaction: { textKey: "classroomRefresh" }, rpc: { "classroom/open": { ok: true, value: CLASSROOM_OPEN }, "classroom/status": { ok: true, value: CLASSROOM_STATUS } }, waitFor: { selector: "#qa-root iframe", frame: "lesson-stub.html" } },
			{ id: "loading", rpc: { "classroom/open": "pending" }, waitFor: {} },
			{ id: "failed", rpc: { "classroom/open": { ok: false, error: { code: "lesson-not-found" } } }, waitFor: {} },
			{ id: "no-url", rpc: { "classroom/open": { ok: true, value: { ...CLASSROOM_OPEN, url: "" } } }, waitFor: {} }
		]
	}
};

/** runner 打印用的矩阵默认值（--widths / --theme 覆盖）。 */
export const DEFAULT_WIDTHS = [1440, 768, 390];

/**
 * 侧栏面板宽度：宽屏 430（宿主的右栏常见宽度），中屏 340，窄屏 300。
 * 面板永远不超过视口，避免 390 下横滚。
 */
export function paneWidthFor(viewportWidth) {
	const preferred = viewportWidth >= 1024 ? 430 : viewportWidth >= 600 ? 340 : 300;
	return Math.max(0, Math.min(preferred, viewportWidth - 16));
}
