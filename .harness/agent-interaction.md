# Agent 交互范式

定义 Harness 内多个 Agent 协作的语义、现有接口与实现边界。模式描述协作目标；标为规划的能力不作为已实现接口使用。

术语以 [glossary.md](glossary.md) 为准；本文只定义范式，具体命令/面板实现见各自功能代码。

## 一、三种交互模式

按"主权是否转移"和"是否需要回传"区分。三者本质不同、协议不同，不要混用。

### 模式 A：主从 · 单次（fire-and-forget / 委托）

一次性把繁琐任务交给子 Agent，**主 Agent 不关心返回值**，出问题由用户自己看。

- 关系：委托，一次性。
- 结果流向：用户自己看（或一个 toast 通知）。
- 主 Agent 状态：不受影响。
- 关键机制：发起 + 工作区隔离。
- 对应实现：快捷 Agent 坞里的 Job / Run。

### 模式 B：主从 · 带反馈（delegate / 委托-回传）

把任务派给子 Agent，**结果必须回传给主 Agent 验收**，可能多轮返工。luna 开发模式是代表。

- 关系：委托，**多轮**。
- 结果流向：回传给主 Agent（经人审批）。
- 主 Agent 状态：**活着，等待验收**。
- 关键机制：**回传通道 + 会话归属（链接元数据 + 状态机）**。
- 对应实现：luna 线程。

> **实现取向：路线 B（Harness 纳管）已落地。** 子 Agent 是与主会话**平级**的独立 Codex thread，由 `agentRuns.start({ mode: 'delegated' })` 创建，编排者是 Harness + 人，不是主 Agent。**不走**模型自治的 collab spawn（`collabAgentToolCall`）——那是模式 A 的变体，主 Agent 自主编排并被等待阻塞，与本模式"Harness 编排、Agent 平级互不可见"相悖。luna 插件（`src/plugins/luna`）注册 quickAction，触发 delegated run；回传走 `DelegationReturnCard`（注入/查看/忽略 + 验收意见反向回传），全程塞草稿经人审批、不自动发 turn。

### 模式 C：接力 / 继任（relay / succession）

一个会话干不完（上下文满、聊得太多、或冷却太久担心缓存失效），把**状态快照**交给下一个会话继续，上一棒退役、不回头。

- 关系：继任，主权转移。
- 结果流向：变成下一棒的**初始上下文**。
- 主/旧会话结局：**退役**，新会话接管。
- 关键机制：**交接文档**（自包含，不依赖上一棒会话）。
- 当前入口：`/handover` 命令。提示词插件的接力链仍属规划；旧会话不会自动退役或归档。

> 关键区分：模式 B 的核心难题是"回传"，模式 C 的核心难题是"交接文档"。两者机制骨架相同（spawn + 注入 + completion），但 completion 语义相反。

## 二、六条不变式

无论哪种模式都成立，是范式的地基：

1. **单向数据流，plugin 不直连 App Server。** 一切 Agent 间交互经由 Harness 核心（Rust/bridge）。子 Agent 不能把消息直接塞进主 Agent 会话；用户与 Harness 是唯一编排者，普通委派中 Agent 之间不自治互发；团队模式按第八节、路由会话按第十节的受控调度运行。
2. **每次 run 只绑定一个发起 thread。** 记录 origin；handover 这类 succession 强制一对一，禁止广播。
3. **普通委派回传必须由用户触发。** 回传卡先填输入草稿，用户确认后发送；旧快捷回传按钮由用户点击后直接启动父会话一轮，并拒绝 active 父会话。子 Agent 不自行写主 Agent 上下文。团队内部结果由核心组装到下一次独立执行，不注入用户主会话，最终结果仍由人验收。例外：路由会话派出的轮次结束后，由核心自动把子会话汇报回调给路由会话（第十节）。
4. **交接产物是自包含文档，不是会话引用。** 新 Agent 靠文档冷启动，不需回读上一棒会话。会话绑定只用于血缘追溯，不用于取内容。
5. **交互语义与接口分别定义。** 快捷 Job 的 `completion` 当前只有 `detached / return-to-parent`；核心 Run 的 `mode` 是 `detached / delegated`。`succession` 描述 handover 的接力语义，尚无统一 completion 枚举。
6. **成本记账是结构一部分。** 每个模式要能讲清谁付 token、省在哪，作为选型依据而非事后分析。

