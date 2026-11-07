# 架构决策记录

这些记录说明重要设计决策及其取舍；当前行为以代码、[架构](../architecture.md)和相应 ADR 的修订为准。

| 编号 | 决定 | 状态 |
| --- | --- | --- |
| 0001 | [一个包提供预设、插件与客户端](0001-preset-owned-plugin.md) | 已接受；0.3.0 修订 host/runtime 入口 |
| 0002 | [教学协议由插件注入并按能力条件化](0002-protocol-lives-in-plugin.md) | 已修订；配置级条件化与可选阶段分层 |
| 0003 | [问题挂起与候答闸门](0003-questions-outlive-the-program.md) | 已修订；0.3.0 起使用宿主官方提问 |
| 0004 | [技能分发与完整性校验](0004-skills-shipped-as-snapshot.md) | 已修订；0.7.3 固定 teach 来源并提供原创动画指南 |
| 0005 | [工作量以可观察的步骤度量](0005-steps-are-the-unit-of-cost.md) | 已接受；历史个人样本不属于公开基准 |
| 0006 | [动画长度按讲解完整性决定](0006-animation-length-by-completeness.md) | 已接受 |
| 0007 | [个人配置由 profile 设置行持有](0007-settings-row-owns-user-config.md) | 已修订；0.3.0 起使用精确包根的 host 行 |
| 0008 | [插件文件操作使用工程围栏](0008-plugin-builds-its-own-write-fence.md) | 已接受；后续增加链接与原子写检查 |
| 0009 | [动画源码属于工作区并单向同步](0009-animation-source-in-workspace-mirrored-by-plugin.md) | 已修订；0.3.0 起加入受管注册 |
| 0010 | [设置与课堂由客户端模块呈现](0010-settings-page-ships-a-client-half.md) | 已修订；0.3.0 起加入课堂页签 |
| 0011 | [渲染进程权限需独立验收](0011-rendering-obeys-the-declared-permission-boundary.md) | 目标已接受；完整权限边界未验证 |
| 0012 | [HTML 是主要课堂](0012-html-remains-the-primary-learning-surface.md) | 已接受；课堂交互已实现，真实整链需另验 |
| 0013 | [共享动画工程使用明确受管区域](0013-shared-animation-project-has-a-managed-area.md) | 已接受并实现受管接入契约 |
| 0014 | [受管注册使用标记块与插件命名空间](0014-managed-root-registration.md) | 已接受 |
| 0015 | [课程入口与自动打开的边界](0015-sidebar-lesson-opening.md) | 已接受 |
| 0016 | [工作区状态集中于一个隐藏目录](0016-single-hidden-directory.md) | 已接受；0.5.1 明确只读零写 |
| 0017 | [复用组件并由学习者主动操作](0017-reusable-components-learner-operated-classroom.md) | 已接受 |
| 0018 | [档案快照是可丢弃派生缓存](0018-archive-snapshots-are-derived-caches.md) | 已接受；不承诺性能指标 |
| 0019 | [教学集合拥有独立学习历史](0019-collections-own-learning-history.md) | 已接受；0.8.5-beta.1 实施 |
| 0020 | [会话教学偏好跟随会话保存](0020-session-preferences-belong-to-the-session.md) | 已接受；0.8.5-beta.1 实施 |
| 0021 | [首次安装的欢迎页只出现一次](0021-first-run-welcome.md) | 已接受；随下一个测试版发布 |
