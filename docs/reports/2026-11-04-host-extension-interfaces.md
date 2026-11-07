# 教学扩展的宿主接口核实

日期：2026-11-04（Asia/Shanghai）。方式：只读检查本机已安装 DSH `0.2.1-rc.5` 的声明与运行产物，没有修改宿主或配置，没有执行浏览器集成测试。

本机宿主根为 `$NODE_PREFIX/lib/node_modules/@deepseek-ai/dsh`。以下路径以该根下的 `node_modules/@deepseek-ai/` 为基准。版本来自宿主根 `package.json`。

## 输入区域与预设识别

`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:300-331` 正式声明：

| 插槽 | 位置 | 类型与作用域 |
| --- | --- | --- |
| conversation.input.dock | 输入卡上方全宽区域 | list / session |
| conversation.input.overlay | 输入卡内部浮层 | list / session |
| conversation.composer.dock | 输入卡下方 | list / session |
| conversation.input.left / right | 工具行左侧 / 发送动作之前 | list / session |
| conversation.input.activity | 模型选择之后，可扩展工具行 | single / session |

实际 `dsh-client-ui-conversation/lib/client.js:17907` 在输入卡之前渲染 input.dock。声明文件 `469-473` 的 InputZone 提供 SessionSnapshot 与 InputState。建议使用 input.dock 注册折叠面板；紧凑入口可评估 left/right，避免默认占用 single 类型的 activity，也无需接管整个 composer chain。

`dsh-client-ui-agent-preset/lib/client.js:1001-1005` 的官方预设控件从 `useSessions(state => state.byId[sessionId]?.projectionValues?.agentPreset)` 读取预设。插件应匹配自身声明的预设 ID `teach`（`preset-teach` 是 Loader 行 ID，不是会话投影值；2026-11-05 实施时核对 `config.id` 与宿主 register(config) 后修正），不根据显示名判断；尚未读到身份时不显示教学专属控件。

## 会话持久化与动态提示词

没有找到通用的任意 session metadata setter。`dsh-session/lib/types/types.d.ts:57-96` 的 SessionHeader 是创建时的只读元数据；`dsh-api-session-controller/lib/types/client/contract/session.d.ts` 的 ISession 提供行为与投影读面，不适合作为任意教学配置容器。

可复用 `dsh-storage-domain/lib/types/index.d.ts:52-90` 的 `ctx.storage.domain.open(spec)`；`lib/types/domain.d.ts:36-77` 提供表的 get/put/delete/update。可由插件 host 半通过受控 RPC 读写按会话隔离的偏好。需要确认宿主后端与设施实际装配，不能仅凭类型声明声称已可用。它保存在宿主安装侧，与复制教学根会带走的课程状态不同；归属语义待用户确认。

`dsh-session/lib/types/index.d.ts:93-117` 的 appendPluginRecord 是 experimental 机制，有迁移丢失及 production caller 限制，不作为第三方插件稳定偏好存储的首选。

`dsh-system-prompt/lib/types/index.d.ts:46-83,286-304` 支持每次 assembly 求值的 section/context/variable provider；`dsh-agent-loop/lib/index.js:907` 实际调用 assemble。本插件 `lib/prompt.js:113-145` 已有动态变量模式，可以扩展为读取会话覆盖。尚需新增存储、接口和偏好注入，当前并未实现。

assembly 之后的 request admission refreshContext 只重算 context，不能据此承诺滑块修改会改变已经发起的请求。规划建议每次教学请求固定偏好快照，下一次请求使用新值。

## 控件、素材与动效

`dsh-web-frontend/dist/assets/index-BXV-oxvX.js:188,190` 的前端模块种子公开导出 `@deepseek-ai/dsh-client-ui-primitives`，包含 DisclosureRow、Button、Input、Checkbox、Switch、SegmentedControl、Menu、Tooltip、滑块图标和展开箭头图标；官方客户端如 `dsh-client-ui-plan/lib/client.js:7` 也通过该模块使用控件。

DisclosureRow 实现见 bundle `129` 行，具有 open/onToggle/children、aria-expanded 和 Enter/Space 处理，但只做条件挂载，不保证展开高度动效。本机没有该 primitives 模块的独立类型声明；上述接口以实际 bundle 为证，实施时需要运行导出与渲染探针。

导出表未发现 Slider、Collapse、Collapsible 或 Accordion。离散滑块可用原生 range 配合宿主主题令牌；折叠区复用 DisclosureRow，并在插件范围实现必要过渡。不要复制压缩实现，也不要深路径导入未公开的聊天 flow-motion。

当前插件已具备宿主主题、120ms 过渡与 reduced-motion 处理；课程图表的滑块经验可以借鉴交互，但不直接挪用课程纸面样式。教学视频素材不属于本轮界面动效扩展。

## 实施前仍需验证

- 真正加载插件后的插槽 props、预设切换显示、窄屏与输入框高度。
- storage.domain 后端可用性、受控 RPC 身份与会话隔离、宿主重启后的读取。
- primitives 实际导出、键盘操作与展开动效；设置变化对下一次请求的实际作用。
- 当前插件声明支持 `>=0.2.1-rc.3`；本次只确认 rc.5，不能将结果当作 rc.3 兼容证明。
