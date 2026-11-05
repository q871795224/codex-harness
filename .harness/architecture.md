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
- Codex Radar 请求由 Rust 固定域名客户端完成并缓存，内置会话启动器只能通过 `harness.codexRadar` 读取整理后的指标。自动加载使用 30 分钟缓存；手动刷新必须绕过缓存并重新请求，失败时明确提示，不能把旧缓存当作刷新成功。部分模型请求失败时保留成功结果并提示数据不完整。

## 工作区 Router

- 新 Codex 会话默认未选工作区，空白 thread 使用 `~/.codex-harness/workspaces/general`，不继承其他会话或 daemon 的 cwd；手动选工作区后跳过 Router，重置会话保留当前 cwd。
- `core/workspace-router` 在首次发送前使用只读、禁工具和 MCP 的 ephemeral App Server thread 选择主工作区及相关工作区；默认 `gpt-6.1-terra` / `medium`，设置页管理模型、强度和按完整 root 绑定的用途说明。每次路由读取一次配置快照，解析结果必须属于候选目录。
- 选择后在最终 cwd 重建尚未发送的 thread，保留执行设置、未发送草稿及项目绑定；项目机器标识同步到新 thread，附件引用区间随之修正。原始需求完整转交，相关工作区另附路径提示。路由失败保留草稿，不在猜测的目录自动执行；通用请求沿用专用目录。切换到其他会话不打断路由，也不得被后台完成抢回选择。
- 反馈卡片独立于执行，点击“不准”并保存实际工作区只记纠错，不切换 cwd、插话或中断。成功发送后续用户消息才记默认准；首次发送、失败发送和系统继续不计。明确反馈可覆盖默认准，历史保留。
- 设置、候选配置快照、选择、来源 thread/client message/turn ID、耗时与反馈历史经已有 appState 接口持久化；每次尝试独立留存，路由重试不覆盖旧尝试。用户正文、图片和原始模型回复不复制进状态库或日志。诊断来源为 `workspace-router`，实际模型 usage 仍由核心账本采集。

## 成员与团队

- `core/teams` 管理成员、团队、任务快照和受控调度；App 创建单例，原生 `TeamMode` 和内置 `teams` 插件共享它。插件只通过 `harness.teams` service 接入。
- 会话视图与团队视图统称工作视图；`app_state.interfaceMode` 记录选择，切换时保留已挂载视图与运行服务。原生团队视图使用左侧导航，可在没有当前会话或团队插件时操作。
- 团队运行以保留的 `core.teams` 内部记录满足 `plugin_runs` 外键，启动时迁移旧 `builtin.teams:default` 运行。该记录不进入插件列表，不允许经插件接口修改或删除；移除插件视图不删除核心团队运行。
- 每次执行复用 `harness.agentRuns`，保留来源会话；团队运行使用 detached 模式，不触发旧委派的自动回传 UI。成员 Skill 来自核心 App Server 列表，启动时重新验证，并通过原生 Skill 输入提供；MCP 仍是共享配置。
- `store/teams.rs` 保存版本化任务文档和成员 Markdown 记忆，正文不进 SQLite。SQLite 写事务只协调文件写入，原子替换前比较版本；记忆路径验证成员 ID，工作区键同时校验完整 scope，拒绝符号链接。
- 任务内顺序协作，多个任务可并行使用各自隔离 worktree。重启不会自动接管。调度规则与预算语义以 `agent-interaction.md` 第八节为准。

## Harness 记忆