## 三、现有接口与完成语义

| 层次 | 字段或入口 | 当前行为 |
| --- | --- | --- |
| 快捷 Job | `completion: detached / return-to-parent` | 独立查看；或完成后允许用户手动回传 |
| 核心 Agent Run | `mode: detached / delegated` | 后者必须有父会话；快捷 Job 的 `return-to-parent` 映射为 `delegated` |
| 委派回传卡 | `buildReturnDraft / markReturned / childThreadForFeedback` | 结果与验收意见先填入目标草稿，用户发送 |
| 旧快捷回传 | `returnToParent` | 用户点击后直接启动父会话一轮；父会话 active 时拒绝，成功后记录一次回传 |
| 接力 | `/handover` | 单独生成文档并填入新会话草稿，不经过统一 completion 字段 |

`silent / notify / return-to-parent / succession` 是早期统一枚举方案，尚未整体落地。新增调用应使用 [Run 类型](../src/core/agent-runs/types.ts) 与 [快捷 Job 配置](../src/plugins/quick-agent/config.ts) 的实际字段。普通委派不自动形成父子验收循环。

## 四、模式 B（luna）全流程与状态机

### 当前链路

```text
用户启动 delegated run → 独立子会话执行
  → 完成后显示回传卡 → 用户注入主会话草稿 → 用户发送并验收
  → 在卡片填写意见 → 填入子会话草稿 → 用户发送后继续
```

主会话自由执行，不轮询子会话；卡片由 Run 状态更新驱动。子到主方向提供注入、查看和忽略；主到子方向使用卡片里的意见输入框。消息级“回传给 Luna”按钮仍未实现。

[AgentRun](../src/core/agent-runs/types.ts) 持久化 `runId`、`parentThreadId`、`childThreadId`、执行 `status` 和 `returnedAt`。卡片的“等待验收”、忽略状态和未发送意见是组件本地状态；旧设计中的 `executing / awaiting-review / feedback-delivered / closed` 尚不是独立持久状态机。

### 内容与恢复边界

- 父子是平级独立会话，`parentThreadId` 只记录归属，不自动共享父会话历史。[Luna 启动器](../src/plugins/luna/index.tsx) 当前发送固定实施请求，尚未自动附上主会话已对齐的技术方案；不能依赖它自动交接完整需求。
- 成功注入或忽略后保存 `returnedAt`，同一 Run 不重复提供首次结果。失败 Run 只提供查看或忽略。手动意见继续由用户发送，不自动重置为新的验收循环。
- 来源会话归档后的自动“仅查看”降级、持久验收状态和消息级意见选择仍是待完善能力。恢复或新增入口时需显式处理，不能把旧设计的状态图当作已有保障。

实现与校验入口：[运行服务](../src/core/agent-runs/service.ts)、[回传卡](../src/features/conversation/DelegationReturnCard.tsx)。

## 五、模式 C（handover）机制与存储

### 当前 handover 链路

```
主Agent按模板生成总结 → Harness补充确定性工作区状态(零token)
  → 渲染交接文档 → 开启新会话并把文档注入其输入草稿(不自动发送)
  → 新会话继承工作区；旧会话保留，文档头记录来源
```

- 总结先进入未发送草稿，用户可审查、编辑并决定发送时机；草稿按核心 Composer 规则保存到 `state.sqlite`，发送成功后清除。交接文档另存文件，不复制已发送会话正文到状态库。
- 确定性部分（git 分支、改动文件、工作区路径）由 Harness 用占位符填充，不花模型 token。
- 主 Agent 的总结输出用 `<handover-summary>` 标记包裹，Harness 按标记提取，不依赖自然语言解析。

### 存储边界（沿用 state.sqlite 边界）

- **交接文档 → 文件**：`~/.codex-harness/handover/<doc-id>.md`。正文和文件头保存在文件中；需要引用时沿用普通文件路径输入。新会话的未发送草稿副本使用核心草稿持久化。
- **簿记元数据 → Harness 生成的文件头**：doc id、源会话、模板版本、时间戳、工作区/分支以 YAML front matter 写在文档头部（`renderHandoverFrontMatter`），**不进模板、不进新会话草稿**——新 Agent 只看正文，血缘簿记是 Harness 自己的事。state.sqlite 侧元数据（含旧会话 `handed_over_to`）尚未实现。
- 血缘：当前由文档头 `continued_from: <old-thread-id>` 承载；旧会话元数据记 `handed_over_to: <new-thread-id>` 是设计目标，待补。
- draft 注入时把**正文**（不含文件头）**拷贝**进草稿（非引用），用户编辑只影响草稿，文件保持官方版本。

