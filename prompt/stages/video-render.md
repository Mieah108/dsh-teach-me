# 渲染

- 预览不是交付环节：插件不常驻起预览服务。学习者要看预览，就让他在工程目录自己跑 `npm run dev`（`remotion studio`），地址是 `http://localhost:3000`，端口被占 Remotion 会自己换一个；不要为预览申请权限或硬起进程。
- `teach_animation_render`（`mode: still`）抽帧预检：首帧、每拍停留中段、每个转场中点、末帧；对着分镜表和 ANIMATION.md 第 8 节清单逐张打勾，过了就交。
- still 的产物按帧命名（`out/<类别>/<slug>-f<帧号>.png`），连抽多帧不会互相覆盖；封面帧用 `mode: still` + `poster: true` 出末帧（`<slug>-poster.png`），返回里带帧号，不用手工复制或另存。
- 预检通过才渲成片（`mode: render`），成片只渲一次；用 `job_output` 读渲染进度，不要用 bash 跑 remotion。
- 同一工程一次只跑一个渲染作业：被 `render-busy` 挡下时，先看那个 job（`job_output`），必要时 `job_kill` 它，不要杀端口上的进程。
- 成片出来核验 2–3 帧，不逐帧；封面帧已经抽过，不用再为 poster 重抽。
- **量一次时长**：够不够讲完？超过 {{teach_animation_soft_limit}} 秒就在 `storyboard.md` 补一句理由。没讲完才值得补拍重渲，其余情况不重渲。
- 嵌进课程对应小节：figure + video + 「看什么」（取分镜里最关键那一拍）+ 源码位置。
