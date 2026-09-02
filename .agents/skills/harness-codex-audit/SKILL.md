---
name: harness-codex-audit
description: Use when comparing Codex CLI and Codex Harness App Server requests or investigating unexpected Codex token usage in this repository.
---

# Codex Harness 成本审计

## 范围

只审计 Codex。SeaTalk、Claude 和 MCP 转 Skill 只有在用户明确纳入时才进入本 Skill。

## 请求对照

1. 固定 Codex CLI/App Server 版本、配置、workspace 和模型设置。
2. 在 App Server 边界分别捕获 CLI 与 Harness 的 `thread/start`、`turn/start` JSON；优先使用 mock 或 WebSocket proxy，不要让对照测试触发真实模型。
3. 先比较 `input` 的结构化类型和元数据：`text`、`mention`、`skill`、`localImage`，再比较 cwd、workspace roots、model、effort、权限和来源字段。
4. CLI 的启动请求可能包含 TUI 专用 dynamic tools，不能把客户端 bootstrap 差异直接算成模型上下文差异。
5. 位置参数中的 `@file` 只是文本；要验证文件 mention，必须在交互 Composer 中实际选择文件建议项。最终模型上下文还需要 App Server 内部 trace 或受控测试模型，不能只看客户端请求断言完全一致。
6. 当前 CLI 0.151.0 的 TUI 交互式文件选择实测也发送不带 `@` 的路径文本而不是 `mention`；Harness 按项目契约发送结构化 `mention`，报告时要把它标为已确认差异，不要未经评估直接改动。

## 成本观察

- 查看 `~/.codex-harness/logs/harness.jsonl` 中 `area=codex-usage` 的记录。
- 用 `usage.last` 估算单轮，用 `usage.total` 观察会话累计；不要把多条累计值相加。
- 按 `turnTrigger`（缺少时归为 `conversation`）、model、effort、itemTypes、bodyChars、mentionCount、skillCount、imageCount 和 audioCount 分组。
- 日志只能保存低基数元数据和数值 usage，不能保存 prompt、回复、文件内容、Skill 正文、凭据或完整 MCP 结果。

## 交付要求

报告应区分“已在 App Server 边界证实”“只在前端代码证实”和“仍需模型上下文 trace”三类结论；不要把近似比较写成最终 prompt 相等。