- 记忆是核心能力，`features/memory/MemoryButton.tsx` 直接接入输入框操作区，不依赖插件启停；`core/memory/` 负责分页读取会话、预算截断和 ephemeral Agent 的结构化提炼。
- 核心设置的“记忆”页管理模型、推理强度、提示词、轮数和预算，使用 state.sqlite 的 app_state 键 `memory.settings.v1`；每次提炼读取一次设置，运行中的任务保持启动时配置。
- `src-tauri/src/store/memory.rs` 通过现有 `state.sqlite` 的 `memory_*` 表维护名称与关联，Markdown 正文和索引保存到 `memory/`。模型只返回标题、类型、归属、正文、适用条件和依据说明；Harness 自动组装来源会话、所选提炼轮次范围、目录、记忆 ID 和写入时间，忽略模型返回的元数据。来源范围不代表逐条证据定位，历史可能按预算省略；Harness 校验内容与范围后写文件。
- 领域由“设置 → 工作区”的 tag 管理入口维护，绑定/解绑为增量操作，删除定义或解除关联均保留 Markdown 文件。提炼仅提供来源工作区关联的领域，写入时重新校验；Agent 不创建领域或修改关联。
- Harness tab 在同一文件树中展示虚拟 `harness` 文档分组和 `memory` 目录；记忆文件经核心 store 读取和编辑，保存时比较读取版本并校验 scope，正文保存与索引重建共用批次写入，插件只消费 `harness.files` 服务。
- 文件写入由 SQLite 写锁协调，未完成的正文/索引批次在下次记忆操作时恢复。详细范围及当前阶段限制见 `docs/memory/phase-1/README.md`。

## Jev 决策服务

- `src-tauri/src/jev.rs` 按需调用固定 Vercel `/v1/evaluate` 端点和 `typesafe-ai/jev`；核心通过 `bridge.ts` 的 `jevStatus`、`jevEvaluate` 接入，领域类型位于 `src/core/domain/jev.ts`。
- 密钥只由 Rust 从 `~/.codex-harness/secrets` 的 `VERCEL_API_KEY` 读取，每次调用重新读取；状态接口只报告本地是否配置，不代表远端权限或额度已验证。
- 调用方显式提供 state 和 questions；不自动携带会话、加载记忆或触发模型调用。结果保留答案、usage 和费用，缺失费用与零费用分开表示；不持久化或记录输入、回答、密钥。
- 这是独立的决策服务，不接入聊天 Provider 或绕过 App Server 的 Skill/MCP 管理。后续插件使用需通过 extension service 契约接入。

## 会话自动命名

- Codex 和 Claude 会话共用核心的只读 Codex 临时会话生成标题。Composer 单独提供排除项目背景卡的命名输入，普通粘贴内容保留；主会话仍收到完整项目文档。
- 项目简称属于项目元数据 `shortName`，创建时为空，可在项目文档插件中编辑或清空，不推进文档版本。首次自动命名在同一次模型调用中提议简称，Harness 校验后仅在字段为空时原子保存，并使用返回的最终值拼接 `[简称] 任务标题`。已有简称直接复用；模型不读写项目存储。改名或调整简称不批量重命名历史会话。

## Codex 运行时

