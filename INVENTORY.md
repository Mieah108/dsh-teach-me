# 文件布局

| 路径 | 内容 | 分发 |
| --- | --- | --- |
| `cordis.patch.yml` | 预设声明、教学 persona 与 host/runtime 行 | 运行包与源码 |
| `lib/`、`client.js`、`locale/` | 插件、浏览器客户端与本地化 | 运行包与源码 |
| `assets/brand/` | 图标母版（透明底、纸底、线稿）与使用规则 | 运行包与源码 |
| `prompt/` | 教学协议与阶段清单 | 运行包与源码 |
| `skills/teach/` | 固定提交的 MIT teach 技能原件 | 运行包与源码 |
| `skills/teach-animation/` | 本项目原创动画接入指南 | 运行包与源码 |
| `skills/UPSTREAM.json` | 技能逐文件来源、大小与哈希 | 运行包与源码 |
| `templates/` | 课程/动画格式、组件、配方、MathJax 与合成示例 | 运行包与源码 |
| `scripts/lesson-*.mjs`、`scripts/teach-workspace.mjs` | 课程校验/编译/patch 与档案维护 CLI | 运行包与源码 |
| `ui/` | 前端组件构建输入和固定上游原件 | 源码 |
| `test/` | 使用合成数据的自动测试与 fixtures | 源码 |
| `experiments/` | 可复用的合成 LessonSpec 样例 | 源码 |
| 其他 `scripts/` | 构建、校验、版本与发行维护工具 | 源码 |
| `.github/workflows/` | 持续集成、npm 发布与 GitHub Release 自动化 | 源码 |
| `docs/` | 公开架构、测试、版本规则和 ADR | 运行包与源码 |
| `licenses/`、`ATTRIBUTIONS.md`、各资产 notices | 原件版权、许可与修改说明 | 运行包与源码 |
| `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | 包定义、依赖锁定与构建脚本授权 | 按发行清单 |

运行包文件白名单以 `package.json` 为准。源码归档的文件清单与 SHA-256 随发行提供。个人 profile、课程、作答、日志、原始会话、临时截图和 `.git` 不属于这两类公开分发内容。

工作区运行数据布局见 [架构](docs/architecture.md)，来源与许可见 [ATTRIBUTIONS](ATTRIBUTIONS.md)。
