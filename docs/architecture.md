# 架构与配置

一个发行包包含预设声明、插件、浏览器客户端、技能、课程资产与品牌图标（`assets/brand/`）。教学运行期只作用于选择「教学模式」的会话；设置和课堂支持由 profile 的 host 行提供。

## 入口与配置

`cordis.patch.yml` 是 Loader bundle patch。`lib/index.js` 根据 `entryRole` 分派：`host` 提供设置和课堂服务，`runtime` 注册教学工具、技能与提示词。精确包根缺少角色时按 runtime 兼容，`/settings` 子路径缺少角色时按 host 兼容；未知角色明确报错。客户端发现使用精确包根。

教学预设仍以 `teach` 标识。工具逐项向模型呈现，采用宿主 `standard` 的原生调用方式。教学人格、候答行为和工具范围由教学预设独立配置。

`client.js` 注册设置页、选课列表与课堂页签，使用宿主 `configForms` 和连接服务。没有有效 `teach-settings` 行时不显示空设置页。设置合并顺序为设置页值、预设行值、内置默认；空字符串工程路径表示主动关闭动画。另有首次安装的欢迎页：客户端把它注册到宿主 root 级 `shell.overlay`，用宿主 `Modal` 呈现，只在设置行可写且 `welcome.seen` 不为 `true` 时出现一次；关掉即把 `welcome.seen` 写回设置行，此后任何浏览器都不再弹（判定与取舍见 [ADR-0021](adr/0021-first-run-welcome.md)）。

| 配置组 | 重要选项 |
| --- | --- |
| `ask` | `gateWhileWaiting` 默认开；pending 问题不自动授权后续写入 |
| `skills` | `enabled`、可选自定义 `dir`、模型/用户调用开关；默认注册 teach 与 teach-animation |
| `prompt` | `enabled`、可选 `dir`；`stageLayering` 默认关闭 |
| `tools` | 流程、lint、report、archive、commit、animation 的开关 |
| `stages` | 默认 `allowSkip:true`、`start:intake`；关闭跳过时强制相邻推进 |
| `ledger` | `enabled`，单文件编辑/整课步数参考线，非学习质量评分 |
| `animation` | 工程根、长度参考线、缺失处理、staging、技能闸门和单帧等待上限 |
| `workspace` | 可选固定教学根；也可用 `teach_workspace bind` 绑定 |
| `welcome` | `seen`：首次安装的欢迎页是否已看过；关一次写 `true`，此后不再出现，设置页的「重新显示欢迎页」写回 `false` |

默认值以 `lib/config.js` 为准，页面字段定义在 `lib/config-schema.js`。修改设置后重启插件行或宿主（`welcome.seen` 例外：它是 volatile，写入即时生效）；已创建的会话不会通过重写历史配置自动更换预设。

## 档案与事务

教学根包含课程、学习记录和资料；插件状态集中于 `.dsh-teach-me/`：

```text
<teaching-root>/
├── lessons/
├── reference/
├── assets/
├── learning-records/
└── .dsh-teach-me/
    ├── archive/
    │   ├── workspace.json
    │   ├── journal/
    │   ├── index.json
    │   ├── snapshot.json
    │   ├── locks/
    │   └── backups/
    └── animation-src/
```

`teaching-root.json` 放在有绑定关系的会话根隐藏目录中。旧 `.teach` 布局在允许修复的打开路径上迁移；只读查询不迁移、不修索引、不初始化日志。

journal 是追加式权威日志；课程、题目、提交、评估、复习与目标等状态从它重放。写入使用跨进程锁与版本检查；索引和快照是可重建派生数据。快照不截断 journal，校验失败退回完整重放，不能当作备份或防恶意篡改签名。

`teach_commit` 将预检、发布和题目登记放入幂等流程。演练不产生正式提交；实际写入前重新核对文件/资产哈希、课程与题目版本。相同键、相同内容返回既有结果；同键异内容拒绝。旧的 publish/register 分离入口保持兼容。

## 课堂与评估

课程资源只从已发布清单中提供，校验路径、文件身份、大小与指纹。嵌入页使用不透明 origin 的 sandbox 和受控桥；回传由 host 路由处理，不能仅凭前端自报 sessionId 授权。能力票有时限，并与工作区、会话、课程版本关联；宿主身份与请求围栏仍参与校验。

课程页里的链接会被浏览器直接请求：目录式地址（`…/reference/`）按目录下的 `index.html` 解释，只带票据的地址就是课程页本身，同一清单里的其它已发布页面在文档导航下按普通页面打开（同样 sandbox + CSP，只注入 `<base>`、不注入课堂桥；非文档请求仍按纯文本下发）。导航失败回一页可读的说明与「回到课程页」，不把接口的 JSON 信封摊在课程页上。

正式提交与本地自测分开。客观题确定性判分，开放题可由模型提供标准逐条判断与证据，最终结论由 host 推导；题目/材料/课程变化、缺标准或模型失败保留待复核。作废评估不删除历史。