- Harness 启动时复用或启动共享 `codex app-server daemon`，初始化一次连接并转发事件。关闭 Harness 不停止 daemon。
- Codex 活跃轮次归属由原生层写入 `state.sqlite.active_turn_owners`，只保存 thread、turn 和随机运行实例 ID；`instances/` 下的 OS 文件锁随进程退出释放，用于区分旧实例退出与稳定版/开发版同时运行。`thread/resume` 按 daemon 返回的活跃轮次在 SQLite 写事务中恢复归属，原生层通过 `harnessOwnership` 元数据告知前端；不根据会话 originator 或旧内存布尔值自动认领未知轮次。
- 旧实例仍存活时保持只读；用户可通过原生 `app_server_take_over` 显式接管，先核对 daemon 当前轮次与 expected turn ID，再转交归属。未知归属的升级前轮次也需显式接管。原实例后续插话、停止与审批响应由原生层检查归属并拒绝；此约束只协调 Harness 实例，不能撤销 CLI 等外部客户端的权限。团队调度恢复规则不受会话操作权恢复影响。
- 待处理 server request 不落库，由 App Server 在 `thread/resume` 后重放；前端按请求 ID 去重，原生层仅允许响应当前连接实际收到且尚未 resolved/完成的请求，断线后重新获取，不重试磁盘上的旧请求 ID。实例锁文件保留以避免 unlink 后出现不同 inode 的锁竞争。
- 普通对话经 `useHarness` 调用 `thread/start`、`turn/start`、`turn/steer` 等方法；Quick Agent 经 `harness.agentRuns` 创建独立 child thread。
- App Server 当前协议的 `UserInput` 支持 `text`、`localImage`、`skill` 和 `mention`；`turn/start` 还支持可选的 `turnTrigger` 来源标识。协议字段必须以当前 CLI 生成的 schema 和实际运行版本为准。
- Composer 通过 `+`、`@` 或剪贴板添加 PNG、JPEG、GIF、WebP 图片，发送前统一构造成 `localImage`。剪贴板图片由 Rust 原生层读取并转换成系统临时目录下的 PNG，前端草稿只保留路径，不保存 base64；临时文件不在发送后立即删除，以免破坏排队和重试。
- Composer 选中 `$skill` 后，文本项保留可见 marker，并带 CLI 兼容的 `text_elements`；独立的 `skill` 项仍由 App Server 解析。普通文件对齐 CLI，只发送路径文本，不发送 `mention` 或文件正文。图片使用 `localImage`，正文包含 CLI 兼容的 `[Image #N]` 与 UTF-8 字节范围 `text_elements`。
- `thread/tokenUsage/updated` 提供 Codex 会话的累计和最近一次 usage，前端已用于会话统计。累计值不能直接当成单 turn 值相加。
- Rust 原生层在 `~/.codex-harness/logs/harness-<version>-<timestampMs>-<pid>-<segment>.jsonl` 留存低基数的 App Server 请求和 usage 诊断；每段约 2 MiB，永久保留，不自动删除。每条记录带 `harnessVersion`，升级和进程重启写新文件，旧版 `harness.jsonl` / `harness.previous.jsonl` 原样保留。`turnTrigger` 区分来源；`rpc.rejected` 保存服务端数值错误码、请求标识及白名单原因分类，不保存任意错误正文或 data。
- Codex 分析使用有界非阻塞队列和独立 SQLite 写线程。初始化、队列或写入失败一律 fail-open，不得阻塞 App Server 或阻止 Harness 启动；页面显示丢弃/写入错误计数。真实 Token 仅累加已登记 Harness 轮次的 `thread/tokenUsage/updated.tokenUsage.last`；累计值的签名永久保存用于重放去重，不参与相加，回退或缺口标记不完整。启动应答之前的通知和有明确父任务关系的子 Agent 通知使用有界暂存。
- Skill 显式选择与 `commandActions.read` 观测读取分别统计，后者只采用 App Server 提供的路径，不自行解析 shell。多文件输出不强行分摊；AGENTS.md 自动加载没有证据时显示未采集。`turn/steer` 的追加输入只关联已经登记的轮次。模型记录有效配置，重路由仅标记，不将整轮消耗改归新模型。
- 用户输入、Skill 和 MCP 内容默认由后台 `o200k_base` 本地分词；单项内容超过 64 KiB 或缺失时保留事件并标记计数不可用。插件可选择官方 `/responses/input_tokens`，其请求使用独立的有界单并发线程，失败保留本地结果，不能混充实际 usage。

## 运行时约定

- 全局 `codex-harness` Skill 经 `harnessctl` 调用本机管理入口。原生层复用项目文档 listener，单独发布带认证的 `management-server.json`；`management.rs` 负责请求关联和去重，`core/management` 调用挂载的界面服务，工作区和插件查询不从数据库重建最终列表。管理协议、覆盖范围、写入及 fallback 见 `docs/management.md`。

- 项目文档 HTTP 服务由 Harness Rust setup 启动，退出时停止，不依赖当前会话或项目绑定。启动失败必须报错；地址文件通过原子替换发布，异常退出的旧地址在下次启动覆盖。稳定版与开发版同时运行时，CLI 使用最后启动实例的地址；实例退出只删除自己发布且仍持有的地址，不能删除其他实例的记录。

