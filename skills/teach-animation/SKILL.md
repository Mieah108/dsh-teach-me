---
name: teach-animation
description: Build and deliver a teaching animation through this preset's managed Remotion workflow after the learner agrees to an animation.
---

# 教学动画接入

这是 dsh-teach-me 的原创接入指南，覆盖本插件的工程约定与交付工具，不是 Remotion 官方技能。Remotion 运行时由学习者在自己的工程中安装并按其许可使用；本包不分发该运行时或上游技能示例树。

## 确定工程与讲解目标

先读取 `teach_status` 与 `teach_animation_inspect`。动画工程未配置或隔离能力不满足时，按诊断回执处理；不能用其他命令绕过工具返回的权限或互斥失败。学习者同意动画后，围绕一处需要时间变化才能解释的机制写分镜，明确每拍要观察的对象、数值和结论。

读取包内 `templates/ANIMATION.md` 的视觉与帧检查规则；复用已配置工程的组件和主题。具体 API 按工程 lockfile 中的 Remotion 版本核对[官方文档](https://www.remotion.dev/docs/)。素材使用已获授权的本地资源；字体采用已合法安装的字体和系统回退。

## 写入与接入

源码放在教学工作区的 `.dsh-teach-me/animation-src/<slug>/`，由 `teach_animation_sync` 镜像到工程。入口 `index.tsx` 导出 `Lesson` 和正整数 `DURATION_IN_FRAMES`，可选 `FPS`、`WIDTH`、`HEIGHT`；元数据应与分镜一致。画面由当前帧与数据决定，同一帧可以重复生成；异步资源加载应使用该 Remotion 版本支持的就绪机制。

首次接入先展示 `teach_animation_inspect` 的受管区域差异，学习者确认后调用 `teach_animation_register({ confirm: true })`。之后按 `category` 和 `slug` 先运行 `teach_animation_sync({ dry_run: true, ... })` 核对文件，再正式同步。工具返回的 Composition id、镜像清单和差异是后续操作依据；保留工程受管区域以外的源码。

## 静帧、渲染与交付

用 `teach_animation_render` 的 `mode: still` 检查分镜中的关键帧，确认文字、公式、因果方向与数字读数。封面使用 `poster: true`，以回执给出的帧号和路径为准。需要修正时修改工作区源码并重新同步。

静帧通过后用同一工具的 `mode: render` 生成视频。它负责工程互斥、后台作业与档案关联；用宿主 `job_output` 查看已返回的作业，用 `job_kill` 取消。报告真实终态，失败或未完成时保留作业标识与下一步，不将“已启动”写成“已交付”。

最终课程引用回执中的视频和海报，说明要观察的变化以及源码位置。归档与现有课程版本绑定；工程配置变更后重新检查，不沿用过期的就绪结论。
