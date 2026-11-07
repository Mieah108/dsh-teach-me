# 第三方内容与许可

项目原创代码、文档和 teach-animation 指南采用 [BSD-3-Clause](LICENSE)。第三方内容保留各自许可，不能因为本项目的根许可而重新授权。下表区分源码原件、改编产物与运行时外部依赖。

## DSH 预设配置

`cordis.patch.yml` 的插件行和部分 plan-mode 文本改编自 `@deepseek-ai/dsh-web-app@0.2.1-rc.3` 的 `presets/ptc.patch.yml`，来源仓库为 `deepseek-ai/deepseek-harness`，包内对应 `packages/bundle/web-app/presets/ptc.patch.yml`。

原件采用 **MIT，Copyright (c) 2026 DeepSeek**，许可副本见 [licenses/MIT-DSH.txt](licenses/MIT-DSH.txt)。本项目增加教学 persona、host/runtime 行与教学工具配置，调整能力开关、提问模式和提示词配置；不表示原作者认可这些修改。发行时同时保留此来源与许可。

## 技能

| 内容 | 来源与版本 | 分发与修改 | 许可 |
| --- | --- | --- | --- |
| `skills/teach/` 六个文件 | [mattpocock/skills 固定提交](https://github.com/mattpocock/skills/tree/ad5400b930b297b0c0cb231ff1ffe42a7da666aa/skills/productivity/teach) | 原件未改；完整文件清单、字节数与哈希见 `skills/UPSTREAM.json`；已按上游 Git blob/tree 核对 | MIT，Copyright (c) 2026 Matt Pocock；[原文副本](licenses/MIT-teach.txt) |
| `skills/teach-animation/` | 本项目原创 | 描述本项目受管动画接入，不是 Remotion 官方技能 | BSD-3-Clause |

teach 上游的 `disable-model-invocation:true` 保留在原件；插件在教学预设作用域允许模型调用，属于注册行为差异。相关决定见 [ADR-0004](docs/adr/0004-skills-shipped-as-snapshot.md)。

Remotion 运行时由使用者在独立工程中安装，动画工具调用该工程中的 Remotion。运行时许可由 [Remotion 官方条款](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)决定，不能由本项目 BSD 许可替代。API 参考见官方文档。

## DeepTutor / OpenMAIC 组件与配方

| 来源 | 固定版本 | 原件与改编 |
| --- | --- | --- |
| HKUDS/DeepTutor | `a31d82624c27d75f4e771d4fcb78dce16470b383`，Apache-2.0，Copyright 2025 Data Intelligence Lab, The University of Hong Kong | 闪卡、时间线与 page_planner；改编为本地组件与课程组织配方，替换平台 i18n/图标/样式，保留学习者主动揭晓 |
| THU-MAIC/OpenMAIC | `75b3d8b61fdfa7491ae5f5b6095d6919145b6418`，MIT，Copyright (c) 2026 THU-MAIC | 图表选项、独立构建方法、diagram/simulation 配方；适配主题、局部状态、重置与手动答疑 |

源码发行包的 `ui/upstream/SOURCES.json` 保存原件文件路径、固定提交与 SHA-256；运行包的 [组件来源清单](templates/components/UPSTREAM.json)保留对应关系。配方来源、修改和原件见 [recipes/NOTICE](templates/recipes/NOTICE.md) 与 `templates/recipes/UPSTREAM.json`。

随包许可：[DeepTutor](templates/recipes/upstream/LICENSE-DeepTutor.txt)、[OpenMAIC](templates/recipes/upstream/LICENSE-OpenMAIC.txt)，组件中的适配代码同时保留在 [THIRD_PARTY_NOTICES](templates/components/THIRD_PARTY_NOTICES.txt)。源码原件中的许可另在各自 upstream 目录保留。

## 前端构建产物

| 库 | 版本 | 许可 | 产物 |
| --- | --- | --- | --- |
| React / ReactDOM / scheduler | 19.3.1 / 19.3.1 / 0.28.0 | MIT，Meta Platforms, Inc. and affiliates | `teach-components.js` |
| ECharts / zrender | 6.1.0 / 6.1.0 | Apache-2.0 | `teach-charts.js` |
| tslib | 2.3.0 | 0BSD，Microsoft Corporation | 前端 bundle 内部 |

完整版权、许可和适用 NOTICE 由源码构建脚本从依赖原件生成，随包位于 [templates/components/THIRD_PARTY_NOTICES.txt](templates/components/THIRD_PARTY_NOTICES.txt)，不要手工修改该生成文件。生成器与构建输入位于源码发行包中。

## MathJax 离线公式资源

`templates/mathjax/tex-svg.js` 与官方 npm **mathjax@3.2.2** 的 `package/es5/tex-svg.js` 字节一致，采用 Apache-2.0。版本、官方 tarball、SRI 与文件 SHA-256 见 [UPSTREAM.json](templates/mathjax/UPSTREAM.json)。该文件自带 MathJax 字形，区别于系统商业字体。

版权与来源见 [NOTICE](templates/mathjax/NOTICE.txt)，许可原件见 [MathJax LICENSE](templates/mathjax/LICENSE)。SHA-256：`d4295dc33744836935c1399feece5159577b34c5c8ffb9f1c6324cd82e03a882`。

## 独立依赖与字体

`@deepseek-ai/schemastery` 是 MIT 运行依赖，由包管理器或宿主解析，不打入本项目 JS；保留其安装包原有许可。esbuild、linkedom 是源码开发依赖。React/ECharts 虽作为开发依赖安装，代码进入分发产物，已在上表记录。

本包不分发 `.ttf`、`.otf` 或 `.woff` 商业字体。样式可以优先使用已安装且适用的字体，没有时走系统回退；引用字体名称不授予字体文件再分发权。

更新第三方内容时，同时核对固定来源、完整文件清单、许可原文、修改说明与构建产物。来源更正可通过[项目 Issues](https://github.com/Mieah108/dsh-teach-me/issues)提出。
