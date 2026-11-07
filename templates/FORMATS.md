# 课程页框架（复制即用）

| 文件 | 放到哪 | 作用 |
|---|---|---|
| `course.css` | `assets/course.css` | 全部样式。改 `:root` 变量定风格，结构不动 |
| `course.js` | `assets/course.js` | 判卷 + 侧栏滚动高亮 + 复制为 Markdown（本地，不联网） |
| `mathjax/tex-svg.js` | `assets/mathjax/tex-svg.js` | 公式渲染（单文件、离线、自带字形） |
| `lesson.html` | 每课 `lessons/NNNN-slug.html` | 空骨架：只有结构和 `〔…〕` 占位符，没有示例内容 |

首次建站：`cp -R course.css course.js mathjax <工作区>/assets/`

先看下面的「组件菜单」决定这一课要不要加闪卡、时间线、图表或参数控件；真要用时再读 [COMPONENTS.md](COMPONENTS.md) 取运行资源与 JSON 写法。必要定制才选 [生成配方](recipes/INDEX.md)；配方和上游原件留在包内，不复制到学习工作区。

## 组件菜单（先看表，再决定用不用）

正文、公式、表格、提示、分步、对比、视频、验收、自测是每课的基本件（写法见下面「组件标记」）；下表是更重的组件，多出一层「什么时候值得用」。

| 表达 | 什么时候值得用 | 标记 / 资源 | 细节 |
|---|---|---|---|
| 闪卡：先回忆再翻面 | 讲完一个机制后，要他自己回忆条件、步骤或口径；纯读一遍会滑过去 | `data-teach-component="flashcards"` + JSON | [COMPONENTS.md](COMPONENTS.md) §闪卡或时间线 |
| 时间线 | 一串真实的先后与因果（事件、阶段、版本演进），不是算法单步 | `data-teach-component="timeline"` + JSON | 同上 |
| 图表 | 有量要比较、有趋势要看，且数据来自本课材料 | `data-teach-component="chart"` + JSON | [COMPONENTS.md](COMPONENTS.md) §图表 |
| 图表参数控件 | 有一个真能调的变量，调完结论会变或能看见边界；想让他自己动手而不是看结论 | `type` + `data` + `controls[]` | 同上；有联动计算再读 [局部实验配方](recipes/simulation.md) |
| 提示 / 解答揭晓、答疑快照 | 题目要分级提示，或要连同当前上下文去问 | `data-teach-hint` / `data-teach-solution` / `data-teach-state` | [COMPONENTS.md](COMPONENTS.md) §提示、揭晓与手动答疑 |

三条判据，不满足就不加：① 它改变他**做什么**（回忆、调参、动手），不是只改变**看起来怎样**；② 数据来自本课已核验的材料，不是编的演示数据；③ 组件能表达时只填数据，不改实现。组件是菜单，不是清单——一课一个都不加也正常。字段、资源复制与实现边界都在 [COMPONENTS.md](COMPONENTS.md)，那里不重复「什么时候用」。

## 用骨架

骨架是起点，不是模具。小节数、标题、验收形式都由这一课的内容决定。

1. 复制 `lesson.html` 到 `lessons/NNNN-slug.html`。
2. 把所有 `〔…〕` 替换成本课内容——交付前不该再出现 `〔`。
3. 小节按内容增删：3 节讲得完就 3 节，例子多就 5–7 节，讲不完就拆成两课。增删时同步改 `aside.sidenav` 与 `nav.toc`，两侧条目都要和 `section[id]` 对上。
4. 每节的标题按内容起，不套固定四段式；小节目录里的编号也要跟着改。
5. 下面的组件是菜单，不是清单：挑这一课真正用得到的，可以混用、可以不用。

## 组件标记

小节：

```html
<section id="s1">
  <h2><span class="num">01</span> 标题</h2>
  <p>正文。</p>
</section>
```

独立公式（`.tag` 可选）：

```html
<div class="eq">
  $$\mathbf{a}=\operatorname{softmax}\!\left(\frac{\mathbf{q}\mathbf{K}^{\top}}{\sqrt{d_k}}\right)$$
  <span class="tag">式 1 · 说明</span>
</div>
```

位串 / 指令 / 伪代码（等宽，**不是**数学）：

