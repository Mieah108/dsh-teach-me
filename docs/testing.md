# 测试与验收

本地自动校验验证代码契约、合成档案与可分发资产；真实宿主安装、浏览器行为和渲染隔离需要另外验收。一次通过不能替代另一层验证。

## 源码校验

在源码发行包根目录按锁文件安装开发依赖：

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm selftest
pnpm check:skills
pnpm check:components
node scripts/verify.mjs --source
node scripts/check-release.mjs
```

`--source` 不依赖 Git，也不读取可选的本机宿主预设；在有 Git 的开发 checkout 可另运行 `pnpm verify`。

单元测试使用隔离临时目录和合成课程；selftest 使用假宿主上下文核对注册、提示词、判分、阶段、档案与 lint，不读取维护者的个人课程。技能清单校验必须能发现缺失、额外和被修改的文件，且不依赖使用者 HOME 中预装的技能。

组件构建检查核对原件来源哈希、JS/CSS 产物与 notices。MathJax 的版本、官方包来源和文件哈希记录在 `templates/mathjax/UPSTREAM.json`。离线公式验收应覆盖行内与独立公式、排版错误、页面异常和外部请求；这项检查不替代 DSH 课堂或 Remotion 整链验收。

`node scripts/check-preset-drift.mjs` 在装有受支持宿主时检查预设漂移；未安装宿主时跳过并明确报告。它与使用合成宿主的测试不是同一项证据。

## 包与源码快照

运行包只含预设加载、课程生成/维护及客户端所需的内容；源码快照另外包含构建源码、测试和维护脚本。两者都应检查文件清单、许可、哈希、个人路径、原始会话和包内链接。

从生成的 npm tgz 提取后，应核对插件入口可导入、模板/技能/许可完整，并对随包 CLI 执行帮助/校验 smoke。不能要求运行包提供源码专用测试和构建工具。

源码归档不包含 `.git`，应在新目录安装依赖后执行完整源码校验。发布预检与真正的 Git tag 校验分开，不能把“无 Git 快照通过”写成“正式 tag 已验证”。命令和交付顺序见 [版本发布](versioning.md)。

源码校验使用 Node 26.4.0；其他 Node 版本的兼容性需单独验证。

## 真实 DSH 验收

在一次性测试工作区与明确授权的工程中检查：

1. 冷启动发现 host 行与客户端；设置页可见、修改后重启读取，默认动画关闭。首次打开会出现一次欢迎页：内容完整、只弹一次，关掉后刷新与换浏览器都不再出现，设置页的「重新显示欢迎页」能把它叫回来。
2. 新会话选教学模式；确认模型可直接调用 `teach_stage` 等原生工具。诊断题处于候答时，读查和 commit 演练可用，正式 commit 被拦截。回答后完成 lint → commit → `teach_lesson_open`，题目挂点与登记一致。回执带计划时直接调用 `sidebar_open`，缺少工具时从选课页打开。
3. 侧栏选课、单题/多选/文本提交、刷新状态、过期票与课程改版，正式作答和待批改状态符合预期。
4. 离线阅读与答案导出/导入，重复导入不重复记分；媒体显示、大小边界与离线资源完整。
5. 若测试动画：只读 inspect、确认首次 register、sync 演练零写、正式 sync、静帧/视频、取消/超时和重启恢复。
6. 验证渲染的文件、网络、缓存、字体、后代进程及清理边界；无法确认强隔离时，不宣称达到完整权限保证。

使用合成数据、无个人主题的测试 profile；发布材料不包含真实登录票、个人会话侧栏、学习档案或未经许可的图片。

## 仍需独立证明的事项

- 真实 DSH 冷启动、完整课堂判分和开放题模型批改；
- 图片/视频在实际课堂、离线导出与浏览器中的显示；
- spec 增量 patch 与快照的真实工作负载和大规模性能；
- 渲染强隔离、Chromium/字体/缓存链路及各平台支持；
- 实际模型 token、缓存命中、费用与跨子代理成本；
- 课程质量和教学效果的独立评价。

以上不得根据 unit tests、假 DOM、字节统计或旧版本记录推定已完成。发布验证应注明实际命令、环境、结果和未执行项；原始记录保存在公开分发目录之外。

## 0.8.5 教学扩展

- `node scripts/probes/learning-host.mjs`：对实际安装的宿主 DomainFacility/JSON 后端做临时数据的保存、重开、会话隔离与非法值验证，并核对公开插槽和控件导出。
- `node scripts/qa-learning-flow.mjs`：真实 HTTP 路由、沙箱 iframe 与浏览器交互，覆盖原生弹出菜单/嵌套选项、滑块键盘、Escape 焦点返回/外点关闭、会话设置隔离、集合复制/选择、阅读保存/回看、原课堂提交及续读；只使用临时合成数据，不调用模型。
- `node scripts/qa-host-ui.mjs --only dock,courses,classroom,settings --widths 1440,390 --theme both`：四个承载面的代表性明暗、宽窄与失败状态。其中 `courses/scrolled` 与 `classroom/scrolled` 会滚动内容并断言：选课顶栏吸顶、课堂课程页顶部空白与顶栏等高、iframe 铺满面板；`classroom/wide` 用 `?pane=1100` 模拟拉宽侧栏，检查标题行动作图标与账目/阅读行的宽屏排版。
- `node scripts/qa-learning-flow.mjs` 额外断言：弹层改偏好后不存在可见的「已保存」；阅读重试图标在待保存时 `data-pending="true"`，点后恢复 `false`。
- `test/unit/learning-*.test.js`、`teaching-*.test.js`：集合版本隔离、迁移备份、旧证据、进度归并、会话默认快照、请求固定值、弹性核查预算与保守复查。

实测范围、兼容性和未执行的模型调用见 [实施验证记录](reports/2026-11-05-learning-extension-validation.md)。

## 首次安装欢迎页

- `node scripts/qa-host-ui.mjs --only welcome --widths 1440,390 --theme both`：正文在明暗与窄屏下的排版（眉行、导语、一次性说明、三步、两处设置与动画说明）。外壳是宿主 `Modal`，bench 不渲染它。
- `test/unit/client-welcome.test.js`、`test/unit/config-welcome.test.js`：判定真值表、写回与浏览器兜底、`welcome.seen` 的 volatile 契约。
- 真实宿主另验三件 bench 覆盖不到的事：弹层宽度覆盖（`min(520px, calc(100vw - 24px))`）、Esc 关闭与主按钮自动聚焦；以及「关掉后刷新、换浏览器、重启宿主都不再出现」。
