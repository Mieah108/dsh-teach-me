# Host UI bench fixtures

`scripts/qa-host-ui.mjs` 的 fixture 与 harness 页面。**这份 bench 只渲染、不修改任何产品代码**，
改完 `client.js` 直接重跑就能拿 AFTER 截图，同一个壳、同一套状态。

## 文件

| 文件 | 作用 |
| --- | --- |
| `fixtures.js` | 状态清单、RPC 回执、文案 key、侧栏面板宽度。Node 侧（runner）和浏览器侧（entry）共用，纯数据、不 import 任何东西。 |
| `entry.js` | 浏览器入口，esbuild 每次运行重新打包。摆主题/令牌回退/页面壳 → stub `window.__ModuleLoader__` → 加载 `client.js` → 宿主 React 挂载。 |
| `harness.css` | 页面壳：宿主地面、720px 设置列、430/340/300 侧栏面板、整屏高。只有承载容器，没有产品样式。 |
| `lesson-stub.html` | 课堂 iframe 的占位课程页（一个标题 + 三段正文），供 `sandbox` iframe 加载。 |

## 跑法

```bash
# BEFORE：改版前的 client.js 快照（只换 client 路径，fixture 完全一样）
node scripts/qa-host-ui.mjs --client .impeccable/live/bench-snapshot/client.before.js --out artifacts/host-ui/before

# AFTER：仓库根目录当前的 client.js
node scripts/qa-host-ui.mjs --out artifacts/host-ui/after

# 收窄范围 / 换宽度
node scripts/qa-host-ui.mjs --only classroom --theme dark --widths 390
```

`--out` 默认 `artifacts/host-ui/current`；`--client` 默认仓库根目录的 `client.js`。
每轮都会把实际渲染的 client.js 的 sha256 写进 `<out>/manifest.json`，两轮对比前先核对它。

矩阵：`主题(light/dark) × 视口(1440/768/390) × 面 × 状态`，`fullPage`、`deviceScaleFactor=2`。
侧栏面板宽随视口：1440→430、768→340、390→300，面板贴右、整屏高、底色 `--dsw-specific-sidebar-fill`；
设置面是 720px 内容列，地面 `--dsw-alias-bg-base`。明暗只切 `body[data-ds-dark-theme]`。

## 状态

| 面 | 状态 | fixture 要点 |
| --- | --- | --- |
| settings | `ready` | root 有值、softLimit 120、missing `warn`、staging true |
| settings | `empty` | root ""、没有 softLimitSeconds |
| settings | `readonly` | `writable:false` |
| settings | `loading` | `status:"loading"` |
| settings | `invalid-limit` | 已保存的 `softLimitSeconds:601`（越界） |
| courses | `ready` | `openable:true`（catalog 顶层字段，不是单课可用性，界面不读它）；6 课：passed+lastSubmittedAt；failed+`lastVerdictStale`+原因+`unmappedQuestionIds`；100 字长标题无结论；`questionCount:0`；`publishedAt:2026-10-28`+`revision:3` |
| courses | `no-archive` | `initialized:false`、`lessons:[]` |
| courses | `empty` | `initialized:true`、`lessons:[]` |
| courses | `loading` | `classroom/catalog` 永不返回 |
| courses | `error` | `{ok:false, error:{code:"workspace-mismatch"}}` |
| classroom | `ready` | `classroom/open` 给出 url/title/lessonId/revision/sessionId/expiresAt/nonce + 4 道题 |
| classroom | `refreshed` | 截图前点一次「刷新状态」；`classroom/status` 给出 lesson/4 题/2 条 submission(1 pending)/`pendingCount:1`，渲染出汇总行 |
| classroom | `loading` | `classroom/open` 永不返回 |
| classroom | `failed` | `{ok:false, error:{code:"lesson-not-found"}}` |
| classroom | `no-url` | `ok:true` 但 `url:""` |

## 等待策略（为什么不是盲等）

1. **挂载**：`#qa-root > *`（不认具体类名）。
2. **状态标记**：结构选择器 / `#qa-root iframe` / fixture 数据里的字符串（如第五课标题）/ 必要时用文案 key（`window.__qa.t(key)` 解析，改版改措辞不影响）。
3. **异步落地**：`window.__qa.rpc` 记账，等接口被调用过、且在飞的请求都回来（`pending` 档除外）。
4. **DOM 静默**：`#qa-root` 文本连续两次取样一致，再等 300ms + 字体就绪。

任何 `pageerror` / `console.error` 都会让整轮非 0 退出。

## 已知取舍

- `courses/unopenable`：当前 UI 不消费 `openable`，截图与 `ready` 一致；fixture 留着，方便 AFTER 轮次验证新设计是否开始使用它。
- 设置面的「已保存」两秒即消失，不在截图状态里（需要时在 runner 里加一次 write 交互）。
- 令牌断言写死的是宿主 design-platform 当前值（亮 `#fff`/`#0f1115`、暗 `#151517`/`#f9fafb`、边框黑/白 alpha）。宿主主题包升级导致失配时脚本会失败并打印实测值，属预期行为。
- 设置面 `useConfig` 用内存快照；`write` 会真的改快照并重渲染，但截图状态不触发保存。

当前测试台通过 `scripts/host-ui-primitives.mjs` 加载本机宿主正在使用的入口、公开静态模块种子与对应 CSS，运行真实 Menu / Button / 图标，而非替代菜单。仅 QA 截断应用启动；生产客户端仍只依赖公开模块名。可用 `TEACH_HOST_ROOT` 指定宿主包根目录；宿主引导结构改变时明确失败。dock fixture 模拟新会话预设行，弹层通过 portal 渲染，不改变课程区位置。
