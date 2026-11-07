# 教学设置弹出菜单修订验证

日期：2026-11-05。此修订落实用户对会话入口的后续要求，替代内联折叠区，保留已有设置生效与会话隔离语义。版本仍为 0.8.5-beta.1，已有 tag 不移动。

- 新会话通过官方 `conversation.hero.options` 与预设选择器同排；已有会话通过 `conversation.session.header.actions` 保留入口。没有替换官方预设选择器。
- 按钮、图标、弹层、集合选项、集合操作及设置页选项使用公开 primitives。定位、动画、Escape、焦点返回和外点关闭交由 Menu。宿主未公开 Slider，离散滑块沿用原生 range 与主题令牌。
- 嵌套 portal 选项通过事件边界保留父菜单；外点仍可关闭全部层。没有额外实现弹层定位或复制运行时控件。

## 验证结果

- `node scripts/verify.mjs --source`：690 项测试、125 项自检、版本、技能、公开文件及组件检查通过。
- `node scripts/qa-learning-flow.mjs`：真实宿主 Menu/React/CSS/图标，嵌套集合选择、滑块 Home、Escape 焦点返回、Space 重开、子菜单打开时外点关闭、输入区不位移、会话隔离、集合复制/选择、阅读保存失败重试、原课堂提交与续读、reduced-motion 均通过，0 pageerror。
- 三面代表性状态矩阵 52 张（dock/courses/settings × 明暗 × 1440/390）；最终事件调整后另重跑 dock 12 张，均无浏览器错误。最终客户端 SHA-256：`97f5f61c0801a506b1641b73aff3ca36c9193784ae7ec5e5914bd92a082bc510`。
- 独立 DSH 0.2.2-rc.1 Web profile 加载本地最终插件，无兼容覆盖。实际教学预设与教学设置按钮顶部同为 y=457px、高度同为 28px；弹层 y=489px、宽 340px，输入区保持位置，0 pageerror。未发送模型请求。

真实宿主验证同时发现 `dsh-tool-subagent-control/list-agents` 已不再公开。Loader 行改为按公开导出是否存在启用：旧宿主保留独立行，新宿主使用根插件内的 list_agents。最终宿主直接启动无预设加载错误。旧版本的完整浏览器集成本轮未重跑。

QA 从宿主当前 index.html 选择配对的 JS/CSS，仅在测试服务中截断应用引导并加载其公开模块种子；生产客户端仍只依赖公开模块名。宿主引导结构变化会明确失败，不替代为假菜单。产物位于 `artifacts/host-ui/teaching-popup{,-final}/` 与 `learning-flow/`，不进入运行包。未修改真实用户 profile、课程、凭据，未推送或发布。
