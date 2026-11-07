# 写动画源码

- 已加载本项目的 teach-animation 接入指南，按需核对了工程版本对应的 Remotion 官方 API。
- 读过一次 templates/ANIMATION.md；版式、配色、字号、元件、曲线都照表取值，没有另起设计。
- **先看工程既有约定**：`src/theme.ts` 导出了什么、`src/videos/shared/` 有什么现成组件、已有视频怎么 import。工程已有等价物就复用，不为满足规范的 `src/shared/` 路径另造第二套 token。
- 共享件（theme / motion / SceneFrame）按工程现状落位；规范给的路径是默认值，不是必须新建的目录。
- 源码写在工作区 `{{teach_staging_dir}}/animation-src/<slug>/`（`data.ts` / `Scene*.tsx` / `index.tsx` / `storyboard.md`），**不直接写工程目录**；偏离规范的地方在末尾写了理由。
- 时间线用 `timeline()` 写成数据；每幕套 SceneFrame，放进带 `name` 的 Sequence。
- 一拍一个焦点；对象连续变形不换皮；标注贴身。
- 换幕用 fade 交叉淡化；同舞台内推镜头而不切；slide 只在方向有含义时用。
- 跑过一次 `teach_animation_inspect` 确认工程就绪；未接入时把接入 diff 给他看，明确同意后才 `teach_animation_register`（`confirm: true`），不手改 `Root.tsx`。
- 跑过一次 `teach_animation_sync`（`category` + `slug`）：返回里列出了镜像到 `{{teach_animation_root}}/src/videos/<category>/<slug>/` 的文件，并给出自动注册的 Composition id（1920×1080、30fps 按入口约定）。
- 入口约定满足：`index.tsx` 导出 `Lesson` 与 `DURATION_IN_FRAMES`（可选 `FPS` / `WIDTH` / `HEIGHT`）；没满足时 sync 会说明缺什么，补齐再同步，不绕过。
- 用 `useCurrentFrame` + `interpolate` + `Easing`，没有 CSS transition / animation；interpolate 都夹紧。
- 数值与文中结论来自同一批摘录。
- 渲染由 `teach_animation_render` 代做，不需要为工程目录申请审批。
