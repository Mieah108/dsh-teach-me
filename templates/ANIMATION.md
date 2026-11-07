# 教学动画视觉规范

写动画源码时读一次。这里的每一项都是**默认值**：照抄就能出一套稳定、统一的画面，不需要再做设计探索。**工程既有件优先于本文档的默认值**：与工程现有组件冲突时按既有件取值，并逐条记进 `storyboard.md` 末尾的「偏离」表（记法见第 9 节）；内容确实放不下、或默认值会让人误读时也可以偏离，同样记在那张表里。

文中的「雅宋」是标题字体角色：优先使用已合法安装的对应字体，缺少时使用示例字体栈中的系统回退。字体文件不随本包分发，也不要求为使用模板另行下载字体。

## 0. 用法：按顺序做五个决定，每个决定查一次表

已有工程组件与相近动画可复用时，按需读 [Remotion 复用配方](recipes/remotion-reuse.md)：用既有图元和拍数据完成新课，不新增第二套主题或动画库。配方是使用指引，不替代每次制作确认和受管同步。

0. **工程既有约定**：先打开工程看一遍——根 `src/theme.ts` 导出了什么、`src/videos/shared/` 里有什么现成组件、已有视频怎么 import。工程已经有等价物就一律复用它，**不要为了满足本文档的 `src/shared/` 路径另造第二套 token**；本文档给的路径是默认落点，不是必须新建的目录。
1. **shared/ 有没有**：工程已有 `theme.ts`、`motion.ts`、`SceneFrame.tsx`（或在别处提供了等价导出）就直接 import，读一次导出名，不重写。确实没有才把第 2、6、7 节的代码落盘（一次 write 一个文件）。
2. **版式**：按第 4 节「知识结构 → 版式」挑一个主版式，最多再加一个读数区。不出多套方案。
3. **元件**：舞台上的东西都从第 3 节的元件里取，尺寸照表。缺元件就按第 3 节的规则新增，并放进共享位置留着复用。
4. **动作**：每拍的动作从第 5 节的动作配方里取，曲线和帧数照表。
5. **预检**：still 抽帧时按第 8 节的清单打勾，过了就交，不为像素级对齐反复抽帧。

**不做**：配色探索、字体比选、做两版让人挑、写设计说明、加纹理和装饰。

**长度与幕数**：只有一个判据——这段讲解能不能完整走完（该交代的因果、该对照的两边、该落下的一句结论都在画面里）。幕数由「需要几次画面切换才讲得完」决定，不是固定规格，也不要沿用上一部的段数。软性上限 2 分钟，超过就在 `storyboard.md` 写一句为什么必须这么长。

## 1. 画布与分区（1920×1080，30fps）

```
x:120                                                       x:1800
┌──────────────────────────────────────────────────────────────┐ y:90
│ 幕标题（雅宋 56）                          2 / 4 · 流水冒险（mono 26）│
├──────────────────────────────────────────────────────────────┤ y:170 细线
│                                                              │ y:200
│                    舞台 1680 × 660                            │
│              （对象占舞台一半左右，四周留白）                  │
│                                                              │ y:860
│                字幕（40，居中，一行，尽量 ≤22 字）              │ y:900–990
└──────────────────────────────────────────────────────────────┘
```

- 安全区：左右 120，上下 90。任何文字都不出安全区。
- 所有尺寸、间距取 8 的倍数；同类对象等宽、等距、同一基线。
- 舞台内容整体居中；只有一个主对象时，把它放在舞台中心略偏上（视觉中心约在 y≈500）。
- 开场提问幕和收束幕可以不要舞台：问题或结论用雅宋 64 居中，最多两行。

## 2. 颜色与状态

与课程页 `course.css` 的 `:root` 同源。工作区的 `course.css` 改过色，就照它的值抄过来。