离线导出把允许资源内联为独立页面；答案可由学习者显式导出/导入。普通点击、翻页、提示揭晓和答疑快照不会自动写为掌握证据。

## 动画与权限

未配置工程时不注册动画工具，也不注入动画协议。配置后使用项目原创 teach-animation 接入指南；Remotion 运行时与工程依赖由使用者独立安装。

源码在工作区 staging，sync 经词法、realpath、链接、扩展名、大小与归属检查后原子发布。首次 register 展示 diff，确认后只维护 Root.tsx 的受管标记块与 `_teach-managed` 命名空间。render 使用后台作业及跨进程互斥，绑定启动时课程 revision，恢复时保留可观测的作业状态。

插件文件围栏限制插件自身操作，不能单独证明 Chromium、字体、缓存和后代进程也受同等限制。平台强隔离与真实工程链路属于需要单独验收的边界，见 [测试说明](testing.md) 和 [ADR-0011](adr/0011-rendering-obeys-the-declared-permission-boundary.md)。

## 提示词与来源

persona 保留教学立场；`prompt/*.md` 描述流程，`prompt/stages/` 提供阶段清单。配置级动画条件化默认有效；实验性阶段族分层必须显式开启，未知阶段或自定义目录回退全量协议。字节数、实际 token、缓存与费用分别度量，不互相替代。

teach 使用固定上游提交和完整文件清单校验；teach-animation 是本项目原创内容。第三方组件、配方、离线 MathJax 具有独立来源与许可清单。来源更新需要同时核对原件、许可、哈希与构建结果。

## 教学集合、内容版本与阅读

默认集合保留原有档案身份；其他集合以 `collection.transaction` 包装独立的领域事件，继续使用同一条权威日志、同一事务锁和全局 CAS。集合管理事件不混入学习证据。复制集合只复制固定内容版本、题目、材料与已有核查出处，不复制阅读、作答、评估或复习历史。归档集合仍可读、续读及完成既有任务，新生成需要恢复。

显式首次写入迁移前备份整个档案；读取不会迁移或重建索引。`lesson.versioned` 保存正文/题目/依据的内容指纹、版本题面和材料，页面与完整资源清单保存在 `archive/versions/<内容指纹>/<资源指纹>/`，相对引用保持原样。纯样式与脚本资源修订不改变内容指纹；正文错字、题面、来源或教学图片变化会改变内容版本。采用新版由用户显式选择，旧版本资源和证据保留。旧提交仍按其固定版本评估，当前新版不继承旧版通过。

阅读数据保存在 `archive/reading/`，按工作区身份、集合、课程、内容版本取键；使用既有跨进程锁和原子写入，独立于正式学习日志。最远位置取最大值，续读位置按主动交互时间归并，并拒绝重复窗口序号。页面恢复和后台窗口不抢续读位置。前端实时预览、约三秒节流保存，失败保留内存进度并提供重试。集合按主课程等权平均，无记录贡献零并明确数量，空集合不显示完成。

课堂能力票新增集合与内容版本；所有资源、进度、提交、导出、导入都从签名票取归属。切换当前集合不会重定向已打开课堂，重新加载也沿用原集合与版本。参考页仍不注入课堂或阅读桥，离线阅读同步不在本版范围。

## 会话教学偏好与核查

宿主正式 `storage.domain` 数据域 `teach_session_preferences` 保存各会话的默认快照、覆盖值和按教学根区分的集合选择；关闭/重开可恢复，不写入只读 SessionHeader，不依赖 experimental plugin records。默认核查和深度均适中，设置页修改只供新会话采用。`agent/inbox/claimed` 固定本轮集合、教学根和偏好，工具执行通过独立上下文绑定，已发起请求不受滑块修改影响。诊断工具在偏好后端不可用时仍能说明缺口。

`conversation.hero.options` 在新会话的预设行挂载“教学设置”按钮；已有会话使用 `conversation.session.header.actions`（仅非空会话显示），不覆盖宿主预设选择器、不占用输入区 dock。识别会话投影 `agentPreset = teach`（Loader 行 ID 才是 `preset-teach`）。按钮、图标、弹层、集合与设置页选项均使用公开 `dsh-client-ui-primitives`；Menu 负责定位、动画、外点关闭、Escape 与焦点返回，子菜单打开时保留父弹层。宿主没有公开 Slider，使用离散 range 并阻止菜单抢占其方向键。阅读条沿用宿主令牌，支持键盘、触屏和 reduced-motion。

`teach_fact_check_plan` 按固定档位给出官方 `subagent` 调用计划，以只读固定课程文件与必要材料建立盲审，避免重复传输整份 HTML。实际启动通过宿主工具结果关联；预算闸门防止同一计划重复派遣。`teach_fact_check_record` 保存真实来源、发现、修正、完成与失败情况；未观测到启动、人数不足或仍有争议时标为未完成。复查按需，多核查者交叉、单核查者才自查，同次生成只接受一次最终记录。普通答疑不自动派核查代理。
