# Codex 原生项目工具

Harness 为新建的 Codex 持久会话注册客户端执行的动态工具。Agent 调用“当前项目”工具时，Harness 使用 App Server 回调的 `threadId` 查询自己的项目绑定；工具参数不接受项目或会话 ID。项目正文通过工具结果进入上下文，绑定后的首条消息仅附一条读取提示，不拼接项目全文、身份标记或项目维护 Skill。

## 调用与写入

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `harness_project_read` | `{}` | 返回当前项目全文、序号和条目；未绑定时返回 `bound:false` |
| `harness_project_propose` | section、content | 追加 Log / Decisions / Open Questions；Status 进入人工审批 |
| `harness_project_mutate_entry` | action、条目属性、reason | 使用已有条目修订号和冲突校验执行更新、替代、关闭、撤销、软删除、恢复或纳管 |

工具说明要求任务开始及项目更新前读取当前文档。工具注册本身不会强制模型读取；调用策略由模型执行。项目背景不扩大当前任务授权，整文精简仍由用户在界面发起。

`app_server.rs` 是唯一传输入口，`project_tools.rs` 执行业务映射并复用项目文档存储与审批队列。读写使用回调 envelope 的 `threadId`、`turnId`、`callId`，忽略界面当前选中的会话；参数中的身份覆盖与未知字段会被拒绝。工具在后台执行，不阻塞传输读取。

成功的写入按调用 ID 返回同一回执；不同参数复用同一调用 ID 会失败。写入前先保存意图，完成后保存结果元数据。进程在两步之间中断时返回结果未知，要求读取文档核对，不自动重放。回执不保存文档正文。

## 恢复与兼容

App Server 持久化动态工具，并在进程重启后的 resume 和 Fork 中恢复。Harness 保存注册标记，通过会话元数据 `harnessProjectTools` 控制项目读取提示、兼容背景卡和 Skill 加载。绑定后的消息被接受后，项目归属沿用 pending → locked 生命周期。

Codex 0.167.0 的本机生成协议只有 `thread/start` 接受 `dynamicTools`，没有给现有会话补挂工具的入口。旧 Codex 会话继续使用原生项目 Skill、背景卡和身份标记；Claude 沿用现有链路。ephemeral 后台线程不注册这些工具。`harness-runtime` 管理 Skill 保留。

## 验证

2026-11-09 使用 Codex CLI / App Server 0.167.0 完成隔离黑箱验证：两个持久会话调用同名工具，宿主按回调会话返回各自文档；进程重启后恢复与 Fork 都能继续调用工具，返回文档进入下一次模型请求。共 4 次工具回调、8 次本地模型桩请求。机器结果见 [validation.json](review/native-project-tools/validation.json)。

复现：

```sh
node .agents/skills/harness-codex-audit/scripts/verify-dynamic-project-tools.mjs
```

测试使用临时 HOME、CODEX_HOME、工作区和 loopback 模型桩，不连接日常 daemon 或修改真实项目。它验证真实 App Server 协议及恢复行为，未启动 Harness UI，也不验证真实模型的自主工具选择。Rust `project_tools` 测试另外覆盖实际项目存储、跨项目隔离、身份覆盖拒绝、审批、修订冲突、实例归属和写入回执；前端测试覆盖原生工具会话保留原始用户输入和绑定锁定意图。

官方扩展协议见 [OpenAI App Server 动态工具文档](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental)。该扩展需要 `experimentalApi`，应按实际 Codex 版本生成 schema 并复验。

真实模型 smoke 另用 `gpt-6.1-sol` 和 ephemeral 会话验证：显式要求模型调用读工具，工具参数为 `{}`；宿主收到携带 threadId / turnId / callId 的回调，返回临时随机文档，模型随后逐字返回该文档。该测试复用现有 Provider 登录，没有创建持久会话或访问真实项目文档。结果见 [live-smoke.json](review/native-project-tools/live-smoke.json)。这验证模型调用与结果使用，不保证任意用户问题都会触发读取。

显式复现真实模型 smoke（会产生模型用量）：

```sh
node .agents/skills/harness-codex-audit/scripts/verify-dynamic-project-tools-live.mjs --live
```