| 用途 | token | 规则 |
|---|---|---|
| 背景 | `paper` | 全片纯色，不加渐变和纹理 |
| 次级底 | `paper2` | 已完成的对象、读数区底色 |
| 主文字 / 主线 | `ink` | 标题、对象内文字 |
| 辅助文字 / 普通线 | `inkSoft` | 标注、箭头、坐标轴 |
| 分隔线 / 未到 | `rule` | 顶栏细线、网格线、未激活描边 |
| 已过去 / 背景化 | `idle` | 焦点之外的对象降到这里 |
| **焦点** | `accent` / `accentSoft` | 同一时刻只有一处 |
| 对 / 命中 | `good` / `goodSoft` | 只用来表示正确 |
| 错 / 冲突 | `bad` / `badSoft` | 只用来表示错误、冲突、等待 |

同屏彩色（accent、good、bad）最多三种，通常一种就够。焦点之外的对象透明度降到 0.35，或者改成 `idle` 色。

每个对象都处在下面五种状态之一，状态之间的变化只做颜色插值：

| 状态 | 填充 | 描边 | 文字 |
|---|---|---|---|
| `todo` 未到 | 透明 | `rule` 3px | `idle` |
| `active` 当前 | `accentSoft` | `accent` 4px | `ink` |
| `done` 已完成 | `paper2` | `inkSoft` 3px | `inkSoft` |
| `bad` 冲突 | `badSoft` | `bad` 4px 虚线 | `bad` |
| `good` 命中 | `goodSoft` | `good` 4px | `good` |

```ts
// src/shared/theme.ts
export const color = {
  paper: '#fbf9f4', paper2: '#f4efe6', ink: '#16120f', inkSoft: '#4a423a',
  rule: '#d8d0c2', idle: '#b9b0a3',
  accent: '#9c3524', accentSoft: '#f5eae4',
  good: '#2c6a4d', goodSoft: '#e6f0e9', bad: '#a3341f', badSoft: '#f8e6e0',
  clear: 'rgba(251,249,244,0)', // 透明但能和别的颜色插值
}

export const font = {
  title: '"方正标雅宋简体","FZYaSongS-R","Songti SC",serif', // 幕标题、提问、结论
  label: '"PingFang SC","Hiragino Sans GB",sans-serif',      // 对象内文字、标注、字幕
  mono: '"SF Mono",Menlo,monospace',                         // 数字、位串、代码、进度
}

export const size = { title: 56, statement: 64, body: 36, note: 32, caption: 40, meta: 26, minBody: 28 }

export const layout = {
  width: 1920, height: 1080, safeX: 120, safeY: 90,
  headerH: 80, stageTop: 200, stageH: 660, captionTop: 900, captionH: 90,
  radius: 6, gap: 8,
}

export type State = 'todo' | 'active' | 'done' | 'bad' | 'good'
export const stateStyle: Record<State, { fill: string; stroke: string; text: string; width: number; dashed: boolean }> = {
  todo: { fill: color.clear, stroke: color.rule, text: color.idle, width: 3, dashed: false },
  active: { fill: color.accentSoft, stroke: color.accent, text: color.ink, width: 4, dashed: false },
  done: { fill: color.paper2, stroke: color.inkSoft, text: color.inkSoft, width: 3, dashed: false },
  bad: { fill: color.badSoft, stroke: color.bad, text: color.bad, width: 4, dashed: true },
  good: { fill: color.goodSoft, stroke: color.good, text: color.good, width: 4, dashed: false },
}
```

## 3. 字与元件

**字**：幕标题 56（雅宋 600），提问与结论 64（雅宋），对象内文字 36，标注 32，字幕 40，进度和刻度 26。**正文类字不小于 28（`size.minBody`），装饰小字（进度、刻度、指针下标）不小于 26（`size.meta`）**。行高 1.3，字距 0。数字一律 mono 加 `fontVariantNumeric: 'tabular-nums'`。

**元件**（尺寸是默认值；对象多到放不下时整体等比缩小，最多缩到 75%，正文类字仍不低于 28、装饰小字不低于 26；还放不下就拆幕）：