- MCP 是共享 App Server daemon 的全局配置：核心启动时加载一次，仅在用户手动 reload 时刷新。读取 `config/read`、`mcpServerStatus/list`，并结合 `mcpServer/startupStatus/updated` 区分配置启用、实际运行、启动失败和认证异常；打开设置页不能重复请求。
- Codex 更新属于 Harness 核心：启动及运行期间定时检查最新稳定版并持久化到 `state.sqlite`；成功后间隔 24 小时，失败后间隔 15 分钟重试，设置底部刷新按钮同时强制检查更新并展示结果；安装必须调用当前实际选中的 `codex update`，然后重启共享 App Server daemon、重新 initialize，并校验 CLI/App Server 版本。不能更新 Codex App 或其他封装 CLI。
- 快捷命令只能调用 Rust 固定允许的命令；VPN 成功以 Cisco 客户端的 `state: Connected` 为准，不能仅依据命令退出成功。
- “发布”是按远端仓库识别的 workspace 专属受控命令，仅对 Codex Harness 与 Jewell 仓库显示。发布状态按 workspace root 共享给其中所有 thread；后台 runner 脱离 Harness 生命周期执行并将状态、日志写入 `~/.codex-harness/release-runs/`，正常路径不启动 Agent。
- macOS 系统通知默认由 `src-tauri/Info.plist` 的 `NSUserNotificationAlertStyle=alert` 保持到用户处理，系统通知设置仍可覆盖。

## 应用内通知

- 核心通知服务位于 `src/core/notifications/`，插件通过 `harness.notifications` 发布结构化通知。正文使用可读说明，原始错误放 `details`；级别为绿色 `info`、黄色 `warning`、红色 `error`。
- 应用右侧复用同一通知账本显示浮层、气泡与临时提醒栏；同会话聚合一张卡片，优先显示待回应事项。浮层最多三张且到时收起，关闭浮层不处理事项。完整历史仍在现有通知中心，筛选、错误详情和关联操作保留。
- `attention` 区分回应、结果和到点跟进；已读与实际处理独立。`state: pending` 的来源事项在已读后仍待关注，由来源解除后消退；运行中只记录历史。新一轮结果默认仅提醒显式关注的会话；提问/审批与失败直接接入，当前正在阅读的会话不重复弹浮层。
- “提醒当前会话”、通知的“稍后提醒”与关注订阅都保存在 `notifications.history`，不另建任务表。定时由前端检查最早期限，焦点恢复、重新启动时补查；关闭、休眠期间不承诺弹出，提醒不发送模型轮次、不扩大执行权限。
- `useReminderSources` 消费核心待回应状态和完成事件，并监听现有异步等待快照。等待/后台续跑过程保持安静，异常暂停/过期/待核对时提醒；后续轮次完成后才提示结果。只有已观察过的请求解除、已加载且明确空闲的来源、或匹配的轮次结束才解除待回应，未加载会话不判为已处理。
- 来源提醒只保存会话/请求/轮次/等待 ID 与通用说明，不复制问题正文、模型答复、检查器摘要或 continuation。
- 启动时对已关注的 Codex 会话、已投递的异步续跑查询最新一轮摘要，并发最多两个；只补关注时间后的完成结果或精确匹配的续跑结果，按轮次去重。Claude 关注使用运行中的完成事件，不做关闭期间的结果补查。
- 通知可传 `silent: true` 保留历史并直接标记已读，不显示浮层；会话归档成功使用静默通知，失败仍正常提醒。
- 历史通过现有 appState 接口写入 `state.sqlite` 的 `notifications.history`，永久保留，不做自动过期或脱敏。存储通知说明、原始错误和关联标识，不复制会话正文、归档草稿或完整日志。
- 发布和项目归档按一次任务更新同一条通知；发布跨会话继续跟踪，历史日志按 run ID 打开。系统通知插件仍独立负责 macOS 回复完成提醒。

