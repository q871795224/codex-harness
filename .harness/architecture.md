# 项目架构

## 分层

- `src/` 是 Vite + React + TypeScript 前端。`src/core/domain/` 放共享类型和领域逻辑，`src/features/` 按界面功能组织代码。
- `src-tauri/src/` 是 Rust 原生层，负责 Tauri 命令、本地 SQLite、固定域名网络客户端、系统能力和 Codex App Server 连接。
- 前端原生调用统一经过 `src/core/runtime/bridge.ts`；Rust 命令在 `src-tauri/src/lib.rs` 注册。
- `src-tauri/src/app_server.rs` 独占 App Server WebSocket/Unix socket 协议。新增协议方法应先在这里封装，再从 bridge 提供类型化入口。

## 插件

- `src/core/plugins/` 提供插件生命周期、实例存储、React host 和 slot 解析；`src/plugins/` 放随 App 发布的内置插件。
- 插件实例属于 `global`、`workspace` 或 `thread`。切换页面只改变 contribution 可见性，不能中断后台任务或连接。
- 插件通过 `src/extensions/types.ts` 的 context、service、event 和 slot 契约接入能力；插件不得直接连接 App Server、读取 Harness 数据库或执行任意 shell。
- Codex 原生设置、Skills、MCP、附件和会话状态由 Harness 核心管理；插件只消费明确暴露的 service。
- 新会话空白区的增强 UI 使用 `newThreadPanels` slot；宿主把类型化的会话设置更新函数传给插件，插件不能自行连接 App Server。
- 输入框的符号触发补全（如 `$` Skill、`@` 文件之外的 `#`）使用 `composerCompletions` slot：插件声明单字符触发符并按 query 返回补全项，核心 Composer 负责面板、键盘导航和正文/折叠粘贴插入；插件不得自行渲染输入框弹窗。
- 内置用量插件只通过 `harness.usage` 读取 Rust 原生层缓存或触发固定刷新；它不能读取凭据或直接执行命令。Codex Business/Personal 历史数据由 Rust 通过 `ccusage` 采集，Codex 额度协议在 `app_server.rs` 封装，AIS 只访问固定 Compass 域名。
- 内置 Codex 分析插件只通过 `harness.codexAnalytics` 查询本机采集结果；采集点固定在 `app_server.rs`，持久化和聚合固定在 `codex_analytics.rs`，插件本身不能读取 SQLite。
- Codex Radar 请求由 Rust 固定域名客户端完成并缓存，内置会话启动器只能通过 `harness.codexRadar` 读取整理后的指标。

## Codex 运行时

- Harness 启动时复用或启动共享 `codex app-server daemon`，初始化一次连接并转发事件。关闭 Harness 不停止 daemon。
- 普通对话经 `useHarness` 调用 `thread/start`、`turn/start`、`turn/steer` 等方法；Quick Agent 经 `harness.agentRuns` 创建独立 child thread。
- App Server 当前协议的 `UserInput` 支持 `text`、`localImage`、`skill` 和 `mention`；`turn/start` 还支持可选的 `turnTrigger` 来源标识。协议字段必须以当前 CLI 生成的 schema 和实际运行版本为准。
- Composer 通过 `+`、`@` 或剪贴板添加 PNG、JPEG、GIF、WebP 图片，发送前统一构造成 `localImage`。剪贴板图片由 Rust 原生层读取并转换成系统临时目录下的 PNG，前端草稿只保留路径，不保存 base64；临时文件不在发送后立即删除，以免破坏排队和重试。
- Composer 选中 `$skill` 后，文本项保留可见 marker，并带 CLI 兼容的 `text_elements`；独立的 `skill` 项仍由 App Server 解析。普通文件只发结构化 `mention`，不要在前端展开文件内容。当前 CLI 0.151.0 的文件选择发送路径文本，和 Harness 的结构化 mention 是已知协议差异。
- `thread/tokenUsage/updated` 提供 Codex 会话的累计和最近一次 usage，前端已用于会话统计。累计值不能直接当成单 turn 值相加。
- Rust 原生层在 `~/.codex-harness/logs/harness.jsonl` 留存低基数的 App Server 请求和 usage 诊断；`turnTrigger` 用于区分普通对话、标题生成、Quick Agent 等来源，日志不保存正文。
- Codex 分析使用有界非阻塞队列和独立 SQLite 写线程。初始化、队列或写入失败一律 fail-open，不得阻塞 App Server 或阻止 Harness 启动；页面显示丢弃/写入错误计数。真实 Token 只累加 `thread/tokenUsage/updated.tokenUsage.last`。用户输入、Skill 和 MCP 默认由后台 `o200k_base` 本地分词；插件可选择官方 `/responses/input_tokens`，其请求使用独立的有界单并发线程并在失败时保留本地结果，不能混充真实 usage。

