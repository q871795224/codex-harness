# 已确认的坑点

这里只记录已经从代码、协议或复现中确认的问题，不把猜测写成项目规则。

## Enter 提交必须避开输入法合成

- **问题**：项目创建框仅判断 Enter，中文输入法确认候选词时会误创建项目。
- **正确做法**：提交前同时检查 composition 生命周期、原生 `isComposing` 和 WebKit 的 `keyCode === 229`；异步创建还需防止重复提交。回归测试覆盖候选词确认和正常 Enter 提交。
- **适用范围**：创建、重命名和其他 Enter 提交输入框。

## 全角标点会被 GFM autolink 吞进 URL

- **问题**：LLM 输出 `**https://…**（说明` 或 `https://…（说明）` 时，闭合 `**` 因后接全角括号不满足 CommonMark 定界符规则而失效，remark-gfm 的 autolink-literal 会把 `**（…` 一并吞进链接 URL。已与 GitHub 官方渲染（api.github.com/markdown）对照确认行为一致，不是 Harness 的实现错误。
- **正确做法**：消息和文档渲染统一走 `src/features/markdown/Markdown.tsx`；其 `remarkRepairCjkAutolink` 插件在 remark-gfm 之后把全角标点起的内容拆回普通文本、修剪 URL 尾部残留的 `* _ ~` 标记，并恢复前后配对的 strong/emphasis/delete 包裹。尖括号 autolink（`<…>`）和显式链接（`[文字](url)`）不修复，含中文路径的合法 URL 不动。新增 markdown 渲染入口必须复用 `Markdown` 组件，不要绕过。
- **适用范围**：会话消息、项目文档等所有 `Markdown` 组件覆盖的渲染路径。

## 引用展示与 App Server 输入分开处理

- 普通文件选择后发送路径文本，不发送结构化 `mention`；文件正文由 agent 自行读取，前端不展开文件内容。
- 交互式选择 Skill 发送 `$skill` 文本、对应的 `text_elements` 和独立 `skill` 项；图片发送 `localImage` 及 `[Image #N]` 文本标记。`text_elements.byteRange` 使用 UTF-8 字节偏移，不是 JavaScript 字符下标。
- 选择器引用的绿色标签依赖本地 UI 区间，不能通过扫描所有路径或 `$name` 重建，否则会把手打内容误认为选择器引用。消息 UI 区间使用 UTF-16，不能直接复用协议字节范围。
- 比较客户端 JSON 只能确认 App Server 边界，不能据此断言最终模型上下文相同。
- **适用范围**：Composer、历史消息、输入重放和 CLI 对照。

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

## 首轮前切换 cwd 不会迁移 thread 的持久 cwd

- **问题**：创建空白 Codex 会话后再切换工作区，首轮 `turn/start` 虽然使用新 cwd，但后续恢复会话时可能回到创建时的 cwd。
- **原因**：`thread/start` 会写入持久的 thread cwd；`thread/settings/update` 和单次 `turn/start.cwd` 不会迁移这份创建元数据。
- **正确做法**：如果空白会话在首轮发送前切换了 cwd，用最终 cwd 重建 thread，保留用户选择的模型、推理强度、审批和 sandbox 设置，再删除旧的空 thread。
- **恢复注意**：`thread/resume` 的顶层 `cwd` 是当前运行目录，`thread.cwd` 可能仍是创建目录。恢复详情、会话列表和工作区映射时优先采用顶层 `cwd`；否则切走再切回空白会话会覆盖用户选择，并让首轮重建判断失效。回归测试需覆盖切换工作区后离开会话、返回并首次发送的完整流程。
- **适用范围**：新会话创建、工作区选择器、首轮发送和会话恢复。

## Claude Provider daemon 不随文件更新自动重启

- **问题**：`~/.codex-harness/claude-provider/daemon.mjs` 被新版覆盖后，正在运行的 daemon 进程仍执行旧代码，新方法（如 `provider/models`）会报"未知 Claude Provider 方法"。
- **原因**：`launchctl kickstart`（不带 `-k`）对已在运行的服务是 no-op，不会重启进程。
- **正确做法**：`install_runtime_file` 返回内容是否变更，`ensure_launch_agent` 在文件变更时用 `kickstart -k` 强制重启 daemon；手动修复可执行 `launchctl kickstart -k gui/$(id -u)/com.local.codex-harness.claude-provider`。
- **适用范围**：Claude Provider 方法新增、daemon 升级和"未知方法"报错排查。

## macOS 发布必须用稳定签名身份

- **问题**：ad-hoc 签名（`signingIdentity: "-"`）的应用每次重新构建 cdhash 都会变化，macOS TCC 把每个新构建当成新应用，屏幕录制等权限授权不跨版本保留，用户每次安装新版都会重新看到权限弹窗。
- **正确做法**：`tauri.conf.json` 的 `signingIdentity` 固定为钥匙串里的自签证书 "Codex Harness Local Code Signing"（2036 年到期），签名身份稳定后 TCC 授权可跨版本继承；不要改回 `-`。
- **适用范围**：发布打包、安装流程和权限弹窗排查。

## 发布进程查找必须包含祖先进程

- **问题**：从正在运行的 Harness 启动发布任务时，安装阶段可能找不到旧 Harness 进程，导致 `open` 只激活旧实例，随后启动检查超时。
- **原因**：macOS `pgrep` 默认排除调用者的祖先进程，而发布 runner 是 Harness 的后代进程。
- **正确做法**：发布脚本使用 `pgrep -a -f` 查找 Harness 可执行文件，停止检查和启动检查必须复用同一查找方式。
- **适用范围**：稳定版安装、Harness 内启动的发布任务和启动验证。