## SeaTalk 会话续聊

- `core/seatalk` 在应用核心挂载，普通活动会话默认同步到 Bridge 的 `harness-sessions` OpenAPI Bot；每个会话一条主消息，后续更新与远程输入都使用原生回复分支。同步不依赖插件 tab 或当前选中会话；完整使用和恢复语义见 `docs/seatalk/README.md`。
- Rust `local_connector.rs` 只代理固定 loopback `/local/harness/*` 动作；Bridge 管理 Bot 凭据、原生发送回执、会话分支映射和入站指令原子领取，Harness 核心通过现有会话运行时提交输入、队列、停止与审批，不由 Bridge 直接连接 App Server。
- 接收者和操作者使用账号显式配置的员工编号；仅接受该账号已映射私聊分支中的用户消息。远程执行先恢复会话核对轮次归属，不切换电脑选择、不自动接管其他实例。消息与指令均使用持久去重编号，结果不明的外部动作不自动重放。
- 会话通道在线时，核心抑制旧提问通知插件的重复发送；离线时保留原有提问卡片。

## SeaTalk 中间提问通知

- 独立插件 `builtin.question-notifications` 默认开启，通过核心 `harness.conversations.onUserInputRequested` 消费 `item/tool/requestUserInput` 和 `agentMessage.delivery=async`；不依赖 SeaTalk 草稿插件或异步等待任务。
- 每题一张交互卡片。原生层按 thread、turn、提问类型、稳定 item 标识和 question ID 在 SQLite 原子登记一次发送尝试，更新、重放、重启和多实例不重复发；发送失败保留登记，不自动重试，也不影响提问本身。标记为敏感的问题只发送提醒，不发送题目和选项。
- 桌面链路为 `SeaTalk 卡片 → 本机 Bridge /local/open/harness → codex-harness://question → Harness`。Bridge 固定用 bundle ID `com.local.codex-harness` 打开稳定版，不依赖两个 flavor 对同一协议的系统优先级；不提供开发版入口。手机端不配置跳转，不远程唤醒电脑。
- 默认 Bridge account 为 `harness-notify`，接收者 `self` 由该账号的 `notificationTargetEmployeeCode` 显式解析；未配置则发送失败。Bot 凭据继续由 Bridge 环境文件管理，Harness 插件配置只含本机地址、账号名和接收者标识。
- 链接只含 thread、turn、稳定请求标识、题号、题目版本摘要和可选的选项下标。Rust 暂存冷启动及运行中收到的链接，WebView 就绪后订阅并一次性取走；打开会话后重新核对当前请求和题目版本。已处理或更新的问题显示当前状态，不提交旧请求。
- 链接选择预填现有逐题表单；已有答案换行追加，普通聊天草稿不变。未发送的问题答案保存在独立草稿键中，敏感答案只留内存；原有回答通道提交成功后清除。打开链接与预填均不发送回答或创建 turn。

## 状态与 Provider

