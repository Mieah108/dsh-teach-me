# 上游提示词与适配说明

本目录的适配配方用于当前教学模式：三份用于改编的内容原件逐字保存在 `upstream/`，提交与 SHA-256 见 [UPSTREAM.json](UPSTREAM.json)；上游许可证全文也随同一目录保存。

- DeepTutor（HKUDS），Apache License 2.0：内容组织配方改编自 `page_planner.yaml`，移除固定章节篇幅/块数和 Manim 绑定，保留按教学目标选择表达与自然衔接的规则。完整许可见 [LICENSE-DeepTutor.txt](upstream/LICENSE-DeepTutor.txt)。
- OpenMAIC，Copyright (c) 2026 THU-MAIC，MIT：图形与实验配方改编自 `diagram-content/system.md`、`simulation-content/system.md`，包含 SVG 节点/箭头局部范例及状态/重置规则。适配为当前样式、独立 HTML、学习者自主操作与手动答疑状态；不要求平台持续控制。完整许可见 [LICENSE-OpenMAIC.txt](upstream/LICENSE-OpenMAIC.txt)。

原件中的平台消息、占位片段、默认配色、自动课堂行为和外部依赖不构成本插件的运行承诺；生成时使用适配版。原件供来源核验和维护，不要求每课读取。