```html
<div class="formula"><span class="eq">IF → ID → EX → MEM → WB</span><span class="note">一句说明</span></div>
```

强调提示 / 前提：

```html
<div class="callout"><span class="tag">一句话</span><p>要记住的那句。</p></div>
<div class="plain"><span class="tag">前提</span><p>成立条件与边界。</p></div>
```

数据表（数字列加 `class="num"`，符号与维度用行内公式）：

```html
<table>
  <thead><tr><th>符号</th><th>含义</th><th class="num">维度</th></tr></thead>
  <tbody><tr><td>$\mathbf{q}$</td><td>查询向量</td><td class="num">$1\times d_k$</td></tr></tbody>
</table>
```

分步 / 两栏对比：

```html
<ol class="steps"><li>第一步。</li><li>第二步。</li></ol>
<div class="grid2"><div class="card"><p>左</p></div><div class="card"><p>右</p></div></div>
```

教学动画（放在对应小节之后；没有动画的小节不放占位）：

```html
<figure class="video">
  <video src="../out/类别/片段.mp4" poster="../out/类别/片段-poster.jpg" controls preload="metadata" playsinline></video>
  <figcaption>
    <span class="watch">看什么：盯住第几拍、哪一格在变。</span>
    <span class="source">源码：src/videos/类别/片段/index.tsx</span>
  </figcaption>
</figure>
```

课末验收（原生折叠，无 JS）：

```html
<div class="check">
  <p>课末验收</p>
  <details><summary>换一个情境的问题</summary><p>参考答案。</p></details>
</div>
```

自测题（正确项 `data-ok="1"`，`data-explain` 是判对后的解释，`data-question-id` 是课堂挂点；多选加 `data-multi="1"`、正确项可多条，写法见下面「课堂挂点」）：

可访问性由 `course.js` 自动补齐：题干与选项会包成 radiogroup、结论是 `role=status` 的 live region、改选项会让旧结论失效；页面另补 `main` 地标与「跳到正文」链接。手写题不必再带这些属性。

```html
<div class="quiz" data-question-id="q-3-1" data-explain="一句话解释。" data-scope="口径：怎么算才唯一。">
  <p class="q"><span class="tag">自测</span>题干。</p>
  <label><input type="radio" name="q1" value="a"> 选项一</label>
  <label><input type="radio" name="q1" value="b" data-ok="1"> 选项二</label>
  <label><input type="radio" name="q1" value="c"> 选项三</label>
  <button type="button">判卷</button>
  <p class="verdict"></p>
</div>
```

### 课堂挂点（`data-question-id`）

课堂模式下，页面里的 `.quiz` 只有带上 `data-question-id`，才会出现「提交到课堂」按钮；点了才把这次作答写进学习档案。

- **`data-question-id` 必须等于档案里的 `questionId`**（`teach_question_register` 登记的那个），不是页面自己的编号，也不是 `q1` 这类临时名。
- **控件取值协议**（课堂提交读的就是这些值，必须等于该题登记的答案）：
  - `radio` → 选中项的 `value`（旧页面也可用 `data-value` 或 input 的 `id`）；
  - `checkbox` → 全部选中项的 `value`，按英文逗号连接（多选只能靠它）；
  - `select` → 选中 option 的 `value`；
  - `input[type=number|range|text]` / `textarea` / 不写 `type` 的 input → 控件的 `value`。

  `value` 必须等于该题登记的 `options[].id`（例如 `a`、`b`、`c`）；不填时浏览器会给出默认值 `on`，对应不上档案选项。单选登记 `answer: "b"`，多选登记 `answer: ["a","b"]`。