| 元件 | 用在哪 | 规格 |
|---|---|---|
| Box 方块 | 阶段、模块、寄存器、层 | 高 96，宽按最长文字加左右 24 内边距（最小 160），同组等宽；圆角 6；文字 36 居中；颜色按状态 |
| Cell 格子 | 数组元素、位、token、矩阵元素 | 72×72（矩阵用 56×56），间距 8；mono 36（矩阵 28）；一行最多 16 格 |
| Card 卡片 | 移动的指令、数据包、请求 | 高 64，圆角 6，填 `paper`，描边 `ink` 3px，mono 30；正在移动时切成 `active` |
| Arrow 箭头 | 数据流、依赖、因果 | 线宽 3 `inkSoft`；实心三角箭头 14×14；优先水平、竖直和正交折线，最多两折，不用曲线；激活时 4px `accent` |
| Pointer 指针 | 扫描位置、当前下标 | 实心三角 ▼ 20 宽，`accent`，位于目标上方 16px；下标写在指针上方，mono 26 |
| Label 标注 | 给对象起名、写数值 | 32 `inkSoft`；离对象 16px，优先放上方，其次右侧；需要引线时用 2px `rule` 直线 |
| Ring 圈注 | 「就是这里」 | 目标外扩 12px，描边 `accent` 4px，圆角 10，不填充 |
| Bubble 警示 | 冲突、停顿、错误原因 | 填 `badSoft`，描边 `bad` 4px 虚线（12 8），文字 `bad` 32，内边距 16 24 |
| Ghost 残影 | 上一状态 | 原对象复制一份，透明度 0.25，描边改虚线，不带文字或文字也是 0.25 |
| Counter 计数器 | 时钟周期、轮次、步数 | 放在舞台右上角，mono 36，「cycle 3」「第 2 轮」，变化时数字滚动 |
| Axis 坐标图 | 函数、曲线、数值变化 | 轴线 2 `inkSoft`；刻度 mono 26，只标关键刻度；网格线 1px `rule`；数据线 4px `accent`；数据点直径 12 |
| Readout 读数区 | 公式、当前数值、对照表 | 舞台右侧 1/3，底 `paper2`，内边距 32；每行一个量，标签 32 + 数值 mono 36 |

新增元件时只能组合上面这些属性（描边宽 3/4、圆角 6、上面这几档字号、状态色），不引入新的形状语言。

## 4. 版式：按知识结构挑一个

| 知识结构 | 版式 | 舞台怎么排 |
|---|---|---|
| 阶段序列、流水线、处理链 | 横向链 | N 个 Box 等宽水平排一行并居中，间距 48–64，用 Arrow 相连；Card 在 Box 下方 120px 的轨道上移动 |
| 时序、时空图、调度 | 网格表 | 行是对象，列是时间；左侧 240 宽的行标签列；列宽 =（1680−240）÷ 列数；列头 mono 26；格子按状态上色，逐列揭示 |
| 数组、位串、token 序列、内存 | 格子行 | Cell 一行居中（多行时行距 24）；Pointer 在上方；下标在格子下方 mono 26 |
| 矩阵运算、注意力 | 方程排 | A · B = C 水平排开，运算符 48 居中；参与当前计算的那一行和那一列切成 `active`，结果格同时亮起 |
| 对比、反例、前后 | 左右分栏 | 两栏各宽 800，中间一条 1px `rule` 竖线；两栏结构完全相同，只有差异处上色；栏标题 36 |
| 层次、树、调用栈 | 自上而下 | 层距 140，同层节点等距；连线用正交折线；调用栈改成竖排的 Box，从下往上压栈 |
| 函数、数值变化、收敛 | 图 + 读数 | Axis 占舞台左 2/3，Readout 占右 1/3；曲线用描线动画画出 |
| 空间、几何、旋转 | 中央视图 | 中心放一个正交视图，带两条坐标轴；不做 3D 透视，除非问题本身就是 3D（此时按工程版本核对 Remotion 官方 3D API） |
| 状态机、协议往返 | 泳道 | 每个参与方一条竖直泳道（竖线 + 顶部 Box），消息用水平 Arrow 从上往下依次出现 |

