---
name: dsh-teach-me
description: 朱批讲义——暖纸、宋体、一道朱红，为离线长读而生
colors:
  paper: "#fbf9f4"
  paper-2: "#f4efe6"
  paper-raised: "#ffffff"
  ink: "#16120f"
  ink-soft: "#4a423a"
  rule: "#d8d0c2"
  accent: "#9c3524"
  accent-2: "#7a2a1c"
  accent-soft: "#f5eae4"
  good: "#2c6a4d"
  bad: "#a3341f"
  paper-dark: "#15130f"
  paper-2-dark: "#1e1b16"
  paper-raised-dark: "#1b1813"
  ink-dark: "#ece7dd"
  ink-soft-dark: "#b6ac9c"
  rule-dark: "#3a342b"
  accent-dark: "#d2643f"
  accent-2-dark: "#e3906f"
  accent-soft-dark: "#2a1f19"
  good-dark: "#7bbf96"
  bad-dark: "#e08a72"
typography:
  display:
    fontFamily: '"方正标雅宋简体","FZYaSongS-R","Songti SC","STSong","SimSun",serif'
    fontSize: "2.05rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0.01em"
  title:
    fontFamily: '"方正标雅宋简体","FZYaSongS-R","Songti SC","STSong","SimSun",serif'
    fontSize: "1.3rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.01em"
  subtitle:
    fontFamily: '"方正标雅宋简体","FZYaSongS-R","Songti SC","STSong","SimSun",serif'
    fontSize: "1.02rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: '"方正标雅宋简体","FZYaSongS-R","Songti SC","STSong","SimSun",serif'
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.95
    fontFeature: '"palt" 1'
  lede:
    fontFamily: '"方正标雅宋简体","FZYaSongS-R","Songti SC","STSong","SimSun",serif'
    fontSize: "1.06rem"
    lineHeight: 1.85
  label:
    fontFamily: 'ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace'
    fontSize: "0.72rem"
    letterSpacing: "0.16em"
  mono:
    fontFamily: 'ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace'
    fontSize: "0.86rem"
    lineHeight: 1.7
rounded:
  none: "0"
  xs: "2px"
  sm: "4px"
  pill: "50%"
spacing:
  xs: "0.35rem"
  sm: "0.55rem"
  md: "0.9rem"
  lg: "1.3rem"
  xl: "1.6rem"
  section: "3.6rem"
  page-top: "4.5rem"
components:
  callout:
    backgroundColor: "{colors.accent-soft}"
    padding: "1rem 1.3rem"
    rounded: "{rounded.none}"
  plain-block:
    backgroundColor: "{colors.paper-2}"
    padding: "1rem 1.3rem"
    rounded: "{rounded.none}"
  raised-card:
    backgroundColor: "{colors.paper-raised}"
    padding: "1rem 1.2rem"
    rounded: "{rounded.none}"
  formula-block:
    backgroundColor: "{colors.paper-raised}"
    padding: "1.1rem 1.4rem"
    rounded: "{rounded.none}"
  quiz:
    backgroundColor: "{colors.paper-raised}"
    padding: "1.1rem 1.3rem"
    rounded: "{rounded.none}"
  quiz-submit:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    padding: "0.5rem 0.9rem"
    rounded: "{rounded.none}"
  widget-button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    padding: "0.55rem 0.8rem"
    rounded: "{rounded.xs}"
    height: "44px"
  sidenav-current:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent-2}"
    padding: "0.3rem 0.55rem 0.3rem 0.6rem"
    rounded: "{rounded.none}"
  markdown-copy:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    padding: "0.32rem 0.45rem"
    rounded: "{rounded.none}"
---

# Design System: dsh-teach-me

## Overview

**Creative North Star: "朱批讲义"**

课程页是一张发到学习者手里的纸质讲义：暖白纸底、宋体正文、细如刻线的分隔，一道朱红只出现在需要你抬头看的地方——章节序号、引导条、当前条目、判卷结论。它模仿的不是屏幕，是印出来的东西：一句话可以慢慢读，一个数字可以核对，一页可以打印，关掉网络仍然成立。气质词是 **学究、温暖、纸感、精确**；四个词约束同一件事——不用装饰抢走文字的注意力。

