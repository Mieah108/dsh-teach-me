<p align="center"><img src="assets/brand/icon-plate.svg" width="88" height="88" alt="教学模式图标：老师拿教鞭指着黑板"></p>

# dsh-teach-me · 教学模式

为 DeepSeek Harness 提供持续学习的 Agent 预设，集成教学技能、交互课程、练习评估和学习档案。你可以从一个学习目标开始，生成可离线阅读的 HTML 课程，在课堂中作答、复习，并在后续会话中继续学习。

需要动态演示时，也可以连接自己的 Remotion 工程制作教学动画。

## 功能

- **循序教学**：根据学习目标与已有知识诊断起点，制定小课计划，结合讲解、练习和反馈推进学习。
- **交互课程**：支持公式、闪卡、时间线、图表和本地媒体，提供侧栏选课与课堂阅读。
- **练习与评估**：支持客观题判分、开放题模型初评、正式作答提交和复习记录。
- **教学集合**：同一工作区分多轮学习与分类；复制课程清单、归档和恢复，作答与评估各自独立，内容版本固定。
- **阅读进度**：主课程页显示已浏览进度、保存最近续读位置，选课页汇总课程与集合百分比。阅读不等于掌握。
- **教学设置**：“教学设置”按钮与对话输入框上方的“教学模式”预设选择器同排，点击弹出菜单；当前会话可调整核查等级和讲解深度，下一次请求生效。设置页可设新会话默认值。
- **弹性核查**：不核查 0、宽松 1、适中 1–2、严格 3–4 个独立核查者；默认仅课程生成启用，按需交叉复查且最多自动一轮，结果与证据可展开。
- **学习档案**：在学习工作区保存课程、题目、作答和评估，便于跨会话继续学习。
- **离线使用**：课程可导出为单文件阅读，支持答案导出与导入；公式和组件资源随包提供。
- **教学动画**：可选连接 Remotion 工程，同步课程动画源码并渲染静帧或视频。

当前源码版本以 [package.json](package.json) 为准。下方 npm 安装命令使用已发行版本。

## 环境要求

- DeepSeek Harness `>=0.2.1-rc.3`。
- npm 安装使用宿主的 `dsh plugin` 命令，需要 pnpm 位于系统 PATH 中。
- 动画功能需要单独准备 Remotion 工程及其依赖；默认关闭。
- 从源码开发需要 Node.js 和 pnpm，pnpm 版本见 [package.json](package.json)。

## 安装

### 从 npm 安装

当前测试版为 `0.9.0-beta.1`。使用 npm 的 `next` 标签安装最新测试版：

```bash
dsh plugin --profile web add dsh-teach-me@next
```

需要固定版本时，使用 `dsh-teach-me@0.9.0-beta.1`。安装后重启 DeepSeek Harness、刷新 Web 客户端，在新会话中选择「教学模式」。

### 从目录安装

