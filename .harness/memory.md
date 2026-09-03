# 记忆

## 当前范围

- 当前 token 成本排查只覆盖 Codex；Claude 会话暂不纳入。
- Quick Agent 的 `effort: max` 是有意配置，暂不调整 effort 或并发策略，先通过埋点观察实际消耗。
- SeaTalk 已被禁用，草稿生成暂不作为当前优化对象。
- MCP 转 Skill 暂不在本次实现范围，由另一个 Codex 负责。
- Codex 分析数据永久保留，不做 TTL；采集不得发起额外模型推理请求，也不得阻塞 App Server 主流程。默认使用本地 tokenizer；只有用户在插件设置中明确选择时才可异步调用官方 Input Token Count API，并必须自动回退本地。

## 已确认的协作约定

- Handover 交接文档：注入新会话草稿的只有正文（标题/工作区状态/主 Agent 总结）；doc id、血缘、时间戳等簿记元数据由 Harness 生成文档文件头（`renderHandoverFrontMatter`），不进模板、不进草稿。模板 v2 起只含正文占位符；本机已物化的 v1 模板已随改动重写为 v2。state.sqlite 侧元数据（`handed_over_to` 等）仍未实现。
- Claude 会话默认 `bypassPermissions`（Dangerous）；用户可在输入框权限下拉切回 Ask，显式选择按会话持久化、不受默认值影响。

## 待完善的插件功能

1. SeaTalk 草稿

该功能是内置 SeaTalk 插件的功能，入口在 SeaTalk 页面里的“用当前会话生成草稿”按钮：`src/plugins/seatalk/index.tsx`。当前已禁用。

但它有一个容易误解的地方：它不是在当前 Codex 会话里继续生成，而是：

创建一个独立的 Agent Run；
把当前意图和最近最多 8 条消息拼进 prompt；
让 Codex 生成 SeaTalk 可发送正文；
用户编辑后，再手动预览、确认、发送。
生成草稿本身会额外消耗一次 Codex turn。SeaTalk 插件平时的本地 bridge 健康检查和消息轮询不消耗模型 token。如果不用 SeaTalk，建议直接禁用该插件。

2. 子任务结果传回在哪里点击？
在右下角“快捷 Agent”面板中，展开对应的任务记录。只有任务配置为“完成后可回传当前会话”，且子任务已经完成时，才会出现“回传结果到当前会话”的按钮：QuickActionPanel.tsx。

当前内置的“提交、推送并创建 MR”默认配置是 detached，也就是“独立查看”，所以默认不会出现这个按钮：quick-agent/config.ts。

点击回传后，父会话会再次启动一个 Codex turn 来处理子任务结果，因此这不是免费的 UI 操作。父会话有 active turn 时，回传会被拒绝，不会自动形成循环。