这个仓库有三种承载面，只有课程页拥有完整的视觉系统。**课程页**由 `templates/course.css` 定义，本文件的全部令牌来自它，学习者和生成课程的 agent 直接看到的就是这一面。**宿主内界面**（设置页、侧栏选课、课堂页签）由 `client.js` 渲染，刻意不自带配色：全部继承 DSH 的 `--dsw-*` 令牌、宿主 12px 的圆角与 11–16px 的四档字阶，只保留克制的状态行。**教学动画**是独立规范，见 `templates/ANIMATION.md`：它的颜色与字体与课程页 `:root` 同源，但画布、字号、元件由那份规范独占，不在本文件的令牌范围内。

课程页的密度是长读的密度：单栏、46rem、行高 1.95，章节之间留 3.6rem。教学组件（闪卡、时间线、图表）可以被操作，但它们仍然嵌在同一张纸里，不自成一套 UI 语言。

**Key Characteristics:**
- 暖纸底 + 墨色正文 + 一道朱红（Cinnabar），没有第二个彩色角色
- 宋体承担正文（19px / 1.95），等宽只做标签、代码、位串与数字
- 结构块一律直角；分层只靠 Bone 细线与纸色深浅，不靠阴影
- 深色模式是同一张纸的夜读版（`*-dark`），不是第二套配色
- 打印与离线是一等状态：导航、按钮、复制回执在打印时全部隐藏

## Colors

**Character:** 纸、墨、朱、石绿、赭——像一盒文房加校样颜料，每种颜色只承担一个含义。

