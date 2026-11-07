# 合成 LessonSpec 样例

`lessonspec/` 保存源码测试与验证使用的固定样例，不含真实学习档案或模型会话。

| 文件 | 用途 |
| --- | --- |
| `concept.spec.json` | 不含新媒体与块 ID 的旧写法兼容基线 |
| `formula.spec.json` | 公式和表格表达 |
| `interactive.spec.json` | 互动组件结构 |

这些样例随源码发行，运行 npm 包不分发 `experiments/`。修改兼容基线时应同步审查测试断言，避免只更新样例掩盖回归。

课程编译契约见[架构](../docs/architecture.md)，验证入口见[测试说明](../docs/testing.md)。
