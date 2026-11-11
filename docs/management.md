# 本机 Harness 管理入口

应用随附的 `harness-runtime` Skill 和 `harnessctl.py` 在本仓库 `.agents/skills/harness-runtime/` 维护，编译进应用，随应用版本发布。Harness 在 Codex 会话首次发送时通过原生 Skill 输入加载；会话恢复不重复加载，同一 Skill 资源更新后重新加载。发送失败不记为已加载。标题生成、recap、记忆整理、Router判定和简介生成不加载这份运行协议。

主文件、CLI 和按需读取的 references 一起打包；所有文件路径和内容参与版本计算，分发时逐一核对，拒绝被替换的文件或符号链接。资源以内容版本写入 Codex 的 user-Skills 目录，使用真实文件副本，不依赖源码 checkout、全局 CLI 或软链接；旧版本副本保留供历史会话使用。Codex 的发现元信息可能对共享 daemon 的其他会话可见，正文只在 Harness 显式调用后加载；不替换 daemon 的 extraRoots。当前异步调度和自动加载仅支持 Codex，Claude 沿用现有运行方式。

Agent 使用原生 Skill 返回路径旁的 CLI：`python3 /absolute/path/harnessctl.py ...`。仓库开发时使用 `python3 .agents/skills/harness-runtime/harnessctl.py ...`。旧私有安装可继续调用兼容管理接口，但不再是本功能的运行依赖。自有 Skill 的统一分发规则与当前四份 Skill 的接入范围见 [Skill 分发约定](../.harness/skills.md)。

## 会话中途新建或加入项目

`projects.list` 返回项目元数据。新建或加入项目仅由用户在界面选择并确认，Harness 执行整理、保存和绑定；管理入口不提供 Agent 接入申请或申请状态接口。流程见 [从会话建立项目记忆](project-doc-onboarding.md)。

## 连接与执行

应用 setup 复用现有 loopback HTTP listener，另外原子发布 `~/.codex-harness/management-server.json`（0600）。文件包含 `baseUrl`、随机 `token`、`pid`、`protocolVersion: 1`、`harnessVersion`。稳定版/开发版沿用最后启动实例发布端点的规则；退出只清除自己的注册。不要打印 token。CLI 不走代理或跟随重定向。

`POST /management/call` 需要 `Authorization: Bearer <token>`，不接受带 Origin 的浏览器请求。请求体：

```json
{"requestId":"caller-generated-id","method":"workspaces.list","params":{}}
```

原生层把请求发给挂载的 HarnessShell。处理器只允许下表操作，复用已有工作区、会话、PluginHost、App Server 和 Claude daemon 服务；前端通过 `bridge.ts` 监听请求并用 `management_respond` 回传，`management_ready` 标识监听已建立。目录未加载、应用退出和不支持的操作必须报错，不能降级成数据库快照。

成功响应是 `{requestId,result}`，失败响应是 `{requestId?,error}`。写操作串行执行，并回读运行时或原生服务状态。插件失败时返回其实际 `failed` 状态，不能把已保存 enabled 当成激活成功。

请求默认等候 60 秒；排队超过 55 秒的任务不再执行。写请求在当前进程生命周期保留 requestId、参数及结果：同 ID 同参数返回旧结果，执行中或结果未知返回 409，同 ID 不同参数返回 409。断线、504 或回读超时不证明写入失败，先查询实际状态；不要换 ID 自动重试。重启后不保留去重记录。最多保留 4096 个写操作，满后显式拒绝；只读完成后释放记录。

## 操作契约