- **顺序固定（`teach_question_register` 要求课程已发布）**：定 `questionId` → 写页面 → `teach_lesson_publish({dryRun:true})` 核对资源、题目 id 与课堂挂点 → 正式 `teach_lesson_publish` → `teach_question_register` 用同一个 id 登记 → 最后 `teach_lesson_open` 打开课堂。先开课堂再登记题目，页面里不会出现「提交到课堂」按钮（「刷新状态」会重开页面，但默认顺序别反）。
- 页面上的 id 在档案里没有对应题目时，课堂桥只在控制台提示一句，不乱加按钮；`lesson_lint` 会给一条 `quiz-question-id` 提醒（缺属性），发布回执会列出悬空 id。
- 一页多个 quiz 时用各自稳定的 id（例如 `q-3-1`、`q-3-2`），别复用。
- **不要自己写「提交到课堂」按钮**：桥给每个挂上 id 的 `.quiz` 自动补一只，并与「复制当前状态」并排放进同一个动作行。页面里再手写一只，会出现两个提交按钮（手写那只默认不生效；`lesson_lint` 会给 `quiz-manual-submit` 提醒）。确实想自定义文案或位置，就给那只按钮加 `data-teach-submit`（桥会接管它、不再补第二只）。

多选题（多选靠 checkbox，`.quiz` 带 `data-multi="1"`，正确项可以有多条 `data-ok="1"`，写在 checkbox 或 radio 上）；本地按集合判分：选中的 `value` 集合与 `data-ok` 集合完全一致才算对，少选、多选都算错。

```html
<div class="quiz" data-multi="1" data-question-id="q-3-2" data-explain="两处都要：……" data-scope="口径：怎么算才唯一。">
  <p class="q"><span class="tag">多选</span>题干。</p>
  <label><input type="checkbox" name="q2" value="a" data-ok="1"> 选项一</label>
  <label><input type="checkbox" name="q2" value="b"> 选项二</label>
  <label><input type="checkbox" name="q2" value="c" data-ok="1"> 选项三</label>
  <button type="button">判卷</button>
  <p class="verdict"></p>
</div>
```

登记这题时用 `answer: ["a","c"]`（与页面里两条 `data-ok="1"` 的 value 一致）；`teach_question_register` 的 `options[].id` 与页面 checkbox 的 `value` 一一对应。

## 复制为 Markdown（框架自己提供，不用写标记）

`course.js` 给每个 `.eq` 独立公式和每张 `table` 挂一个「复制 MD」按钮，悬停出现在右上角，点一下写进剪贴板：

- 公式 → `$$` 围栏包住原始 LaTeX（多行 `\begin{aligned}` 的缩进保留）；`.tag` 的编号另起一段跟在后面，删掉不影响公式。
- 表格 → GFM 管道表：表头取 `thead` 最后一行，列对齐取单元格实际渲染出来的 `text-align`，单元格里的行内公式还原成 `$…$`，`<code>` 还原成反引号。
- 不处理 `.formula`（位串 / 伪代码不是数学）与正文里的行内公式。

写课时的两条要求：**表格用 `thead` 写表头**（没有会补一行空表头，GFM 必须有分隔行）；**想复制成 `---:` 右对齐的列，CSS 里得真的右对齐**（`align` 是读出来的，不是猜的）。按钮、回执、样式都不用你写。

## 也可以只写 spec（LessonSpec，E2 起可选）

普通课程优先把「课程内容 + 自测题」写成一份 `*.spec.json`；需要特殊交互时仍可手写 HTML。
`teach_commit` 会编译成同目录同名 `.html` 再提交（页面与题目来自同一份源，改课只改 spec）。

```json
{
  "schemaVersion": 1,
  "id": "spec-0001",
  "meta": { "serial": "0001", "course": "课程 · 线性代数直觉", "eyebrow": "第 1 课", "title": "点积在度量什么", "lede": "一句话。" },
  "sections": [
    { "id": "s1", "title": "一、正文", "blocks": [
      { "kind": "p", "text": "段落里公式写 $\\mathbf{a}\\cdot\\mathbf{b}$。" },
      { "kind": "math", "tex": "\\mathbf{a}\\cdot\\mathbf{b}=|\\mathbf{a}||\\mathbf{b}|\\cos\\theta", "display": true },
      { "kind": "table", "head": ["符号", "含义"], "rows": [["$\\theta$", "夹角"]] },
      { "kind": "list", "ordered": true, "items": ["第一步"] },
      { "kind": "callout", "text": "一句提示。" }
    ] },
    { "id": "check", "kind": "quiz", "title": "验收", "questions": [
      { "questionId": "q-1", "type": "choice", "prompt": "选一个？", "scope": "口径：…", "explain": "…",
        "options": [{ "id": "a", "text": "A" }, { "id": "b", "text": "B" }], "answer": "a" },
      { "questionId": "q-2", "type": "explanation", "prompt": "说说理由？", "rubric": [{ "id": "r1", "text": "给出理由" }] }
    ] }
  ],
  "components": [],
  "assets": {}
}
```

