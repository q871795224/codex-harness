# 测试与验证

## 常规命令

- 前端单元测试：`pnpm test`
- 前端构建：`pnpm build`
- Rust 单元测试：`(cd src-tauri && cargo test)`
- 稳定版开发构建：`pnpm tauri dev`
- 绿色开发版：`pnpm tauri:dev`

改动纯前端领域逻辑时至少运行相关 Vitest；改动 UI、bridge 或 IPC 流程时至少运行 `pnpm build`，并补对应测试。Rust 测试必须使用临时目录或注入依赖，不得读写真实 `~/.codex`、`~/.codex-harness`。

## 发布门禁

完整发布顺序和发布授权边界在 `.agents/skills/harness-release/SKILL.md`。普通开发任务不执行 release commit、tag、稳定版安装、上传或 GitHub Release。

## Codex 输入黑箱对照

Harness 与 CLI 的核对要区分两个层次：

1. **客户端协议层**：比较两者发给同一个 App Server 的 `thread/start`、`turn/start` JSON。重点检查 `input` 数组中的 `text`、`mention`、`skill`、`localImage`，以及 cwd、workspace roots、model、effort、权限和来源字段。
2. **模型上下文层**：比较 App Server 解析 AGENTS、Skill、MCP、文件 mention 和历史后形成的最终上下文。普通 App Server 日志通常不会暴露完整 prompt，因此不能仅凭客户端 JSON 宣称最终上下文完全一致。

推荐使用隔离临时 workspace、相同 Codex CLI/App Server 版本、相同配置和相同输入。先做不触发模型生成的请求捕获或协议回放；若必须发送真实 turn，要使用最小、无副作用的 prompt，并记录其 token usage。

对 `@` 文件和 `$skill` 至少覆盖：空格/中文路径、多文件、重复选择、删除 Skill 标记、相对路径、无 workspace，以及 CLI 支持而 Harness 可能未实现的行号或范围语法。对照结果应保存为结构化 fixture，不保存真实 prompt、回复或凭据。

本次对照已确认一个 CLI 细节：交互式选中 `$demo-skill` 后，CLI 的 `turn/start.input` 会同时包含文本项
`$demo-skill ...`、文本项里的 `text_elements` 占位信息，以及独立的 `{ type: "skill", name, path }` 项；其中
`text_elements[].byteRange` 是 UTF-8 字节范围，不是 JavaScript 字符下标。位置参数里直接写 `@README.md`
则仍然只是普通文本，不能代替在交互 Composer 中实际选中文件建议项。对当前 CLI 0.151.0 的交互式文件选择也捕获到：选中后 `turn/start.input` 是不带 `@` 的路径文本，未带结构化 `mention`；这与 Harness 按项目契约发送结构化 `mention` 不同，属于需要产品决策的协议差异，不能直接当成实现错误改掉。

## Token 埋点

当前不引入 Grafana 或新的指标数据库。Rust 原生层会把诊断日志写入
`~/.codex-harness/logs/harness.jsonl`，并轮转保留一个旧文件；日志只保留
turn 来源、model、effort、耗时、状态和数值 usage，不写 prompt、回复、文件内容或完整 MCP 结果。

快速查看最近的 Codex usage：

```bash
rg '"area":"codex-usage"' ~/.codex-harness/logs/harness.jsonl | tail -20
```

`usage.updated` 中的 `last` 是最近一次 usage，`total` 是会话累计值；做成本比较时按
`last` 聚合，不能把多次累计值相加。`request.started` / `request.completed` 中的
`turnTrigger`、model 和 effort 用来区分标题生成、Quick Agent、失败继续和回传；缺少
`turnTrigger` 的普通 turn 归为 `conversation`。`turn/start` 的 `request.completed` 会记录
`resultMeta.turnId`，可和 `usage.updated.fields.turnId` 关联，避免只按时间猜测
某个 turn 的来源。

长期分析数据由 `src-tauri/src/codex_analytics.rs` 写入 `state.sqlite`，与轮转诊断日志分开。测试至少覆盖：同一 turn 的多次 `last` 正确累加、`total` 不参与累加、测试数据库不出现输入正文、MCP completed item 按 call ID 幂等、查询在缺少插件归因时安全降级。所有测试必须使用临时目录。

默认计数器不调用模型或网络，使用 `tiktoken-rs` 的 `o200k_base` 在后台线程本地分词；超过 1 MiB 的单项内容才回退 `unicode-heuristic-v1`。可选官方模式调用 `/responses/input_tokens`，必须使用有界队列、单并发和短超时，缺少密钥、限流或网络失败时保留本地结果。官方 usage 与细分计数只并列分析，不能相加后冒充实际 Token。
