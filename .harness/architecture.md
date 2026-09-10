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
- 新会话空白区的增强 UI 使用 `newThreadPanels` slot，紧凑入口可声明 `placement: 'header'` 放到新会话提示行右侧，默认仍在下方面板区；宿主把类型化的会话设置更新函数传给插件，插件不能自行连接 App Server。
- 输入框的符号触发补全（如 `$` Skill、`@` 文件之外的 `#`）使用 `composerCompletions` slot：插件声明单字符触发符并按 query 返回补全项，核心 Composer 负责面板、键盘导航和正文/折叠粘贴插入；插件不得自行渲染输入框弹窗。
- 内置「用量分析」插件的外层页签名为「用量」，通过 `harness.codexAnalytics` 查询 Harness 执行期的 Codex 统计，通过 `harness.usage` 保留账号额度和本机历史汇总；两种范围独立展示，不相加。旧 `builtin.codex-analytics` 实例设置迁入 `builtin.usage` 后移除旧入口。
- 精细统计的采集点在 `app_server.rs`，持久化、聚合在 `codex_analytics.rs` 及其子模块；插件不直接读取 SQLite、凭据或执行命令。Codex Business/Personal 历史由 Rust 通过 `ccusage` 采集，额度协议在 `app_server.rs` 封装，AIS 只访问固定 Compass 域名。
- 用量页固定展示 Codex、Codex Personal、AIS 三个账号来源卡片，下方为总览、模型、工作区、Skill、MCP、AGENTS.md、会话。账号 Token 使用所选日期范围；账号剩余额度是当前窗口，AIS 是本月预算。三类资源以观测次数和使用工作区为主，Skill 选择与读取不相加。
- 分析工作区按 thread 绑定的完整 cwd 归属，不按目录名合并。`analysis_workspaces` 保存绑定路径；历史归属与归档会话名称经 App Server `thread/read` 补查，名称只在内存缓存。查询使用已有核心连接，限制并发和超时，不启动 daemon 或模型轮次。
- 官方费用通过 `account/usage/read({ threadId })` 查询会话累计估算。模型额度图仅在整个会话落入所选日期、各模型 Token 与采集账本一致时展示 credits；任一记录不可核对时显示不可用，不按 Token 比例分摊累计费用。会话详情可独立查看整个会话累计估算，美元金额允许缺失。
- Codex Radar 请求由 Rust 固定域名客户端完成并缓存，内置会话启动器只能通过 `harness.codexRadar` 读取整理后的指标。

## Codex 运行时

- Harness 启动时复用或启动共享 `codex app-server daemon`，初始化一次连接并转发事件。关闭 Harness 不停止 daemon。
- 普通对话经 `useHarness` 调用 `thread/start`、`turn/start`、`turn/steer` 等方法；Quick Agent 经 `harness.agentRuns` 创建独立 child thread。
- App Server 当前协议的 `UserInput` 支持 `text`、`localImage`、`skill` 和 `mention`；`turn/start` 还支持可选的 `turnTrigger` 来源标识。协议字段必须以当前 CLI 生成的 schema 和实际运行版本为准。
- Composer 通过 `+`、`@` 或剪贴板添加 PNG、JPEG、GIF、WebP 图片，发送前统一构造成 `localImage`。剪贴板图片由 Rust 原生层读取并转换成系统临时目录下的 PNG，前端草稿只保留路径，不保存 base64；临时文件不在发送后立即删除，以免破坏排队和重试。
- Composer 选中 `$skill` 后，文本项保留可见 marker，并带 CLI 兼容的 `text_elements`；独立的 `skill` 项仍由 App Server 解析。普通文件只发结构化 `mention`，不要在前端展开文件内容。当前 CLI 0.151.0 的文件选择发送路径文本，和 Harness 的结构化 mention 是已知协议差异。
- `thread/tokenUsage/updated` 提供 Codex 会话的累计和最近一次 usage，前端已用于会话统计。累计值不能直接当成单 turn 值相加。
- Rust 原生层在 `~/.codex-harness/logs/harness.jsonl` 留存低基数的 App Server 请求和 usage 诊断；`turnTrigger` 用于区分普通对话、标题生成、Quick Agent 等来源，日志不保存正文。
- Codex 分析使用有界非阻塞队列和独立 SQLite 写线程。初始化、队列或写入失败一律 fail-open，不得阻塞 App Server 或阻止 Harness 启动；页面显示丢弃/写入错误计数。真实 Token 仅累加已登记 Harness 轮次的 `thread/tokenUsage/updated.tokenUsage.last`；累计值的签名永久保存用于重放去重，不参与相加，回退或缺口标记不完整。启动应答之前的通知和有明确父任务关系的子 Agent 通知使用有界暂存。
- Skill 显式选择与 `commandActions.read` 观测读取分别统计，后者只采用 App Server 提供的路径，不自行解析 shell。多文件输出不强行分摊；AGENTS.md 自动加载没有证据时显示未采集。`turn/steer` 的追加输入只关联已经登记的轮次。模型记录有效配置，重路由仅标记，不将整轮消耗改归新模型。
- 用户输入、Skill 和 MCP 内容默认由后台 `o200k_base` 本地分词；单项内容超过 64 KiB 或缺失时保留事件并标记计数不可用。插件可选择官方 `/responses/input_tokens`，其请求使用独立的有界单并发线程，失败保留本地结果，不能混充实际 usage。