规矩（编译器与 `teach_commit` 都按这些校验，违反就直接拒绝，不猜）：

- 顶层只允许 `schemaVersion / id / meta / sections / components / assets`；未知字段一律报错。正文块可选 `id`（段内唯一），段落 `id` 全课唯一；没有块 id 的旧 spec 输出保持原写法。
- `sections` 1–8 段，**恰好一段 `kind:"quiz"` 且在最后**；其它段只有 `id/title/blocks`。
- `blocks.kind` 允许 `p / math / table / list / callout / link / image / video`；table 必须有表头且每行列数一致。
- `numeric` 题的标准答案必须是**数字**（`4`，不能是 `"4"`：字符串会被判分侧读成 undefined 永远判错）。
- 开放题（`explanation` / `design`）必须给 `rubric`，否则判分没有依据。
- 公式写 `$…$` / `$$…$$`；**源文件里只写一个反斜杠**（写成 `\\\\mathbf` 会被 MathJax 当换行，页面看起来 0 硬伤却全是坏公式——`lesson_lint` 现在会报 `double-escaped-latex`）。
- 界面上的文字（标题、正文、选项）不要塞 HTML 标签：会被转义成字面量。

页面外观由 `templates/lesson.html` 与 `course.css` 决定，spec 只声明内容；要改样式改模板，不要指望在 spec 里塞样式。

### G1：来源链接与已有图片/视频（本地验证通过；真机课堂未验）

把这些块放在对应正文段的 `blocks` 中，按数组顺序出现，不需要追加 HTML：

```json
[
  { "kind": "link", "text": "原文：解析信号的定义", "href": "https://example.org/analytic-signal" },
  { "kind": "link", "text": "本地资料摘录", "href": "../RESOURCES.md" },
  { "kind": "image", "src": "../assets/images/spectrum.png", "alt": "实信号在正负频率处的两条谱线", "caption": "先预测清除负半边后幅度如何变化。" },
  { "kind": "video", "src": "../assets/video/phasor.mp4", "poster": "../assets/video/phasor-poster.png", "watch": "盯住正转和反转的投影。", "source": "src/videos/phasor/index.tsx", "caption": "先暂停预测，再播放核对。" }
]
```

示例文件和 URL 是格式示意，使用时换成已存在的资源与真实来源。`link` 必填 `text/href`；`image` 必填 `src/alt`；`video` 必填 `src/watch/source`。`caption`、`poster` 可省略；`source` 只是源码位置说明，不是下载链接。每类新块只接受上列字段，不能自设播放属性、脚本、样式或 iframe。

`href` 支持 HTTP(S)（不带用户名/密码）或相对文件路径；图片、视频、海报只引用本地文件。路径以生成 HTML 所在目录为基准，写原始相对文件名，不含空白、反斜杠、URL 编码、查询、片段、实体字符或隐藏目录。`../assets/…` 可用，实际工作区边界仍由发布链检查。引用含空白或特殊字符的本地文件前，应先准备名称符合规则的副本。

图片/视频/海报必须提前准备好；缺失时既有 lint 会拦截。新增图片样式在新版 `course.css` 中，旧工作区需保留自定义改动后同步。外链只提供来源入口，不自动下载、不保证离线可读；本地来源链接也要自行确认存在（既有发布扫描会略过缺失的 a 目标）。离线导出仍沿用大于 8 MiB 视频不内联的限制。

`schemaVersion` 仍为 1；旧 spec 没有新块时沿用原输出。旧版本不能编译这三种新块，回滚时保留源文件或手工降级；已发布的 HTML 不依赖编译器。旧 HTML 课程不自动迁移，spec 课修改源文件后重新编译，不直接编辑生成 HTML。

### G2：按稳定 ID 修改 spec（本地验证通过）