### 模板

- 两个文件，均在 `~/.codex-harness/templates/`：
  - `handover.prompt.md` —— 发给主 Agent 的总结指令（控制"怎么总结"）；
  - `handover.template.md` —— 正文骨架（控制"新 Agent 看到什么"，含占位符）。
- 默认值内置在代码里，首用时物化到该路径，之后归用户所有；设置对话框新增 `templates` 面板可编辑。
- 模板占位符（正文）：`{{title}}` / `{{workspaceRoot}}` / `{{gitBranch}}` / `{{changedFiles}}` 由 Harness 填充；`{{summary}}` 由主 Agent 输出填充。簿记占位符（`{{docId}}` / `{{sourceThreadId}}` / `{{createdAt}}` / `{{templateVersion}}`）v2 起移出模板，由 Harness 直接生成文件头。
- 当前 handover 使用这份模板；提示词接力共用模板是后续接入约定，接力链 UI 尚未实现。

实现入口：[useHandover.ts](../src/features/handover/useHandover.ts)、[文档渲染](../src/features/handover/document.ts)、[草稿持久化](../src/features/conversation/composerDraftStorage.ts)。

## 六、提示词接力 = 交接文档的可选载体

以下为接力链的后续设计，当前没有完整实现。提示词插件拟作为交接文档的载体与版本链，不承担 Agent 编排：

- 持有的是结构化交接文档（同一模板），每完成一棒追加一段，形成接力链。
- **消费侧唯一原语是"注入输入框（经审批）"**；挂进接力链是可选增强，不强制。
- 不绑插件：跨项目或未装提示词插件时，handover 文档仍可独立注入。

## 七、已实现与待完善范围

**Handover 已实现**：主 Agent 总结、工作区状态补充、文档文件、继承工作区的新会话草稿。来源血缘记录在文档头；双向会话链接和旧会话自动退役尚未实现。

**委派已实现**：

- **luna 回传运行时**：`DelegationReturnCard`（`src/features/conversation/DelegationReturnCard.tsx`）——delegated run 完成时出现在发起会话输入框上方，提供注入（塞草稿经审批）/查看/忽略；注入后进入等待验收态，可输入意见**反向回传**子 Agent 草稿。事件由 agent-runs 的 run 完成状态驱动，无轮询。
- **底层共享机制**：`AgentRunService` 新增 `buildReturnDraft` / `markReturned` / `childThreadForFeedback`（塞草稿而非直接发 turn，落实不变式 3）；spawn + 注入 + origin 元数据复用既有 agent-runs。
- **Luna 纳管为路线 B**：`src/plugins/luna` 改为注册 quickAction 触发 delegated run。

**后续能力**：

- 提示词接力链 UI（交接文档挂链、版本链可视化）。
- 独立临时 Agent 总结路径（上下文已接近满、主 Agent 会先触发 compact 时）。
- 底层机制进一步抽象（把 handover v1 重构进共享 spawn/注入原语）。
- 消息级“回传给 Luna”、持久验收状态、归档来源降级，以及 Luna 启动时显式传递实施材料。当前卡片的意见输入框仅负责草稿回传。

**普通委派保持人工回传**；用户启动的团队任务按下述规则允许有限自动协作。


## 八、成员与团队任务

用户可以直接指派成员，也可以把任务交给团队队长。身份、任务和一次执行分别管理：成员保存职责与配置；任务保存目标、名单快照、预算和验收状态；每次执行仍由 `harness.agentRuns` 创建独立会话。

| 环节 | 行为 |
| --- | --- |
| 创建 | 保存任务说明和成员配置快照，不调用模型 |
| 启动 | 用户授权本任务有限自动执行；不扩大合并、发布、外部发送权限 |
| 派发 | 队长只读，每轮最多指定一个名单内成员；核心校验结构化决策后启动 |
| 工作区 | 首次写任务创建隔离 worktree，后续成员沿用本任务工作区；同任务顺序执行 |
| 结果 | 核心读取已完成执行的结果供队长判断，不能靠模型输出直接宣告完成 |
| 预算 | 每次队长和成员执行都计数，重复派给同一成员计返工；时间窗口到期中断活动执行并暂停 |
| 暂停与停止 | 停止后续调度并请求中断活动执行，保留分支、工作区和记录 |
| 重启 | 不自动继承调度所有权；用户检查后继续，存在活动执行时禁止重复接管 |
| 验收 | 队长只能提交待验收；用户决定通过或填写返工意见 |