- UI 状态、插件实例、插件 Run、输入区未发送草稿和用量快照保存在 `~/.codex-harness/state.sqlite`；草稿只保存文本、折叠粘贴和附件路径，成功发送后清除。已发送的会话正文、凭据和模型 response 不写入 Harness 状态库。
- 选择器引用的草稿标签复用 `collapsedPastes.reference`；手打路径不自动识别。已发送引用的 UI 元数据通过 `message.references.v1:<clientUserMessageId>` 保存类型、UTF-16 正文区间和文件路径，以正文 SHA-256 校验，恢复时由 App Server `userMessage.clientId` 关联；不保存消息或粘贴正文。队列正文被编辑后旧区间失效。
- 用量分析的新 `analysis_*` 表永久保存在 `state.sqlite`，不自动过期；旧 `codex_analytics_*` 表保留但不混入新口径。每日统计按事件时间与本机时区分桶；会话/轮次列表分页，汇总覆盖完整筛选范围。只保存 thread/turn ID、低基数标签、细分计数和官方数值 usage。Skill 文件路径和待分词正文只在后台计数期间短暂存在，Skill/MCP/Prompt/Response 正文均不落库。官方计数模式从进程环境读取 `OPENAI_API_KEY`，插件配置和数据库均不得保存密钥。
- API Workbench 使用独立的 `~/.codex-harness/api-workbench.sqlite`；Secret 变量只保存在 macOS Keychain。
- Claude Provider 由 `src-tauri/claude-adapter/daemon.mjs` 常驻进程承载，通过 `~/.codex-harness/claude-provider.sock` 通信。首次运行要把 daemon/SDK 安装到 `~/.codex-harness/claude-provider/`，注册 `com.local.codex-harness.claude-provider` LaunchAgent，并把 `available`、`managed`、`running` 分开显示。关闭 Harness 不停止 daemon 或 active turn；transport 断开时收口 active turn 并自动重连，只有 LaunchAgent 不可用时才按需启动。`adapter.mjs` 只能作为实验参考，不能作为生产入口。除非任务明确涉及 Claude，不要把 Claude 路径混入 Codex 改动。
- Claude 对话 query 按会话复用开放的流式输入；`result` 只暂存结果，收到 SDK `session_state_changed: idle` 后才释放当前 turn 并发出一次终态，不能等整个 query 退出或在第一个 result 强制关闭 query。停止通过 SDK `interrupt()`，异常流退出必须收口所属 turn；上下文查询复用已有 query。空闲且没有后台任务的 query 在 5 分钟后回收；模型、权限、cwd 或环境变更在安全空闲时重建，后台任务仍运行时拒绝配置切换，避免中断工作。
- Claude 每次创建 Agent SDK query（对话、模型发现、上下文查询）时读取 `~/.codex-harness/secrets`，在启动环境白名单清理之后，把显式配置传给子进程；不修改 daemon 自身环境，文件修改或删除在下次 query 生效。文件为明文 `KEY=value`，忽略空行和 `#` 开头的注释，按首个 `=` 分割并去除两端空白，不执行 shell 展开或去除引号。白名单保留的进程变量优先于文件，`CLAUDE_AGENT_SDK_CLIENT_APP` 固定为 `codex-harness`；文件缺失允许继续，其他读取错误报错，值不进入 Harness 状态库或诊断日志。Codex 仍只在 daemon 启动时读取该文件。

## Agent Job

- Quick Action 通过声明式 `quickActions` slot 显示，调用 `harness.agentRuns` 创建独立会话；Run 记录 parent thread、child thread、turn 和 provider。
- Job 必须声明 `read-only`、`shared-write` 或 `isolated-delivery`。共享写任务使用同一 checkout 时互斥；隔离交付 worktree 固定创建在 `~/.codex-harness/agent-worktrees/<run-id>` 并保留给用户检查。
- `return-to-parent` 是一次性的用户手动操作，父会话 active 时不得自动回传或重试。

## 项目文档维护

旧“归档到项目”功能已下线：不再注册输入框和回答操作行的触发入口，插件设置不再展示旧流程的轮数和 Prompt 模板。日常记录通过 Agent 的 `project-doc` Skill 追加，整文整理使用“精简项目文档”。旧归档编排、确认面板、配置字段和历史草稿处理暂留，后续可单独清理；不得因底层代码仍在就重新展示入口。

### 决定与待办条目

Markdown 继续作为正文和条目属性的唯一来源。Decisions / Open Questions 新增内容自动带稳定 ID、状态、修订号与原因；旧段落可显式纳管，不批量迁移。原生 `project_doc_store::entries` 校验条目操作并通过既有事务/快照保存；Agent 经 CLI，用户经项目 Tab“条目”页操作。替代原子建立新旧关系，删除只软删除；人工全文编辑可改正文，不能移除条目或伪造属性。Status 仍经人工确认覆盖，Log 只追加。