可从 [GitHub Releases](https://github.com/Mieah108/dsh-teach-me/releases) 下载源码归档，或克隆仓库后在项目目录安装依赖：

```bash
git clone https://github.com/Mieah108/dsh-teach-me.git
cd dsh-teach-me
pnpm install --frozen-lockfile
```

在 DeepSeek Harness 中通过 `plugin_manager` 安装已准备的目录：

```text
action: install_bundle
target: /path/to/dsh-teach-me
```

将 `target` 替换为项目目录的实际绝对路径。

如果使用 `link:` 安装，请保留该目录的位置；移动或删除目录后需要重新安装。

### 升级

升级前备份学习工作区和教学模式设置。首次明确写入会把现有课程与记录归入默认集合，并备份迁移前档案；降级必须恢复完整迁移前备份，不能仅删除索引。教学集合与阅读记录随教学根移动，会话偏好保存在宿主数据域。普通浏览器直开或离线 HTML 暂不回传阅读位置。安装所需的 npm 版本并重启宿主。使用目录安装时，通过 `plugin_manager` 移除旧包后安装新目录：

```text
action: remove_bundle
target: dsh-teach-me
```

此前安装过本地包 `@local/dsh-teach-me` 时，请先移除该旧包，再安装 `dsh-teach-me`，避免重复注册。保留已有学习工作区和档案。

自 `0.9.0-beta.1` 起，「教学模式」采用与宿主标准模式相同的原生工具调用。建议等当前调用结束再升级，重启后优先从原会话继续。仍可作答的问题用原卡片回复，卡片无法恢复时可让导师重新提问。若旧会话无法续接，在原学习工作区新开一个「教学模式」会话即可继续使用已有课程和档案。

## 快速开始

1. 打开一个学习工作区，在新会话中选择「教学模式」。
2. 告诉导师你的学习目标、当前基础和希望使用的材料，例如：「我想理解傅里叶变换，学过微积分，请从直观例子开始。」
3. 回答诊断问题并确认课程计划，导师会生成课程与练习。
4. 从侧栏「教学模式 · 选课」打开课程，阅读、操作组件并作答。
5. 点击「提交到课堂」保存正式作答，再根据反馈补充学习或安排复习。

页面中的本地自测与正式提交分开。学习记录保存在所选工作区，后续可以从已有课程和记录继续。

## 配置

在「设置 → 教学模式」中调整动画选项，修改后重启相应插件或 DeepSeek Harness。

| 配置项 | 说明 | 默认值 |
| --- | --- | --- |
| `animation.root` | Remotion 工程的绝对路径，留空关闭动画 | 空 |
| `animation.softLimitSeconds` | 动画长度参考值，范围 10–600 秒 | 120 |
| `animation.missing` | 缺少工程时跳过（`skip`）或提示（`warn`） | `skip` |
| `animation.staging` | 使用工作区中间目录保存动画源码 | 开启 |

更多配置见 [架构与配置](docs/architecture.md)，动画接入见 [动画指南](templates/ANIMATION.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](docs/README.md) | 架构、测试与维护说明 |
| [课程格式](templates/FORMATS.md) | HTML 课程、LessonSpec 和学习记录格式 |
| [交互组件](templates/COMPONENTS.md) | 闪卡、时间线、图表与使用示例 |
| [动画指南](templates/ANIMATION.md) | Remotion 工程接入与动画制作 |
| [术语表](GLOSSARY.md) | 项目概念与工具术语 |
| [更新日志](CHANGELOG.md) | 各版本变更 |
| [版本与发布](docs/versioning.md) | GitHub Release、npm 发布与本地演练 |

下载或克隆源码后，可以用浏览器打开 [组件示例](templates/examples/lessons/components.html) 和 [复用示例](templates/examples/lessons/reuse.html)。

### 命令行工具

项目提供课程编译、检查、增量修改和学习工作区维护工具：

```bash
node scripts/lesson-compile.mjs --check lesson.spec.json
node scripts/lesson-compile.mjs lesson.spec.json lesson.html
node scripts/lesson-lint.mjs --help
node scripts/lesson-patch.mjs --help
node scripts/teach-workspace.mjs --help
```

## 开发

在源码目录安装依赖并运行校验：

```bash
pnpm install --frozen-lockfile
pnpm verify:source
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `pnpm test` | 运行单元测试 |
| `pnpm selftest` | 运行插件自测 |
| `pnpm build:components` | 构建课程组件 |
| `pnpm check:components` | 检查组件来源与构建产物 |

更多说明见 [测试文档](docs/testing.md)。

## 使用说明与限制

- 侧栏课堂与自动打开课程的能力取决于 DeepSeek Harness 部署和客户端支持。
- 开放题模型初评可能出错，重要结论应结合原始作答与评估依据复核。
- 动画渲染依赖本地 Remotion、浏览器和字体环境，平台支持与权限限制见 [架构文档](docs/architecture.md#动画与权限)。
- 学习档案保存在工作区中，请定期备份课程与学习记录。

## 贡献

欢迎通过 [Issues](https://github.com/Mieah108/dsh-teach-me/issues) 反馈问题或提出建议，也欢迎提交 Pull Request。

报告问题时，请提供项目版本、DeepSeek Harness 版本、操作系统、复现步骤与预期行为。提交代码前请运行 `pnpm verify:source`；新增或更新第三方资源时，请同步补充来源与许可说明。

## 许可证与致谢

项目原创内容采用 [BSD-3-Clause](LICENSE) 许可证。第三方代码、技能和资源遵循各自许可证，详细来源与许可见 [ATTRIBUTIONS.md](ATTRIBUTIONS.md)。

感谢以下上游项目。分发范围、固定版本和许可证见 [ATTRIBUTIONS.md](ATTRIBUTIONS.md)。

- 宿主与教学技能：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[Matt Pocock 的 teach 技能](https://github.com/mattpocock/skills/tree/ad5400b930b297b0c0cb231ff1ffe42a7da666aa/skills/productivity/teach)。
- 课程组件与配方：[DeepTutor](https://github.com/HKUDS/DeepTutor)、[OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)。
- 前端与公式：[React、ReactDOM 和 scheduler](https://github.com/facebook/react)、[Apache ECharts](https://github.com/apache/echarts)、[zrender](https://github.com/ecomfe/zrender)、[D3.js](https://github.com/d3/d3)、[tslib](https://github.com/microsoft/tslib)、[MathJax](https://github.com/mathjax/MathJax)。
- 动画、运行与开发依赖：[Remotion](https://github.com/remotion-dev/remotion)、[DeepSeek Schemastery](https://github.com/deepseek-ai/deepseek-harness/tree/main/vendor/schemastery)、[Zod](https://github.com/colinhacks/zod)、[esbuild](https://github.com/evanw/esbuild)、[linkedom](https://github.com/WebReflection/linkedom)。
