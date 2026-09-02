# 已确认的坑点

这里只记录已经从代码、协议或复现中确认的问题，不把猜测写成项目规则。

## `@` 文件和 `$skill` 是结构化输入

- **问题**：不能把 UI 上的替换文本当成最终发给模型的完整内容。
- **原因**：Harness 会把普通文件转换成 App Server 的 `mention`，把 Skill 转换成 `skill` 输入；文件内容由 App Server/Codex 按协议解析。
- **正确做法**：比较 App Server 边界的结构化 `input`，不要在前端自行展开文件或解析 `SKILL.md`。
- **CLI 对照细节**：交互式选择 Skill 时，文本项还要带 `$skill` 对应的 `text_elements` 占位信息，`byteRange` 使用 UTF-8 字节偏移；仅把 `$skill` 文本和独立 `skill` 项发出去仍不完全等价。
- **已知差异**：当前 CLI 0.151.0 的交互式文件选择会把选中的路径作为普通文本发送，Harness 则按项目约定发送结构化 `mention`。不要为了追 CLI 表面行为而在前端展开文件内容或擅自改变 Harness 契约；若要统一，需单独评估 token、能力和兼容性。
- **适用范围**：Composer、输入重放、CLI 对照和 token 上下文排查。

## `turn/steer` 不接受 model/effort 覆盖

- **问题**：在 active turn 上修改模型或推理强度会造成 UI 显示与实际请求不一致。
- **原因**：当前 App Server 的 steer 请求只承载追加输入，模型和 effort 由已有 turn/thread 设置决定。
- **正确做法**：active turn 期间锁定相关控件，等待 turn 结束后再更新设置。
- **适用范围**：Composer 设置、队列转插话、Quick Agent 回传。

## 诊断日志不能保存正文

- **问题**：为了排查 token 或协议问题而直接记录 prompt、response、文件内容或完整 MCP 结果，会违反本地状态和隐私边界。
- **原因**：诊断日志只允许操作元数据；现有 sanitizer 会主动隐藏敏感字段。
- **正确做法**：只记录来源、model、effort、方法、耗时、状态、输入类型数量和数值 usage；高频 delta 不逐条落盘。
- **适用范围**：App Server 诊断、token 埋点和黑箱测试 fixture。

## Usage 的 total 不是单轮消耗

- **问题**：直接把多条 `thread/tokenUsage/updated` 的 `total` 相加，会重复计算会话历史。
- **正确做法**：比较单轮时使用 `last`；`total` 只用于观察会话累计值，并结合 `turnTrigger`、model、effort 归因。
- **适用范围**：Quick Agent、标题生成和普通对话的成本分析。

## App Server daemon 是共享的

- **问题**：仅重启 Harness 或重复打开设置页，不等于重新加载 MCP/Skill 或重建 daemon。
- **原因**：daemon 生命周期独立于 Harness，MCP 是全局配置且按初始化/手动 reload 刷新。
- **正确做法**：明确区分 daemon 连接、配置 reload、Skill force reload 和 Harness UI 状态；A/B 测试记录版本与配置边界。
- **适用范围**：MCP/Skill 排查、版本更新和连接故障。

## 分页恢复必须排除重复的完整历史

- **问题**：`thread/resume` 同时请求 `initialTurnsPage` 却不设置 `excludeTurns: true` 时，响应还可能填充 `thread.turns`，大型会话会重复返回历史并触发 WebSocket 消息上限。
- **正确做法**：分页恢复始终设置 `excludeTurns: true`，从 `initialTurnsPage` 读取首屏，再通过 `thread/turns/list` 加载更早内容。保留有界的 WebSocket 消息上限，不用超大上限掩盖未分页的响应。
- **适用范围**：会话选择、断线恢复、Quick Agent 状态检查和结果读取。

## 隔离 worktree 不能强制删除

- **问题**：隔离交付目录可能包含用户需要检查的提交或未提交改动。
- **原因**：Agent Run 的交付物生命周期独立于当前会话。
- **正确做法**：保留目录和分支；有未提交改动时清理必须失败，不使用 `--force`。
- **适用范围**：Quick Agent、worktree 清理和发布交付。
