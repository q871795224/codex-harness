# 长期协作记忆

这里只保留跨任务有效的决定。单次排查范围、某台机器的插件启停状态和“由另一个 Agent 处理”等临时安排留在任务记录，不作为后续任务的限制。

- Quick Agent 默认的 `effort: max` 是有意配置；不因成本排查顺带降低强度或改变并发策略。配置来源见 [quick-agent/config.ts](../src/plugins/quick-agent/config.ts)，回传和团队协作规则见 [agent-interaction.md](agent-interaction.md)。
- Codex 分析数据永久保留，不做 TTL；采集不得发起额外模型推理请求或阻塞 App Server 主流程。默认本地分词，可选官方 Input Token Count API 必须自动回退本地。实现与验证口径统一见 [architecture.md](architecture.md#codex-运行时) 和 [test.md](test.md#token-埋点)。
- Handover 注入新会话草稿的只有正文（标题、工作区状态、主 Agent 总结）；文档 ID、血缘、时间戳由 Harness 生成文件头，不进模板或草稿。模板 v2 起只含正文占位符，见 [document.ts](../src/features/handover/document.ts) 与 [templates.ts](../src/features/handover/templates.ts)。
- Claude 会话默认 `bypassPermissions`（Dangerous）；用户可在输入框权限下拉切回 Ask，显式选择按会话持久化，不受默认值影响。

SeaTalk 草稿插件、核心会话续聊和中间提问通知各自独立；启停状态从当前实例读取。各通道边界见 [architecture.md](architecture.md#seatalk-会话续聊)，不把某次禁用草稿插件写成 SeaTalk 全局停用。