### Primary
- **Cinnabar** (#9c3524)：标题序号、引导条左侧 3px 竖线、链接下划线、当前条目、判卷按钮悬停。它标记「现在看这里」。
- **Cinnabar Deep** (#7a2a1c)：正文链接文字、当前条目的文字色。比 Cinnabar 深一档，保证小字号仍然可读。
- **Cinnabar Wash** (#f5eae4)：提示块、学习目标块的底色。朱红的稀释版，只能当底，不能当文字。

### Neutral
- **Rice Paper** (#fbf9f4)：页面底色。暖白而非纯白，长时间阅读不刺眼。
- **Rice Paper Fold** (#f4efe6)：次级底——目录、代码、浮层、闪卡面。
- **Rice Paper Raised** (#ffffff)：卡片、自测题、公式块这类「放在纸上的纸」。`course.css` 里目前是字面量 `#fff`（深色模式覆盖为 `#1b1813`），是全系统唯一未变量化的颜色。
- **Lamp Black** (#16120f)：正文与标题。近黑而非纯黑，与纸色同温。
- **Lamp Black Soft** (#4a423a)：辅助文字——导语、图注、元信息、提示。
- **Bone** (#d8d0c2)：分隔线、边框、表格横线、禁用态。系统里所有「线」都由它画。

### Semantic
- **Malachite** (#2c6a4d)：判对、已完成。只在判卷结论与状态里出现。
- **Burnt Ochre** (#a3341f)：判错、错误提示。比 Cinnabar 更暗更钝，避免与强调色混淆。

**The One Vermilion Rule.** 朱红是注意力预算，一屏占比不超过 10%。它只标记「当前 / 重要 / 可点」，不做背景、不做装饰、不做插图配色。

**The Verdict-Only Green Rule.** Malachite 与 Burnt Ochre 只出现在判卷结果、状态提示与错误文案里；正文、标题、导航永远不用它们。

**The Night Paper Rule.** `prefers-color-scheme: dark` 只把同一组角色换成 `*-dark` 档位：纸变墨、墨变纸、朱红提亮一档。不新增语义、不新增颜色、不把深色当成第二套主题。

## Typography

**Display Font:** 方正标雅宋简体（回退 Songti SC / STSong / SimSun / serif）
**Body Font:** 同族——正文与标题共用一套宋体
**Label/Mono Font:** ui-monospace / SF Mono / SFMono-Regular / Menlo / Consolas

**Character:** 一套宋体走到底，靠字号、字重与字距分层。等宽不是「代码字体」，而是标签语言——大写小字、编号、位串、数字、按钮文案都穿它。

### Hierarchy
- **Display**（600，2.05rem，1.35，字距 0.01em）：课程标题，一屏只出现一次，下方压 2px 墨线。
- **Title**（600，1.3rem，1.5，字距 0.01em）：章节标题，配 1px Bone 下划线；序号用等宽朱红小字前缀。
- **Subtitle**（600，1.02rem，1.5）：小节内的分点标题。
- **Body**（400，19px，1.95，开启 `palt` 比例字距）：正文；行宽上限 46rem（约 70–80 字符）。
- **Lede**（400，1.06rem，1.85，Lamp Black Soft）：标题下的一段话，说清这一课回答什么。
- **Label**（等宽，0.72rem，字距 0.16em，大写）：eyebrow、表头、按钮、元信息、组件标签。

**The Serif Carries the Body Rule.** 正文、标题、导语、图注一律 `--serif`。无衬线体只允许出现在教学动画的对象标注里（见 ANIMATION.md），课程页正文永不换族。

**The Mono Is a Label Rule.** 等宽只用于四类内容：标签与按钮文案、代码与位串、数字与版本号、时钟式元信息。等宽不承担整段正文。标题上方的 eyebrow（如「组件示例 · 数据比较」）承载课程编号与模块，是文档头信息而不是装饰性 kicker；检测器的 `hero-eyebrow-chip` 属于已知例外，删掉它会改掉所有课的页头。

**The MathJax Owns Math Rule.** 公式由 MathJax tex-svg 排版，字体是渲染器自带的 TeX 数学字体。不要给 `mjx-container` 或 `*` 设正文字体；中文不写进公式（`\text{中文}` 会掉回正文族）。

## Layout

单栏长读。宽屏下页面是「常驻侧栏 + 正文」两列：侧栏 13.5rem、间隙 2.75rem、正文上限 46rem；总宽 `calc(13.5rem + 2.75rem + 46rem)`。侧栏 sticky 常驻，正文区不再出现目录；≤1040px 时侧栏隐藏，同一份目录以 `nav.toc` 回到正文顶部；≤640px 时目录收成一行可换行的链接（命中区 44px）。章节节奏 3.6rem，块间距 1.6rem，页面顶部留白 4.5rem。打印时网格折成单列、正文回到 46rem 量度，标题改用 pt 刻度（h1 20pt / h2 13pt）。

**The 46rem Rule.** 正文行宽 46rem 是硬上限，约 70–80 字符。新增块不得突破；宽内容用横向滚动或拆行，不要拉宽整页。

**The One Column Rule.** 正文永远单列。`grid2` 只用于成对的对照卡片，≤640px 折成一列；不用多栏排正文。

## Elevation & Depth

**Flat by default.** 卡片、提示块、公式块、自测题全部平贴纸面，没有投影。「层」由 Bone 细线、Rice Paper Fold 的底色差与左侧朱红竖线表达。唯一属于浮层的投影是复制失败时的源码兜底面板（`0 6px 24px rgba(0, 0, 0, 0.18)`）；底部 toast 用墨色实底代替阴影。

**The Flat-By-Default Rule.** 静态内容平不下来，说明用错了手段：先加一条 Bone 线，再考虑纸色差，最后才谈阴影。装饰性深度一律禁止。

### Shadow Vocabulary
- **overlay-lift** (`box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18)`)：只给源码兜底浮层；它盖住正文、需要读者注意到。
- **card-ambient** (`box-shadow: 0 2px 10px rgba(22, 18, 15, 0.06)`)：本次确认允许卡片在必须明确分层时使用；现有 `course.css` 尚未实现，默认仍是平面。

## Shapes

结构块全部直角（0 圆角）：卡片、提示块、公式块、自测题、按钮、目录项。仅三处例外：行内代码 2px、表单控件 4px、步骤序号 50% 圆。边框只有三种重量：1px Bone（分隔）、3px Cinnabar（左侧引导条）、1.5–2px Lamp Black（表头下缘、课程标题下缘）。

**The No-Radius Rule.** 圆角不是「柔和」，在这个系统里是「另一个产品的语言」。新组件默认 0；只有表单控件与行内代码可以各留 2–4px。

**The Left-Rule Rule.** 需要强调一个块时，用左侧 3px 朱红竖线加稀释朱红底；不要给整块描彩色边框或铺背景色块。

## Components

课程页的每个块都从纸出发：直角、细线、无浮起。以下数值取自 `templates/course.css` 与 `ui/components.css`。

### 提示块（Callout）
- **形状：** 直角，左侧 3px Cinnabar 竖线（其余三侧无边框）
- **底色：** Cinnabar Wash；正文 Lamp Black
- **标签：** 首行 `tag` 等宽 0.68rem 大写、字距 0.14em、Cinnabar
- **用途：** 一个必须看见的提醒，不是装饰性强调

### 普通块（Plain）
- **形状：** 1px Bone 边框、直角、Rice Paper Fold 底
- **标签：** `tag` 用 Lamp Black Soft
- **用途：** 不构成「提醒」的旁注、定义、材料说明

### 卡片 / 凸起面
- **形状：** 1px Bone 边框、直角、Rice Paper Raised 底
- **内部：** padding 1rem 1.2rem；无投影
- **现状：** 底色是字面量 `#fff`，深色模式覆盖为 `#1b1813`

### 公式块（`.eq` 与 `.formula`）
- **`.eq`：** 居中、无底色、上下各 1rem；编号用等宽 `.tag`，字号 0.7rem、Lamp Black Soft
- **`.formula`：** 等宽位串 / 伪代码专用，Rice Paper Raised 底 + 3px Cinnabar 左线，字号 0.92rem、行高 2
- **边界：** 数学只走 MathJax；不要把 `.formula` 当数学排版用

### 表格
- **形态：** 无竖线；表头等宽 0.72rem 大写、字距 0.1em；表头下缘 1.5px Lamp Black，末行 1.5px Lamp Black 收口
- **单元格：** padding 0.55rem 0.6rem、行内 1px Bone；数字列 `td.num` 等宽不换行
- **复制：** 输出 GFM 管道表，按真实右对齐还原对齐标记

### 自测题（Quiz）
- **形态：** Rice Paper Raised 底、1px Bone 框、直角、padding 1.1rem 1.3rem
- **选项：** 整行 `label`，未选中无装饰、选中用原生 radio
- **判卷按钮：** Lamp Black 实底 + Rice Paper 文字，等宽 0.78rem 大写；悬停转 Cinnabar
- **作答控件：** `textarea` / `text` / `number` 用 Rice Paper Fold 底、1px Bone 框、4px 圆角；聚焦时 2px Cinnabar Wash 外圈 + Cinnabar 描边
- **结论：** `.verdict.ok` 用 Malachite，`.verdict.no` 用 Burnt Ochre；结论行常驻高度，避免页面跳动

### 学习目标与验收
- **目标块：** `.goals` 用 Cinnabar Wash 底 + 3px Cinnabar 左线；`::before` 固定文案「学完你能做到」（等宽小字大写）
- **验收：** `details/summary` 折叠答案，顶部一条 Bone 分隔；不用弹窗、不用抽屉

### 阅读导航（sidenav / toc）
- **侧栏：** 13.5rem、sticky、右侧 1px Bone 边线；链接 0.85rem、Lamp Black Soft
- **当前项：** Cinnabar Wash 底 + 左侧 2px Cinnabar + Cinnabar Deep 文字 + 600
- **窄屏：** ≤1040px 侧栏消失，正文顶部出现 `nav.toc`（Rice Paper Fold 底、1px Bone 框）

### 复制为 Markdown（md-copy + toast）
- **触发：** 悬停公式 / 表格才出现（触屏常驻 0.6 透明度）；等宽 0.6rem 大写、1px Bone 边框
- **回执：** 底部居中、Lamp Black 实底、Rice Paper 文字，1.8s 自动消失
- **兜底：** 剪贴板不可用时展开源码浮层，带 overlay-lift 投影

### 教学组件（闪卡 / 时间线 / 图表）
- **外壳：** 1px Bone 框、Rice Paper 底、直角、padding 1.15rem 1.3rem；标题 0.98rem，右侧等宽计数（tabular-nums）
- **按钮：** 等宽 0.76rem、Rice Paper 底、1px Bone 框、2px 圆角、min-height 44px；悬停转 Cinnabar
- **闪卡：** Rice Paper Fold 面、min-height 10rem、左对齐；翻面即换面，不加翻转动画
- **时间线：** 6.5rem 日期列 + 正文列；节点是 6px Cinnabar 圆点，连线 1px Bone
- **图表：** ECharts SVG，读数继承正文色；轴与数值标签 13px、等宽数字（数字是这一课最该看清的内容，不与小字同档）；控件 grid 为 `minmax(6rem,1fr) minmax(5rem,2fr) 3rem`，滑块 `accent-color` 用 Cinnabar
- **动效：** 遵守 `prefers-reduced-motion`，动画全关
- **状态与复制：** 当前状态行只给读屏（`sr-only` + `aria-live`），不在纸面重复卡面内容；「复制当前状态」是安静的等宽文字按钮（下划线，无边框），桌面 36px、触屏 44px

### 承载面：宿主内界面（设置页 / 选课 / 课堂）
- **这一面的主张：** 宿主里的客人不自带皮肤。辨识度来自信息本身——一节课的学习记录（题量、已答、待批改、结论、作答日期）成为一条对齐的账目行：名字在左、数字在右、结论是词不是枚举。颜色只标「要动手的那一件」，其余是墨色与次级灰
- **样式层：** 三个面共用一套 `tsm-*` 作用域类，样式来自随组件挂载注入的一段样式表（`SURFACE_CSS`），不再用内联对象——伪类、媒体查询、容器查询只有样式表表达得了。作用域挂在每个面的根节点上，不引第二套样式表，也不外泄到宿主
- **令牌：** 只用宿主令牌——文字 `--dsw-alias-label-primary` / `-secondary`；错误 `--dsw-alias-label-error`（宿主缺失时回退 `--dsw-alias-state-error-primary`，深色 5.55 / 浅色 4.50）；失效印章底 `--dsw-alias-state-warn-tertiary`（浅 `#fef5e7` / 深 `#27241f`）+ 墨色字；底面 `--dsw-alias-bg-base`；悬停 `--dsw-alias-interactive-bg-hover`；骨架 `--dsw-alias-bg-skeleton`；线 `--dsw-alias-border-l2` / `-l3` / `-l4`；圆角 `--dsw-radius-sm`（8）与 `--dsw-radius-xs`（4）；焦点环 `--dsw-focus-ring-color` / `-width`，回退改跟宿主自己的 `--dsw-alias-state-business-primary`；字体 `--dsw-font-family`，等宽 `--dsh-font-family-code-default`
- **字号：** 不另造档，全部映射到宿主的字号令牌——`--dsw-font-base-16`（标题）/ `--dsw-font-s-14`（分节名、课程名）/ `--dsw-font-xs-13`（正文、标签、控件）/ `--dsw-font-xxs-12`（说明、元信息、账目行、通知）。**11px 已全部取消**：宿主给 11px 的 14px 行高在中文里读不清，且它承载过浅色下 2.79:1 的警告
- **间距：** 每个值一个角色——2 行内补充 / 4 行内空隙 / 6 字段内部（标签-控件-说明）/ 8 元素之间 / 12 面板内边距 / 16 字段之间 / 20 分节上 / 24 分节下（把分隔线托起来）/ 28 页头之下
- **数字：** 题量、已答、待批改、日期一律 `font-variant-numeric: tabular-nums`；等宽只给路径
- **惯例：** 不自带纸色、不用朱红、不用宿主 `state-warn-label` 承载文字（浅色只有 2.79:1）；warn 只做印章底，句子用墨色
- **结论词表：** `passed / needs_practice / needs_review / failed` → 通过 / 需练习 / 待复核 / 未通过；未知值原样显示，不猜。选课行与课堂账目行用同一套词
- **五态一套句法：** 载入用真实行高的骨架条（`--dsw-alias-bg-skeleton`）：选课三条课行、课堂一条头部 + 一块整帧骨架，配一句 `sr-only` 的「正在打开课堂…」；空态与失败态都带「发生了什么 + 下一步 + 一个真动作」；状态块的内边距只由容器给（面板里 0、列表里补回 12px），reset 走 `:where()` 零权重，不靠标签碰巧是 `div` 还是 `p`；只读/未加载的理由压在页头之下、字段之上；在飞时按钮禁用且改用次级色而不是 `opacity`（`opacity:.55` 会把 5.80:1 压到 2.31:1）
- **边界：** 课堂内容运行在沙箱 iframe 中，iframe 内部才是课程页系统；宿主 CSS 不继承进去

#### 设置页（设置 → 教学模式）
- **没读完不下结论：** 配置还没就绪（`loading` / `unavailable`）时不印生效状态句、也不画字段组——禁用控件里的默认值会被读成「已经这么选了」，而句子「这一版不做动画」更是编事实。此时只留标题与「读取中…」
- **骨架：** 页头两段——标题 16 + **生效状态句**（墨色 13，由配置算出来：这一版做不做动画；目录已保存不等于工程可用，所以写「工程本身还没验证」）；下面一行 12 灰字讲怎么保存。然后两个分节：动画工程（工程目录 / 工程缺失时 / 源码放工作区）与动画时长（时长上限），分节之间一条 `.5px` 线，上 20 / 下 24
- **为什么有分节名：** 四个字段原本同权重平铺，读者要先读四条说明才知道它们在管两件事。分节名把「工程本身」与「成片时长」分开
- **字段解剖：** 名字在上（13/500）、控件在下（36px 高、`--dsw-radius-sm`）、说明再下（12 灰）。勾选项**方框在名字左边 8px**：这一页只有一个开关，把它推到行尾不是宿主解剖，是在行中央造一条 500px 的空白
- **说明长度：** 一句话说明最多两行；先钉事实，不追加第二句承诺
- **焦点环：** 用宿主的 `--dsw-focus-ring-*`（2px、offset 2px）。禁止 `outline:none` 之后不补替代环；滚动容器里的元素改用内描边（`outline-offset:-2px`），否则会被裁掉
- **保存结果：** `正在保存 / 已保存` 贴着标签（8px），2.4s 后自己消失；**失败落在控件下方**、用错误色，并进 `aria-describedby`——错误是要动手的，不能离控件远。唯一读屏活区在页尾 `sr-only`，播报「字段 · 结果」，字段旁文字 `aria-hidden`；同一句连说两遍时先清空再写入，否则读屏不会重播
- **校验：** 动画时长上限只接受 10–600 的整数秒。它是**整片**的软性上限，不是单个分镜的秒数（与 schema、动画协议同一口径；超了在分镜理由里写一句，不另设分镜上限）。范围外不静默改成 10 或 600：恢复上次保存的值并说明原因；清空 = 回到默认 120 秒，不写配置
- **禁用：** 配置未加载或只读时控件禁用，理由写在页头之下（不进页头），控件与标签一起转次级色
- **命中区：** `pointer: coarse` 下控件、主钮、文字钮一律 44px，勾选框 20×20 且行高 44；`prefers-reduced-motion` 下关掉 120ms 的边框与底色过渡

#### 选课（侧栏）
- **顶部条：** 不再重复页签名（宿主页签已经写着「教学模式 · 选课」），只留「N 节课」与刷新（文字钮）
- **一行一课：** 整行就是一个按钮——键盘一次 Tab 到一课、回车即开；可访问名是「打开 <课程名>，N 题」，元信息走 `aria-describedby`，读屏不会先听一整行字
- **两行信息：** 第一行标题（14/500，单行省略，带原生 `title`）+ 右对齐的题量（tabular）+ 行尾 `›`；第二行只放**一个状态词**加日期：当前有效的结论（要动手的用错误色）、失效印章「评估已过期」+ 灰字「上次 未通过（原因）」、或「已提交，暂无结论 / 未提交作答 / 本课没有练习题」，日期说清是「作答」还是「评估」
- **入口常驻：** 行尾一个 `›`（`aria-hidden`）说明「这一行能进」，题量不随悬停消失；整行仍是按钮，键盘一次 Tab 到一课、回车即开
- **题号不一致：** 两个方向分开计数、合成一行——`missingPageIds`（页面写了、档案没登记）说「N 题还没登记进档案」，`unmappedQuestionIds`（档案有、页面没排）说「N 题没排进页面」；具体题号只进 `title`。行里讲学习者能懂的事实，内部 id 不撑行高。有这一行时不再印「本课没有练习题」——同一行不能一边说没题一边说有题没登记；这一行同时进 `aria-describedby`（`aria-label` 会盖住子元素，不挂上去读屏就听不到）
- **失败态：** 保留顶部条与列表线（换状态时版面不跳），断言式活区只包文字、不包按钮；重试是描边主钮，不是一行灰色小字。刷新失败不吞掉已画出来的列表：有数据就留着，错误落在提示行

#### 课堂（页签）
- **账目行常驻：** 课程名下一行是计数 `4 题 · 已答 3 · 其中待批改 1`（待批改本来就是已答里没判的那部分，不写「其中」会被读成 3+1=4 之外再加 1），再下一句「最近评估：未通过 · 11-01」——那一词只代表最近一次有效评估，不冒充整课结论。打开时读一次 `classroom/status`（一次本地调用，宿主限频 60/分），失败只显示题量——账目行不是「点刷新才闪一下」的通知
- **断言式状态：** 失败/缺地址两块里的 `role="alert"` 只包那几句话，按钮在活区之外——否则读屏会把「重新打开」一起念成警报内容
- **导航与动作分离：** 第一行是返回式导航（可见「‹ 选课」，读屏名只念「选课」）+ 课程名；第二行才是动作——「重新加载课堂」是唯一主钮（它确实重开课堂、换掉 iframe 的 key），导出 / 导入是不带下划线的次级钮。失败态与缺地址态保留这条导航，并给一个真的会重跑 `classroom/open` 的「重新打开」
- **状态行：** 常量高度，只报最近一次动作（课堂已重新加载 / 已提交 / 导出失败）；成功次要色、失败错误色；两条读屏活区（polite / assertive），同一时刻只有一条有字
- **分隔与缩放：** 状态行与课程页之间一条 `.5px` 线；面板 `overflow:hidden`，iframe 可收缩，矮侧栏里让位给状态行而不是把状态行挤出去

- **检测器读数：** 宿主面上的 12 / 13 / 14 / 16px 字阶与 8 / 4px 圆角来自宿主字号与圆角令牌，不属于课程页字阶——`design-system-font-size` 对 `client.js` 的提示是已知例外


### 承载面：教学动画
- **规范：** 以 `templates/ANIMATION.md` 为准——1920×1080、30fps、安全区、五状态、字号下限 28 / 26
- **同源：** 颜色与字体取自课程页 `:root`（paper / paper2 / ink / inkSoft / rule / accent / accentSoft）
- **容器：** `figure.video` 用 `#101216` 作视频黑边底、Bone 边框，图注等宽 0.76rem

## Do's and Don'ts

### Do:
- **Do** 只通过 `:root` 变量改课程页的纸色、强调色、字体与版式尺度；结构规则不动，改一次全站生效。
- **Do** 正文一律宋体族（`--serif`），等宽只给标签、代码、位串与数字。
- **Do** 把朱红留给有含义的位置：标题序号、左侧引导条、链接下划线、当前项、判卷结论。
- **Do** 公式用 LaTeX + MathJax tex-svg 真排版；中文写进正文，不进公式。
- **Do** 保持 46rem 量度、3.6rem 章节节奏、1.6rem 块间距。
- **Do** 深色模式沿用同一组角色（`*-dark`），不新增第二套语义。
- **Do** 打印样式隐藏全部交互（按钮、toast、复制、导航），并把交互块从流里移走。
- **Do** 宿主内界面只用 `--dsw-*` 令牌，圆角与字号跟宿主，不引入纸色。
- **Do** 键盘焦点统一用 2px Cinnabar 环（`outline-offset:3px`）；每页首个可聚焦元素是「跳到正文」。
- **Do** 宿主内界面的焦点环用 `--dsw-focus-ring-*`；保存结果贴着它描述的那个字段，不堆在页尾。

### Don't:
- **Don't** 另写第二套课程样式；工作区已有 `course.css` 就沿用它，不并行两套。
- **Don't** 给结构块加圆角，或把内容排成卡片网格。
- **Don't** 使用渐变、发光、玻璃拟态、装饰纹样；也不用 SaaS 仪表盘的图标彩块。
- **Don't** 加装饰性动效或入场编排；过渡只用于状态（120–160ms ease）。
- **Don't** 用无衬线体承担正文，或用展示字体做标签、按钮、数据。
- **Don't** 把朱红铺成大色块、当背景装饰，或用它标记非交互、非当前的内容。
- **Don't** 在 `mjx-container` 上设正文字体，也不要为了「统一」换公式字体。
- **Don't** 把宿主界面（设置页、侧栏、课堂壳）染成课程页的纸色；它们属于宿主。
- **Don't** 用大圆角、深色霓虹代码编辑器风或杂志式花哨排版来「提升现代感」。