| method | params | 行为与覆盖范围 |
| --- | --- | --- |
| `status` | `{}` | 运行版本、flavor、Provider、选中会话、Claude 管理状态及插件加载状态 |
| `capabilities` | `{}` | 本版本支持的方法及 writes 标记 |
| `workspaces.list` | `{}` | 最终 workspaceCatalog，含隐藏条目；count 为可见数，catalogCount 为目录总数，标记 registered / discovered / visible |
| `workspaces.add` / `workspaces.show` | `{path}` | 验证并登记 Git 工作区，取消隐藏，更新界面；回读可见和持久化导航状态 |
| `workspaces.hide` | `{root}` | 沿界面的移除语义隐藏，保留目录和会话；回读导航状态 |
| `sessions.list` | `{}` | 当前已加载会话视图的元数据；complete=false，不包含消息正文 |
| `sessions.create` | `{provider?,cwd?}` | 创建空会话；Codex省略cwd时沿用自动Router，显式cwd优先；不发送模型轮次 |
| `sessions.select` | `{id}` | 使用已有 openThread 流程打开会话 |
| `sessions.rename` | `{id,name}` | 重命名当前视图已加载的会话 |
| `sessions.archive` | `{id}` | 归档当前活动视图的闲置会话；未发送草稿和空白会话沿原有规则处理 |
| `sessions.restore` | `{id}` | 恢复归档并打开会话 |
| `plugins.list` | `{provider?,workspaceRoot?,threadId?,cwd?}` | Harness 定义、权限、依赖、作用域、实例状态与当前上下文实际贡献；实例配置只返回 configKeys |
| `plugins.create` | `{pluginId,scope,enabled?,config?}` | 创建定义支持的作用域实例，默认启用，检查同作用域多实例限制 |
| `plugins.setEnabled` | `{instanceId,enabled}` | 通过 PluginHost 启停并回读生命周期状态 |
| `plugins.configure` | `{instanceId,patch}` | 合并配置并沿现有生命周期重新应用 |
| `plugins.delete` | `{instanceId}` | 删除实例，保留原有默认实例删除标记语义 |
| `skills.list` | `{cwd,provider?,reload?}` | Codex 使用 App Server skills/list；Claude 使用 SDK supportedCommands，明确它是部分命令表 |
| `skills.setEnabled` | `{cwd,path,enabled,provider?}` | 当前支持 Codex，验证目标在该工作区原生列表内后写入并 forceReload 回读 |
| `mcp.list` / `mcp.reload` | `{}` | 当前针对 Codex 全局 daemon；原生查询/刷新，不把配置启用当成连接成功 |
| `models.list` | `{provider?}` | 挂载Provider的模型目录，用于选择模型及推理强度 |
| `settings.list` / `settings.read` | `{}` / `{group}` | 配置组、可编辑字段、当前值和生效时机 |
| `settings.update` | `{group,patch,expected?}` | 固定配置组的小范围更新；先验证整份patch，回读运行时及持久化值；expected防止覆盖并发修改 |
| `router.summaries` / `router.refresh` | `{}` / `{root}`或`{all:true}` | 可见工作区简介及检查状态；刷新立即返回accepted，后续查summaries，不声称生成已完成 |
| `router.preview` | `{input?}` | 调用真实Prompt组装逻辑，无输入时使用占位符，不调用模型 |
| `router.record` / `router.feedback` | `{threadId}` / `{offset?,limit?}` | 路由记录及分页反馈元数据，省略用户消息正文 |
| `router.setFeedback` | `{threadId,accurate,actualWorkspace?}` | 记录用户明确评价；不准确时必须显式给root或null（通用），当前任务和目录不变 |
| `router.correct` | `{threadId,actualWorkspace}` | 记录纠正并切换已加载、空闲Codex会话的后续工作区，不重放任务 |
| `projects.get` / `projects.update` | `{projectId}` / `{projectId,patch,expected?}` | 项目元数据及关联工作区；仅修改name/shortName，简称最多12字符，不含控制字符或方括号 |
| `projects.list` | `{}` | 项目元数据列表；接入由用户在界面发起 |
| `plugins.read` | `{instanceId}` | 已声明的非秘密配置、可编辑字段、隐藏键名和实际生命周期；未知插件不导出配置值 |
| `notifications.list` | `{threadId?,unread?,offset?,limit?}` | 通知摘要，省略原始details；旧提醒浮层保持关闭 |
| `notifications.markRead` | `{id}`或`{all:true}` | 保存已读状态，不处理源问题、审批或其他业务动作 |
| `seatalk.status` / `seatalk.bindings` | `{}` | 只读通道状态和thread/root绑定元数据，不发送消息、领取指令或处理审批 |
| `config.read` | `{}` | 仅返回 Codex 默认 model、model_reasoning_effort、service_tier、approval_policy |
| `config.set` | `{key,value}` | 写入上述 Codex 默认值，刷新并核对有效配置；不修改已有会话设置 |

scope 为 `{kind:"global"}`、`{kind:"workspace",workspaceRoot}` 或 `{kind:"thread",threadId}`。布尔字段必须是 JSON 布尔值；config 和 patch 必须是对象。

## 设置与新增功能覆盖