## 运行时约定

- MCP 是共享 App Server daemon 的全局配置：核心启动时加载一次，仅在用户手动 reload 时刷新。读取 `config/read`、`mcpServerStatus/list`，并结合 `mcpServer/startupStatus/updated` 区分配置启用、实际运行、启动失败和认证异常；打开设置页不能重复请求。
- Codex 更新属于 Harness 核心：每天启动最多检查一次最新稳定版并持久化到 `state.sqlite`；安装必须调用当前实际选中的 `codex update`，然后重启共享 App Server daemon、重新 initialize，并校验 CLI/App Server 版本。不能更新 Codex App 或其他封装 CLI。
- 快捷命令只能调用 Rust 固定允许的命令；VPN 成功以 Cisco 客户端的 `state: Connected` 为准，不能仅依据命令退出成功。
- “发布”是 Codex Harness 仓库 workspace 专属的受控快捷命令，其他项目不显示。发布状态按 workspace root 共享给其中所有 thread；后台 runner 脱离 Harness 生命周期执行并将状态、日志写入 `~/.codex-harness/release-runs/`，正常路径不启动 Agent。
- macOS 系统通知默认由 `src-tauri/Info.plist` 的 `NSUserNotificationAlertStyle=alert` 保持到用户处理，系统通知设置仍可覆盖。

## 应用内通知

- 核心通知服务位于 `src/core/notifications/`，插件通过 `harness.notifications` 发布结构化通知。正文使用可读说明，原始错误放 `details`；级别为绿色 `info`、黄色 `warning`、红色 `error`。
- 浮层位于对话内容区右上角，最多显示三条；关闭或超时仅收起浮层。通知中心是独立页面，按最新时间排序，支持类型/当前会话筛选、已读和关联操作。
- 通知可传 `silent: true` 保留历史并直接标记已读，不显示浮层；会话归档成功使用静默通知，失败仍正常提醒。
- 历史通过现有 appState 接口写入 `state.sqlite` 的 `notifications.history`，永久保留，不做自动过期或脱敏。存储通知说明、原始错误和关联标识，不复制会话正文、归档草稿或完整日志。
- 发布和项目归档按一次任务更新同一条通知；发布跨会话继续跟踪，历史日志按 run ID 打开。系统通知插件仍独立负责 macOS 回复完成提醒。

## 状态与 Provider

- UI 状态、插件实例、插件 Run、输入区未发送草稿和用量快照保存在 `~/.codex-harness/state.sqlite`；草稿只保存文本、折叠粘贴和附件路径，成功发送后清除。已发送的会话正文、凭据和模型 response 不写入 Harness 状态库。
- 用量分析的新 `analysis_*` 表永久保存在 `state.sqlite`，不自动过期；旧 `codex_analytics_*` 表保留但不混入新口径。每日统计按事件时间与本机时区分桶；会话/轮次列表分页，汇总覆盖完整筛选范围。只保存 thread/turn ID、低基数标签、细分计数和官方数值 usage。Skill 文件路径和待分词正文只在后台计数期间短暂存在，Skill/MCP/Prompt/Response 正文均不落库。官方计数模式从进程环境读取 `OPENAI_API_KEY`，插件配置和数据库均不得保存密钥。
- API Workbench 使用独立的 `~/.codex-harness/api-workbench.sqlite`；Secret 变量只保存在 macOS Keychain。
- Claude Provider 由 `src-tauri/claude-adapter/daemon.mjs` 常驻进程承载，通过 `~/.codex-harness/claude-provider.sock` 通信。首次运行要把 daemon/SDK 安装到 `~/.codex-harness/claude-provider/`，注册 `com.local.codex-harness.claude-provider` LaunchAgent，并把 `available`、`managed`、`running` 分开显示。关闭 Harness 不停止 daemon 或 active turn；transport 断开时收口 active turn 并自动重连，只有 LaunchAgent 不可用时才按需启动。`adapter.mjs` 只能作为实验参考，不能作为生产入口。除非任务明确涉及 Claude，不要把 Claude 路径混入 Codex 改动。

## Agent Job

- Quick Action 通过声明式 `quickActions` slot 显示，调用 `harness.agentRuns` 创建独立会话；Run 记录 parent thread、child thread、turn 和 provider。
- Job 必须声明 `read-only`、`shared-write` 或 `isolated-delivery`。共享写任务使用同一 checkout 时互斥；隔离交付 worktree 固定创建在 `~/.codex-harness/agent-worktrees/<run-id>` 并保留给用户检查。
- `return-to-parent` 是一次性的用户手动操作，父会话 active 时不得自动回传或重试。
