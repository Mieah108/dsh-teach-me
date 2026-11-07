# Remotion 复用配方

这是现有 [ANIMATION](../ANIMATION.md) 的按需使用指引，不是新动画库。借鉴 OpenMAIC 的数据、图形布局与分步揭示；DeepTutor 的按内容选媒介只用于决定是否值得提案。两边的 CSS/motion/Manim 实现不直接作为 Remotion 成片源码。

本插件的接入、技能闸门和交付顺序见随包 `teach-animation` 指南；具体 Remotion API 按工程实际版本查官方文档。

## 最短复用路径

1. 先取得这次动画制作的同意；未获准只写课程与动画提案。
2. `teach_animation_inspect` 后只读工程中的 `theme.ts`、`motion.ts`、`videos/shared/` 和一份最接近的既有动画。记下实际导出名及 import 路径；等价物已存在就复用，不创建第二套 token 或注册机制。
3. 把变化写成数据：对象与数值来自材料，拍名、进入和停留沿用现有 `timeline()`，复用最接近的幕/版式。源码留在当前课 staging，由 `teach_animation_sync` 镜像到受管区。
4. 需要图形时先复用工程图元；上游 SVG 的几何关系可适配，但所有动态属性改由帧数决定，移除定时器和浏览器 CSS 动画。

## 数据替换范例

假设工程已经采用 ANIMATION 中的 `timeline()`、`SceneFrame` 与共享图元，下一课主要替换这类数据：

```ts
const beats = timeline([
  { id: 'setup', enter: 16, hold: 45 },
  { id: 'change', enter: 16, hold: 60 },
  { id: 'compare', enter: 16, hold: 60 },
]);
const cases = [
  { id: 'before', label: '原情境', value: 4 },
  { id: 'after', label: '换参数', value: 8 },
];
```

这里的帧数只是说明数据契约，不是固定幕长。实际停留按字幕和可读性判断；分镜仍明确每拍的焦点。

同一个计算结果可以喂给 HTML 表格和动画读数，避免两份公式各算一遍。使用 `useCurrentFrame()` 读取当前帧，再用现有 `tween()`/`interpolate()` 得到当前状态，交给工程已经导出的图元和 `SceneFrame`；不要把浏览器的“下一步按钮”搬进渲染进程。

## 本次复用应留下什么

在每课源码旁的 `storyboard.md` 用一小段写清复用的工程组件、数据来源，以及上游局部范例（若有）。一次对齐字体、色与布局即可；不为每片另写视觉系统。现有 `Root.tsx`、共享组件和别人的 Composition 不修改，注册/渲染继续走受管工具。

先检查关键帧，再渲染一次成片。未实际渲染或未看过的帧如实标记，不把浏览器交互动画的观感当作视频已经通过验证。