`settings`管理Harness应用，`config`管理Codex默认值，`plugins`管理插件实例。客户端直接命令见应用随附Skill的[管理参考](../.agents/skills/harness-runtime/references/management.md)，不能把旧客户端或源码能力当作运行实例能力。

| 功能 | Agent管理入口 | 生效与边界 |
| --- | --- | --- |
| 工作区Router | settings/router、router子命令、自动会话创建 | 缓存、检查、Prompt、反馈、纠正齐全；刷新可能消耗模型，切换不回滚旧任务 |
| 项目文档精简 | plugins/read、configure的compactionThreshold、archiveModel、archiveEffort | 仅配置；整文精简由用户在界面发起 |
| 项目决定与待办 | harness-project-doc自带CLI | 继续使用共享文档的版本、回执与条目生命周期，不复制接口 |
| 会话中途建立项目 | projects申请及状态；项目元数据修改 | 绑定/整理仍走原有确认流程，真实来源thread不以当前选中会话代替 |
| 后台异步等待 | async-waits全套命令 | 已有只读检查器与续跑授权规则不变 |
| SeaTalk远程续聊 | seatalk诊断，相关插件配置 | 核心通道与旧草稿插件独立，凭据由Bridge保管 |
| 中间提问 | 提问通知插件的Bridge地址、account、targetId配置 | 不通过管理API代答问题或批准操作 |
| 通知与会话提醒 | 通知列表、已读和通知插件生命周期 | 已读不完成源事项；旧右侧浮层保持关闭 |
| 应用配置 | appearance、navigation、keyboard、threadTitle、recap、conversationStats、memory、history、inputCorrection、handover | 对应界面实时状态或共享设置模块，不开放任意appState |

配置组和范围以`settings list`为准；对象中的fontSizes、actionShortcuts、descriptions按键合并，Router介绍的null删除该项，其他数组整体替换。更新前可带先前settings对象作为expected；成功回包包含effect及实际值。核心UI设置通过原有setter应用，并确认存储；Router、记忆、历史和交接面板接收共享保存事件，已打开的界面随之刷新。历史响应上限需要重启，管理命令不自动重启。

插件配置仅为已知内置功能提供字段白名单，读取不导出未知配置值；Bridge地址只允许无凭据的本机HTTP(S)地址。独立管理Agent浮窗及列表注意力管理仍为后续事项。

## 能力边界与源码 fallback

Harness 插件、Codex 插件、Claude Code 插件分别管理。此入口管理 Harness 实例，不代理所有插件的业务动作；异步等待只执行显式登记的检查脚本，不提供临时 shell 入口，不提供通用 App Server RPC、审批放行或数据库写入入口。

客户端用 `harnessctl source` 定位仓库。读取 `AGENTS.md` 和 `.harness/README.md` 后沿 `src/core/management/service.ts`、`src/core/plugins/`、目标 `src/plugins/<name>/`、`bridge.ts`、Rust 实现核对能力。旧版本没有管理端点时明确报告不支持，源码存在接口不等于当前运行应用已具备。

## 验证

Rust 测试验证端点认证、Origin 拒绝、权限和注册归属，以及写请求去重；前端测试使用真实 PluginHost 的 lifecycle 验证启停和贡献变化，覆盖显式登记与发现工作区的数量差异。Claude daemon 用注入 SDK 测试命令查询，不发送真实模型请求。客户端用本地 fixture 服务验证请求、错误和重定向边界。所有测试使用临时目录或注入依赖。新增设置测试覆盖整份patch先校验、expected冲突拒绝、持久化回读和已打开面板刷新；Router测试区分反馈与实际目录切换，通知测试保留源事项pending。Skill分发测试逐文件核对参考文档并拒绝替换；隔离原生Skill探针使用临时HOME与本地假模型验证发现、加载及会话恢复，不调用真实模型。

## 异步等待（Codex）

Harness 提供受控 CI（GitLab/GitHub）、SDP、SeaTalk 新回复及持久化 sleep 工具。Agent 只提交结构化目标，不能为受控工具指定检查脚本、命令或 API 路径。特殊任务使用自定义入口，先展示 Harness 确认卡，用户同意后才激活。资源空闲等低频条件用 sleep 唤醒后检查，或申请自定义等待。

