# 教学组件源码与构建

运行 `pnpm build:components` 生成 `templates/components/`，`pnpm check:components` 核对原件哈希与构建产物。发布包自带产物，学习者打开课程无需 Node、构建或网络。

- `upstream/` 保存固定版本的未修改原件及许可，`SOURCES.json` 记录提交、路径和 SHA-256。升级应显式重新核对，构建不会联网拉取。
- `components.tsx` 适配 DeepTutor 闪卡/时间线，保留翻面与导航、事件顺序和字段结构。移除应用 i18n、图标和 Tailwind，继承 `course.css`；提示改为学习者主动揭晓，保留提示/答案展示历史。
- `charts.ts` 直接编译导入 OpenMAIC `chartOption.ts` 原件，使用独立 ECharts SVG 包。外层提供本地数据约束、参数修改、重置、数据表、主题继承和当前状态。
- `data.mjs` 是组件输入契约。数据只能是 JSON 文字和有限数值，不接受表达式、远程图片样式或任意 HTML。
- 构建方法复用 OpenMAIC 独立播放器的“预构建 IIFE / 图表单独打包”路线，未移植平台播放器、数据库、编辑器或整套渲染组件。

普通课保持既有引用。只有使用组件的课才加入基础包，只有图表课才加入图表包；不要把两个包无条件塞进所有课程骨架。

课程侧 `column` 表示竖柱、`bar` 表示横条；上游转换器的两个名称相反，适配层已做映射，原件保持不动。图表读数显式继承正文色，柱形读数移到柱外，避免深色主题使用 ECharts 默认深灰数字。

使用说明见随包的 `templates/COMPONENTS.md`。`templates/examples/lessons/components.html` 与 `reuse.html` 可直接打开，二者使用同一份共享产物，仅正文与 JSON 数据不同。

组件挂载完成后发出 `teach:components-ready`，课堂桥和 `course.js` 可幂等重扫。当前情境只通过可见的 `[data-teach-state]` 元素提供，未翻面的答案不会写入该节点；时间线直接复用已显示的列表，不重复渲染一份摘要。