**脚本在插件包里，不在课程工作区**：本文件所在目录的上一级就是包根，下面命令里的 `<包根>` 换成它（提示词里 `{{teach_templates}}` 那条路径去掉末尾 `templates` 也一样）。在课程工作区里直接写 `node scripts/lesson-patch.mjs` 会找不到文件。

正文块可写 `{"id":"mechanism","kind":"p","text":"原文"}`，编译器给块根标签加 `data-node-id`。ID 在段内唯一；段落以 `section.id` 定位、题目以 `questionId` 定位。无 ID 的旧块可以用 `replace-section` 一次补 ID，不自动迁移现有课。

只读取得哈希和节点：

```bash
node <包根>/scripts/lesson-patch.mjs --workspace /path/to/course --spec lessons/0001.spec.json --inspect
```

将返回的 `expectedHash` 放入 patch JSON，例如（替换哈希与实际 ID）：

```json
{
  "schemaVersion": 1,
  "expectedHash": "填入 inspect 返回的 64 位 SHA-256",
  "operations": [
    { "op": "replace-block", "sectionId": "s1", "blockId": "mechanism", "value": { "id": "mechanism", "kind": "p", "text": "改后的解释。" } }
  ]
}
```

```bash
node <包根>/scripts/lesson-patch.mjs --workspace /path/to/course --spec lessons/0001.spec.json --patch change.json
node <包根>/scripts/lesson-patch.mjs --workspace /path/to/course --spec lessons/0001.spec.json --patch change.json --apply
```

第一条默认演练，返回 `resultHash`；需要幂等重试时，将它补到 patch 的可选同名字段，正式执行后重复请求会返回 `alreadyApplied:true`。其他改动造成哈希不匹配时明确冲突，不盲目覆盖。

支持 `replace-section(sectionId,value)`、`replace-block(sectionId,blockId,value)`、`insert-block(sectionId,afterId?,value)`、`remove-block(sectionId,blockId)`、`replace-question(sectionId,questionId,value)`。替换保留目标 ID；插入块必须有新 ID，afterId 省略时追加。一批 1–100 个操作，最终仍须满足完整 schema。哈希按 JSON 内容稳定排序计算，不计文件缩进。

**硬伤口径**：patch 只拒绝「这次修改新增的硬伤」——原文件已有的硬伤不挡你分步修（先修一条、再修第二条）；新增硬伤会带错误码直接拒绝。发布前仍要求整页全绿，所以修完还要 `lesson_lint` 到 0 硬伤再 `teach_commit`。

`--apply` 只原子写 spec，不生成 HTML、不发布、不登记题目；之后按原流程调用 `teach_commit`。若发布失败，源文件仍保留修改，修好后重试发布。不要直接修改生成 HTML；不要把“源已改”当成“课程已发布”。

## 结构约束

- 正文包在 `div.shell > div.wrap` 里，`aside.sidenav` 必须是 `.shell` 的第一个子节点。
- 窄屏（<1040px）自动切回 `nav.toc`，不用另写移动端版。
- `header.course` 里 `.eyebrow` / `h1` / `.lede` / `.meta` 的顺序不要换。

## 字体

- 公式字体由 MathJax 自带（SVG 路径，TeX 数学字体），不跟随正文宋体；不要给 `mjx-container` 或 `*` 设正文字体。
- 中文不要写进公式：`$\text{中文}$` 会掉回正文字体。中文说明放正文。
- 维度、符号、上下标一律行内公式（`$1\times d_k$`、`$\mathbf{q}$`）；`<code>` 只留给代码、文件名与位串。

## 换风格改哪里

只改 `course.css` 的 `:root`：`--paper` `--ink` `--accent` `--serif` 决定气质，`--font-size` `--line-height` `--measure` `--sidebar` `--gutter` 决定版式尺度；结构（`.shell` / `section` / 组件类名）不动。断点 1040px 写在媒体查询里（CSS 变量进不去），要改就三处一起改。

## 三条硬规矩

1. **公式必须真排版**：数学一律 LaTeX，不许等宽文字拼公式；`.formula` 只放位串与伪代码。
2. **视频放在对应小节之后**，配「看什么」与源码位置。
3. **组件按需取用，也可以新增**：现有类够用就别加；确实需要新表达时，先写进 `course.css`，再在这里登记一行，下一课就能复用。不要为了「用上某个组件」而加它。