首轮默认全文注入；仅超过当前作用域插件门限时排除明确软删除/失效的受管理条目，其他正文完整保留，不做语义检索或硬截断。项目页和工具读取保持完整。条目与人工作业边界见 [项目文档条目维护](../docs/project-doc-entries.md)。

### 项目文档 Skill 分发

`.agents/skills/project-doc/` 是 Skill 与 CLI 的 Git 源码，编译进 Harness 原生程序；首次绑定会话发送时，按内容版本落到 `~/.codex-harness/project-doc-skills/`，不依赖源码 checkout 或 PATH 里的旧命令。仅分发执行所需的 SKILL.md、Python CLI 和命令脚本，维护者设计沿革不进入运行资源。合并 PR 后还需构建、安装新应用，运行中的旧应用不会随 Git 合并更新。

Codex 核心在真实 CODEX_HOME 的原生 user-Skills 目录维护专属 `harness-project-doc` 链接，保留旧 `project-doc` 和其他 Skill；重名且非 Harness 管理时失败并保留原文件。共享 daemon 和其他客户端可发现元信息，这是允许的。绑定会话由 `app_server.rs` 刷新原生列表、采用返回的规范路径，提交原生 `skill` 输入；不替换全局 extraRoots，不追加 developer instructions。

Claude 核心按持久化绑定给 SDK query 配置本地插件 `harness-project-doc`，通过原生 `/harness-project-doc:project-doc` 调用。首次调用将文本合成最后一个文本块、图片保持在前，避免原生 CLI 静默跳过 Skill 展开；界面用户消息保持原输入。未绑定会话不配置此插件。Provider 协议版本为 3，旧 daemon 不能静默忽略新增参数。

加载标记只记录 Provider、会话、项目和资源版本；仅在发送被接受后保存，失败可重试，恢复和后续回合不重复主动加载同版本，资源更新后重新加载。旧版本资源保留供历史会话引用。CLI 使用本次加载的 Skill 目录内 `bin/project-doc`，无需另装全局命令。原生机制的隔离黑箱验证见 [验证记录](../docs/project-doc-native-skill-validation.md)。

### 项目文档精简

项目文档插件通过 `conversationBanners` slot 显示共用确认卡，手动入口保留在 Composer 右侧。会话结束只触发本地计数和提醒；用户确认后才启动只读 Codex detached run。默认门限10,000 tokens，按正文版本缓存 `o200k_base` 计数；配置位于插件设置。

原文归档、追加合并、并发修改检查和恢复由 Rust `project_doc_store::compaction` 负责，模型只输出四分区 Markdown。普通写入与精简共用 SQLite immediate transaction，跨 UI/HTTP 连接串行。详见 [项目文档精简](../docs/project-doc-compaction.md)。

## 异步等待

- `src-tauri/src/async_waits/` 管理一次性外部等待、Python 检查器和原生后台调度；`src/core/async-waits/` 提供会话任务卡片与原生“异步任务”tab（默认跨会话查看，支持状态筛选，隐藏聊天输入框），Agent 经管理入口 `asyncWaits.*` 创建和控制。准确参数及检查器契约见 `docs/management.md`。
- 任务正文与摘要位于 `~/.codex-harness/async-waits/` 文件，原子替换和版本比较协调更新；OS 文件锁协调稳定版/开发版执行者，不删除锁文件。关闭应用或休眠后恢复补查，不承诺离线监控。
- 条件满足后默认自动继续来源 Codex 会话，忙时保留待处理结果，空闲后合并续跑；此授权来自创建等待时指定的后续动作，区别于现有普通 Agent 委派的人工回传。续跑不扩大外部操作授权，沿用正常中间提问；SeaTalk 通知独立实现。
- 仅 `app_server.rs` 封装来源校验、恢复和启动协议。续跑前写发送意图；结果未知保留待核对，不自动重发。用户停止或归档来源会话时暂停等待。检查脚本只读且不调用模型，以当前用户权限运行，具有固定超时和输出上限。