拿不准选哪个时，选「对象最少、视线移动最短」的那个。

## 5. 动作配方

帧数按 30fps 计；`q / b / s` 分别是 `dur.quick / base / slow`（9 / 16 / 26 帧）。

| 动作 | 做法 | 曲线 | 帧 |
|---|---|---|---|
| 出场 | 透明度 0→1，同时上移 16px 到位 | `enter` | b |
| 依次出场 | 每个错开 `dur.stagger`（4 帧），按阅读顺序 | `enter` | b |
| 退场 | 透明度 →0 | `exit` | q |
| 降为背景 | 透明度 →0.35，或改成 `idle` 色 | `move` | b |
| 状态切换 | 用 `interpolateColors` 插值填充、描边、文字颜色 | `move` | b |
| 移动 | translate；距离不超过 400px 用 b，更远用 s | `move` | b / s |
| 描线（箭头、曲线、路径） | SVG 设 `pathLength={1}` `strokeDasharray={1}`，`strokeDashoffset` 从 1 到 0；箭头三角在线画完时出场 | `linear` | b–s |
| 指针扫描 | 匀速，每格 6–8 帧；停在关键格上 | `linear` | — |
| 数值变化 | 数字插值后 `Math.round`，tabular 数字 | `move` | b |
| 强调 | scale 1→1.06→1，或者 Ring 出场 | `Easing.spring({ damping: 12 })` | 约 18 |
| 镜头推近 / 拉回 | 舞台外层 scale（≤2）+ translate，把目标移到舞台中心；舞台里的对象同时不动 | `move` | s |
| 换字幕 | 旧句退场 q，新句出场 q，新旧之间不留空帧 | `exit` / `enter` | q + q |
| 换幕 | `TransitionSeries` + `fade()` + `linearTiming` | 线性 | 14 |

**停留**：每拍动作结束后，先按「字幕字数 × 5 帧，至少 30 帧」起算，抽帧时觉得读不完就加长。这只是起算值，判据仍然是「任一帧暂停都读得懂」。

**禁用**：从画面外飞入、从 0 弹性放大、旋转出场、闪烁、抖动、连续呼吸、粒子。

## 6. motion.ts

```ts
// src/shared/motion.ts
import { Easing, interpolate } from 'remotion'

export const ease = {
  enter: Easing.bezier(0.16, 1, 0.3, 1),
  exit: Easing.bezier(0.7, 0, 0.84, 0),
  move: Easing.bezier(0.65, 0, 0.35, 1),
  linear: Easing.linear,
  pop: Easing.spring({ damping: 12 }),
}
export const dur = { quick: 9, base: 16, slow: 26, stagger: 4 }

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const

/** 从 start 帧起，用 length 帧把 0→1 走完。 */
export const tween = (frame: number, start: number, length: number = dur.base, easing = ease.move) =>
  interpolate(frame, [start, start + length], [0, 1], { easing, ...clamp })

/** 出场：透明度 + 上移 16px。返回可直接放进 style 的对象。 */
export const enterStyle = (frame: number, start: number, length: number = dur.base) => {
  const p = tween(frame, start, length, ease.enter)
  return { opacity: p, translate: `0px ${(1 - p) * 16}px` }
}

/** 时间线：每拍 { id, enter, hold } 累加出帧号；改一拍的长度，后面的拍自动顺延。 */
export type Beat = { id: string; enter: number; hold: number }
export const timeline = (beats: Beat[]) => {
  const at: Record<string, { start: number; settle: number; end: number }> = {}
  let t = 0
  for (const beat of beats) {
    at[beat.id] = { start: t, settle: t + beat.enter, end: t + beat.enter + beat.hold }
    t += beat.enter + beat.hold
  }
  return { at, total: t }
}
```

## 7. SceneFrame.tsx

