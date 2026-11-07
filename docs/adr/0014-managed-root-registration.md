# ADR-0014：受管注册使用标记块与插件命名空间

日期：2026-10-26。状态：已接受。


## 决定

首次 register 在 `Root.tsx` 插入 `teach-managed` 导入/JSX 标记块，并建立 `src/videos/_teach-managed/`。定位不到根组件、根节点不是 fragment 或标记损坏时明确失败，不解析改写任意 JSX。

sync 按课程清单重建 registry。课程入口 `index.tsx` 导出 `Lesson`（或 default）和 `DURATION_IN_FRAMES`，可选 `FPS`、`WIDTH`、`HEIGHT`。缺少约定时回执说明未注册原因；render 使用返回的 composition ID。

文件归属由 `.dsh-teach/managed/lessons/<category>/<slug>.json` 清单与哈希判断。同名非受管文件内容不同时拒绝；显式 adopt 才接管。保存非受管文件，不无条件替换整个目录。

## 原子性与回滚

Root.tsx 修改前备份，只改标记块；文件使用同目录临时替换，课程目录先完成校验和暂存再 rename 发布。失败时恢复旧目录，不留下半套。dry_run 不创建文件；修订冲突、链接或大小/扩展名违规拒绝整批。

受管 registry 是派生产物，不适合手工修改。目录替换要求同一文件系统；完整进程隔离仍不属于本机制的保证。