调度记录先落文件，再启动 Agent。文件写入比较版本并通过 SQLite 写锁协调窗口，冲突时停止调度，不覆盖更新的状态。未经确认的启动状态不自动重放。队长输出解析失败、指定未知成员、预算耗尽或成员失败时暂停并显示原因。

成员记忆分为通用经验与来源工作区经验，正文保存为 Markdown。每次执行只读取当前成员的这两个范围；隔离 worktree 使用任务的来源工作区作为记忆归属。结果保存为记忆需用户编辑并确认，职责指令不由结果自动改写。此范围选择属于上下文管理，不宣称构成宿主文件访问权限隔离。

此处的预算是执行次数、返工次数和时间窗口，不承诺 Token 或费用硬上限。应用关闭后运行时可能继续当前执行，桌面调度与时间检查暂停，重启必须人工接管；需要常驻调度时应迁移到原生服务，不以 UI 定时器承诺离线运行。

## 九、外部异步等待

外部异步等待使用 `asyncWaits.*`，由 Harness 原生调度。CI / SDP 终态只通知并预填来源会话草稿，不自动发送；SeaTalk、sleep 和获用户批准的自定义任务按登记动作自动继续来源会话，忙时等待空闲，不自动插话。自定义检查器必须经过界面审批。上述行为不改变普通 Agent 委派的人工回传规则，也不扩大后续外部操作授权。生命周期、存储和发送去重见 [架构](architecture.md#异步等待) 与 [管理契约](../docs/management.md)。

## 十、路由会话（relay）

路由会话是用户主动新建的一类 Codex 会话：用户只跟它说话，它把事情拆给若干子会话去做，并整理子会话结果。参考 DeepSeek Super-agent 的 Router / Worker 分层，Router 只路由、不干活、不轮询。

- 入口：侧栏「新会话」旁的路由会话按钮。会话固定在 `~/.codex-harness/workspaces/relay`，不走工作区自动选择；普通会话不能转成路由会话。
- 能力只在创建时注入：原生层在 `thread/start` 识别该目录，注册 `harness_session_spawn / send / read / list` 四个 dynamicTools，并写入固定 `developerInstructions`。`developerInstructions` 只在一次加载内有效，路由会话每次 `thread/resume` 由原生层补传。子会话和普通会话不注册这组工具，因此不会再开孙会话。
- 子会话是普通会话，只记录父子关系（`relayParent:` / `relayChildren:`），沿用父会话保存的审批与沙箱设置；派发正文由核心加上来源说明和汇报格式提示。
- 回调：只有路由会话经 spawn/send 发出的那一轮会回调。核心登记内部异步等待 `Target::Session`，子会话 `turn/completed` 后立即检查，父会话忙时排队、不插话，多个子会话同时完成合并为一轮。IPC/CLI 不能创建该类型。用户直接在子会话里的对话不回调，路由会话用 read 查看。
- read 由核心记录已读位置：默认返回未读轮次（含用户直接对话），每轮只有请求和最终回复，`all=true` 查看最近历史；回调送达的轮次视为已读。
- 界面：侧栏把子会话挂在路由会话行下（跨工作区）；主面板右侧 `RelayDock` 在路由会话里列子会话及状态点，在子会话里提供返回入口，样式约束见 [frontend-style.md](frontend-style.md#右侧路由会话跳转栏)。
- 受控范围：同一路由会话最多 6 个子会话同时等待回调；父会话本轮被中断不影响子会话回调，父会话归档/删除则暂停。自动回调不授权合并、发布或扩大外部操作。

待办：

- Claude Provider 尚无 dynamicTools，下一期补路由会话：工具改走 runtime Skill + harnessctl 子命令，回调复用同一 `Target::Session`。
- 子会话汇报格式（`relay_sessions::REPORT_FORMAT`）和回调内容截断长度先用宽松版本，需按实际使用效果专门调整一次。