每一幕都套这个外壳，标题、进度、字幕的位置就全片一致。工程里已经有等价外壳（例如 `shared/chrome.tsx` 的 `Stage`）就直接复用它，没有才把这份落盘。

```tsx
// src/shared/SceneFrame.tsx
import React from 'react'
import { AbsoluteFill } from 'remotion'
import { color, font, layout, size } from './theme'

export const SceneFrame: React.FC<{
  title?: string
  progress?: string
  caption?: React.ReactNode
  children: React.ReactNode
}> = ({ title, progress, caption, children }) => (
  <AbsoluteFill style={{ background: color.paper, color: color.ink }}>
    {title ? (
      <div
        style={{
          position: 'absolute', left: layout.safeX, right: layout.safeX, top: layout.safeY, height: layout.headerH,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: `2px solid ${color.rule}`,
        }}
      >
        <span style={{ fontFamily: font.title, fontSize: size.title, fontWeight: 600 }}>{title}</span>
        <span style={{ fontFamily: font.mono, fontSize: size.meta, color: color.inkSoft }}>{progress}</span>
      </div>
    ) : null}
    <div style={{ position: 'absolute', left: layout.safeX, right: layout.safeX, top: layout.stageTop, height: layout.stageH }}>
      {children}
    </div>
    {caption ? (
      <div
        style={{
          position: 'absolute', left: layout.safeX, right: layout.safeX, top: layout.captionTop, height: layout.captionH,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: font.label, fontSize: size.caption, color: color.ink,
        }}
      >
        {caption}
      </div>
    ) : null}
  </AbsoluteFill>
)
```

字幕里需要强调的词用 `<span style={{ color: color.accent }}>`，一句话最多强调一处。

## 8. 预检清单（still 抽帧时逐张打勾）

- 焦点只有一处，强调色只出现在它身上。
- 文字都在安全区里：正文类字不低于 28，装饰小字不低于 26。
- 同屏彩色不超过三种；每种颜色都表达第 2 节里写的那个意思。
- 字幕只有一行，读得完，和分镜表那一格一致。
- 同组对象等宽、等距、对齐；箭头不穿过文字。
- 中文不掉字，数字不跳宽。

## 9. 可以调的与不该动的

| 可以按内容调 | 不该动 |
|---|---|
| 强调色（只换 `accent` 和 `accentSoft` 这一对，比如按学科配色） | 颜色的语义（焦点、对错、未到/已过去） |
| 版式选择，主版式加一个读数区 | 一拍一个焦点；布景先于运动 |
| 元件尺寸在 75%–100% 之间整体缩放 | 安全区、正文类最小字号 28（装饰小字 26） |
| 标注字体改成全片雅宋 | 同一种动作全片用同一条曲线 |
| `dur` 档位、停留长度 | 只用 `useCurrentFrame` 驱动，`interpolate` 都夹紧 |
| 不用顶栏（开场、收束、纯图表幕） | 不加装饰性的运动、渐变、投影 |

**总长与幕数不在这张表里**：它们由内容决定（见第 0 节「长度与幕数」）——判据只有「讲完」，软性上限 2 分钟；幕数按「需要几次画面切换」数，不沿用上一部的段数。

**既有件与偏离怎么记**：上面这张表管的是「内容需要时能改什么」，工程既有件与本文档默认值的冲突按 `60-animation` 的优先级裁（硬底线跟规范，默认值跟既有件）。取既有件的每一处都写进 `storyboard.md` 末尾的「偏离」表，三列，缺一列就等于漏记：

| 既有件（文件 / 组件 · 实际取值） | 规范默认（本文档的值） | 为什么不改（改了会影响哪些既有视频或素材） |
|---|---|---|
| `src/videos/shared/chrome.tsx` 的 `Caption`：字幕 34 / 注释 23 | 字幕 40、正文类下限 28 | 这条共享外框被既有成片复用，改字号会一起改旧片；新课沿用同一套外框 |

需要的东西超出这张表（新的视觉语言、3D、实拍素材、新依赖），先问他。