## 运行时约定

- MCP 是共享 App Server daemon 的全局配置：核心启动时加载一次，仅在用户手动 reload 时刷新。读取 `config/read`、`mcpServerStatus/list`，并结合 `mcpServer/startupStatus/updated` 区分配置启用、实际运行、启动失败和认证异常；打开设置页不能重复请求。
- Codex 更新属于 Harness 核心：每天启动最多检查一次最新稳定版并持久化到 `state.sqlite`；安装必须调用当前实际选中的 `codex update`，然后重启共享 App Server daemon、重新 initialize，并校验 CLI/App Server 版本。不能更新 Codex App 或其他封装 CLI。
- 快捷命令只能调用 Rust 固定允许的命令；VPN 成功以 Cisco 客户端的 `state: Connected` 为准，不能仅依据命令退出成功。
- “发布”是 Codex Harness 仓库 workspace 专属的受控快捷命令，其他项目不显示。发布状态按 workspace root 共享给其中所有 thread；后台 runner 脱离 Harness 生命周期执行并将状态、日志写入 `~/.codex-harness/release-runs/`，正常路径不启动 Agent。
- macOS 系统通知默认由 `src-tauri/Info.plist` 的 `NSUserNotificationAlertStyle=alert` 保持到用户处理，系统通知设置仍可覆盖。

## 状态与 Provider

- UI 状态、插件实例、插件 Run 和用量快照保存在 `~/.codex-harness/state.sqlite`；会话正文、凭据和 prompt/response 不写入 Harness 状态库。
- Codex 分析表同样永久保存在 `state.sqlite`，不自动过期；只保存 thread/turn ID、低基数标签、字符数、细分计数和官方数值 usage。Skill 文件路径和待分词正文只在后台计数期间短暂存在，Skill/MCP/Prompt/Response 正文均不落库。官方计数模式从进程环境读取 `OPENAI_API_KEY`，插件配置和数据库均不得保存密钥。
- API Workbench 使用独立的 `~/.codex-harness/api-workbench.sqlite`；Secret 变量只保存在 macOS Keychain。
- Claude Provider 由 `src-tauri/claude-adapter/daemon.mjs` 常驻进程承载，通过 `~/.codex-harness/claude-provider.sock` 通信。首次运行要把 daemon/SDK 安装到 `~/.codex-harness/claude-provider/`，注册 `com.local.codex-harness.claude-provider` LaunchAgent，并把 `available`、`managed`、`running` 分开显示。关闭 Harness 不停止 daemon 或 active turn；transport 断开时收口 active turn 并自动重连，只有 LaunchAgent 不可用时才按需启动。`adapter.mjs` 只能作为实验参考，不能作为生产入口。除非任务明确涉及 Claude，不要把 Claude 路径混入 Codex 改动。

## Agent Job

- Quick Action 通过声明式 `quickActions` slot 显示，调用 `harness.agentRuns` 创建独立会话；Run 记录 parent thread、child thread、turn 和 provider。
- Job 必须声明 `read-only`、`shared-write` 或 `isolated-delivery`。共享写任务使用同一 checkout 时互斥；隔离交付 worktree 固定创建在 `~/.codex-harness/agent-worktrees/<run-id>` 并保留给用户检查。
- `return-to-parent` 是一次性的用户手动操作，父会话 active 时不得自动回传或重试。