| method | params | 行为 |
| --- | --- | --- |
| `asyncWaits.create` | `{id,threadId,title,continuation,target,condition?,checkerPath?}` | 原生验证目标、绑定来源 cwd；受控工具直接登记，自定义任务保存待确认提案及脚本快照 |
| `asyncWaits.list` | `{}` | 返回 `{data,schedulerError}`，含目标、状态、最后观察、确认脚本及后续动作 |
| `asyncWaits.action` | `{id,action}` | `check`、`pause`、`resume`、`cancel`、`acknowledge`；不允许批准自定义任务 |

完整目标 schema、CLI 示例及脚本契约以随应用分发的 [异步任务参考](../.agents/skills/harness-runtime/references/async-waits.md) 为准。CLI 提供 `ci|sdp|seatalk|sleep|custom --file FILE`；原 `create` 保留为经过同样校验的兼容入口。

CI／SDP 的成功和失败终态都通知用户并预填来源草稿，不提交 `turn/start`。用户已有文字、附件或折叠粘贴时保留原稿，在来源会话提供手动插入；结果先保存为未发送草稿，再登记已预填，恢复时按任务 ID 去重。SeaTalk 新回复、sleep 和获批自定义任务就绪后自动唤醒来源 Agent，忙时排队；后续操作沿用原授权。

自定义创建返回 `awaitingApproval`，待确认状态不运行脚本。来源会话和异步任务页均展示条件、cwd、脚本快照、检查频率和就绪后动作；没有倒计时或默认批准。仅 UI 专用 IPC `async_wait_review(id,revision,approve)` 可以决定，管理 API 不暴露批准能力。决定校验状态、修订号和脚本快照，执行前再次核对快照。拒绝、修改脚本或过期修订不能激活任务；重启保留提案。旧自定义任务在继续执行或恢复前转为待确认。

后台正常每5分钟检查；sleep 使用登记时间，支持未来一年，期限为唤醒时间后7天。普通等待／自定义获批后7天到期，最多64个活跃任务和提案。应用关闭或休眠时暂停，恢复后补查。检查器使用固定 CLI 的只读调用或获批 Python `-I`，30秒超时并终止进程组，stdout 限制8KiB；异常按2/4/8/16/30分钟退避，连续5次暂停。脚本以当前用户权限运行，不提供系统沙箱。

任务定义、脚本和摘要保存在 `~/.codex-harness/async-waits/` 原子文件中，SQLite 不保存这些正文。稳定版／开发版使用 OS 文件锁协调单个执行者。自动续跑在发起前重新核对来源 cwd、可用性及观察新鲜度，先持久化 `dispatching` 再发带 `clientUserMessageId`、`turnTrigger: async-wait` 的轮次。结果未知保留 `dispatching`／`uncertain`，不自动重发；由用户核对后结束记录。

实现：[原生调度](../src-tauri/src/async_waits/mod.rs)、[目标校验](../src-tauri/src/async_waits/target.rs)、[只读适配器](../src-tauri/src/async_waits/checkers.py)、[存储及审批](../src-tauri/src/async_waits/store.rs)、[任务页](../src/core/async-waits/AsyncWaitPanel.tsx)。

## 自带 CLI 与异步任务展示

`async-waits list` 列出任务；`async-waits get ID` 返回指定任务（含 `lastObservation` 和 `continuation`）；`async-waits create --file FILE` 创建任务，未显式填 `threadId` 时仅取来源进程的 `CODEX_THREAD_ID`，不使用界面选中会话。`check`、`pause`、`resume`、`cancel`、`acknowledge` 使用管理入口的原生操作。

续跑用户消息只携带任务标题和 ID，观察正文、后续动作及内部时间留在任务文件；Agent 通过 CLI 查询所需详情。保留外部观察与授权动作的边界，Harness 不把外部回复当作指令。后台仍复用原生调度、忙时排队和未知发送不重试机制。

异步任务 tab 使用与其他工作 tab 相同的会话输入框和折叠状态。卡片默认展示带文字的彩色状态、两行结果摘要，检查与到期时间在标题行右侧，窄屏换行；后续动作、最近观察和次要操作收进详情，页面默认筛选待处理任务。

验证：`python3 -m unittest discover -s .agents/skills/harness-runtime/tests -p 'test_*.py'`；原生加载可用 `node .agents/skills/harness-runtime/tests/verify-native.mjs` 在隔离 HOME 和 loopback 假模型下验证，包含未注册路径反例、真实副本加载和恢复，不调用真实模型。
