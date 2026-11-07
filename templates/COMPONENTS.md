# 可复用教学组件

正文、公式、表格与自测继续用 [FORMATS](FORMATS.md)。**哪一课该不该用这些组件，先看 [FORMATS](FORMATS.md) 的「组件菜单」一节**；这里只给运行资源、JSON 契约与实现边界。需要以下表达时，复制本课使用的运行资源并填 JSON；不把组件源码重新写进每课，不要求学习者安装或构建。

| 表达 | 使用资源 | 内容契约 |
| --- | --- | --- |
| 闪卡：先回忆，再翻面 | `components/teach-components.js`、`.css` | `cards: [{front, back, hint?}]` |
| 事件时间线 | 同上 | `events: [{date, title, description?}]` |
| 数据图表与参数对比 | `components/teach-charts.js`、`teach-components.css` | `type`、`data`，可选 `controls`，见下方 |
| 自测、提示与显式提交 | 已有 `course.js` | `.quiz[data-question-id]`；继续使用登记题目和现有课堂桥 |

两份脚本分别是可独立加载的本地包。有图表才引入图表包；普通正文课不增加这些资源。复制目标为工作区 `assets/components/`；CSS 继承现有 `course.css`，不覆盖正文风格。

## 闪卡或时间线

课程已有 `course.css` 与 `course.js`。额外直接引用：

```html
<link rel="stylesheet" href="../assets/components/teach-components.css">
<script src="../assets/components/teach-components.js" defer></script>
```

只替换标题与数据：

```html
<div data-teach-component="flashcards" data-teach-context="本课条件辨析">
  <script type="application/json">
  {"title":"回忆条件","cards":[{"front":"该机制成立需要什么？","back":"填入本课已核验的条件","hint":"想想前提"}]}
  </script>
</div>
```

时间线使用同一脚本，把组件名和数据改为：

```html
<div data-teach-component="timeline" data-teach-context="事件先后关系">
  <script type="application/json">
  {"title":"关键变化","events":[{"date":"阶段一","title":"起点","description":"已核验的背景"},{"date":"阶段二","title":"变化","description":"说明因果，不只列年份"}]}
  </script>
</div>
```

时间线展示事件顺序，不代替算法单步模拟。闪卡用于回忆，不因为翻过答案就写评估通过。数据只放文本；JSON 字符串中的 `<` 写成 `\u003c`，避免题文中的结束标签提前关闭数据脚本。

## 图表：数据与可选控件

直接引用同一组件 CSS 与 `../assets/components/teach-charts.js`，不需要为了图表加载闪卡包。

```html
<div data-teach-component="chart" data-teach-context="两组参数比较">
  <script type="application/json">
  {"title":"示例数据：观察参数变化","type":"column","data":{"labels":["情境 A","情境 B"],"legends":["读数"],"series":[[4,8]]},"controls":[{"label":"情境 B 读数","min":0,"max":16,"step":1,"value":8,"seriesIndex":0,"dataIndex":1}]}
  </script>
</div>
```

`type` 可用 `column / bar / line / area / pie / ring / radar / scatter`；`data.labels` 为类别，`legends` 对应每组 `series`。控件通过 `seriesIndex/dataIndex` 更新指定读数，不提供任意代码执行入口；初始值需与步长对齐，同一读数只能配置一个控件。使用真实课程数据和单位；没有需要操控的变量就省略 `controls`。可运行例课见 `examples/lessons/components.html` 与 `reuse.html`。

饼图/环图只接受一组非负数据，初始值至少有一项大于零；控件不能产生负数，调到全零时明确显示暂无占比，而不画出虚假的比例。散点图必须有两组等长数据：`series[0]` 为 x，`series[1]` 为 y，`labels` 为点的名称，`legends` 写清两个坐标的含义与单位。

参数控件修改的是数据，不会自动生成本课的物理/算法模型。需要联动计算时复用工作区已有计算逻辑，确需定制才读 [实验配方](recipes/simulation.md)。

## 提示、揭晓与手动答疑

自定义原生按钮或 `details` 可标 `data-teach-hint` / `data-teach-solution`，课程脚本在真实展示后记录提示/解答使用；不修改正式提交的语义。提示与解答放在其所属 `.quiz` 或 `data-teach-context` 容器内。

组件的当前可见状态放在带 `data-teach-state` 的文本元素中，由现有课程脚本提供手动复制入口。定制控件也可使用：

```html
<div data-teach-context="本题参数实验">
  <!-- 控件与可见结果由本课已有逻辑更新 -->
  <p data-teach-state>当前参数：4 项；已执行：第 2 步；显示结果：命中 1 次。</p>
</div>
```

只写当前输入、步骤和已呈现结果，不放标准答案、未揭晓内容或完整操作历史。复制只为提问提供上下文，不自动向模型请求、不自动归档或形成通过结论。组件初始化完成会发 `teach:components-ready`，供现有课堂桥幂等补挂点；无需另写提交通道。

## 按需生成与维护

组件够用就只填数据。需要新的结构图或小实验时从 [配方索引](recipes/INDEX.md) 选一份适配版，不全读上游原件。动画继续读取 [ANIMATION](ANIMATION.md) 与 [Remotion 复用配方](recipes/remotion-reuse.md)。

组件构建、固定来源和许可随包保存；维护时核对来源记录再更新，课程生成时不自动拉取上游或运行包管理器。

维护者修改组件后运行 `pnpm build:components`，提交前运行 `pnpm check:components`；学习者查看课程不需要这些命令。固定提交、原件哈希与适配说明见 [组件来源清单](components/UPSTREAM.json)，完整运行依赖声明见 [许可文件](components/THIRD_PARTY_NOTICES.txt)，构建方式见 [测试与构建说明](../docs/testing.md)。
