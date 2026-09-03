# Agent 交互范式

定义 Harness 内"多个 Agent 之间如何协作"的统一范式。目的是让 handover、luna、快捷 Agent、提示词接力等能力共享同一套底层机制与术语，而不是各自发明一套。

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
- 对应实现：handover 命令；提示词插件的接力链。

> 关键区分：模式 B 的核心难题是"回传"，模式 C 的核心难题是"交接文档"。两者机制骨架相同（spawn + 注入 + completion），但 completion 语义相反。

## 二、六条不变式

无论哪种模式都成立，是范式的地基：

1. **单向数据流，plugin 不直连 App Server。** 一切 Agent 间交互经由 Harness 核心（Rust/bridge）。子 Agent 不能把消息直接塞进主 Agent 会话；用户与 Harness 是唯一编排者，Agent 之间不自治互发。
2. **每次 run 只绑定一个发起 thread。** 记录 origin；handover 这类 succession 强制一对一，禁止广播。
3. **回传必须经人审批。** "塞输入框"是唯一允许的注入原语；任何自动入正文的行为都要过人这道闸。子 Agent 永不直接写主 Agent 上下文。
4. **交接产物是自包含文档，不是会话引用。** 新 Agent 靠文档冷启动，不需回读上一棒会话。会话绑定只用于血缘追溯，不用于取内容。
5. **完成语义是枚举**：`silent / notify / return-to-parent / succession`，每次 run 显式声明。现有 `detached` 归并为 `silent`/`notify` 的展示形态；`succession` 即 handover。
6. **成本记账是结构一部分。** 每个模式要能讲清谁付 token、省在哪，作为选型依据而非事后分析。

## 三、completion 枚举

| completion | 含义 | 用于 |
| --- | --- | --- |
| `silent` | 跑完即止，不通知 | 模式 A，用户自查 |
| `notify` | 跑完发 toast / 卡片，但不回传正文 | 模式 A 想被提醒时 |
| `return-to-parent` | 完成后回传给发起会话，**经人审批注入** | 模式 B（luna） |
| `succession` | 生成交接文档，开启继任会话，旧会话退役 | 模式 C（handover / 接力） |

`return-to-parent` 只能由用户在子任务完成后**手动回传一次**；父会话有 active turn 时必须拒绝，不得自动形成父子多轮循环（沿用既有约束）。多轮 = 多次"一键 + 审批"，不是自动循环。

## 四、模式 B（luna）全流程与状态机

### 流程

```
聊方案(主会话) → 主Agent写技术方案 → [一键"交给Luna"] Harness唤起Luna线程+注入方案
  → Luna执行(主会话自由,无轮询)
  → Luna完成 → Harness事件感知 → 主会话生成回传卡片[注入/查看/忽略]
  → [人审批]注入主会话草稿 → [人发送] → 主Agent验收产出意见
  → [消息级"回传给Luna"]意见注入Luna输入框(同一run唤醒) → 回到"Luna执行"
```

- 发起时主会话**零注入**：方案就是主 Agent 那个 turn 的普通输出，delegation 关系由链接元数据承载，不靠往输入框塞文本建立。
- 全程无轮询：Luna→主会话方向由 run 完成事件驱动。

### 链接元数据（打在会话上的标签）

```
{ runId, originThreadId, state, createdAt }
state ∈ executing | awaiting-review | feedback-delivered | closed
```

状态机驱动 UI，决定"什么时候出现什么按钮"：

| state | 主会话 UI |
| --- | --- |
| `executing` | 方案消息上挂"Luna #run-xxx 执行中"标记（UI 态，非注入） |
| `awaiting-review` | 输入框上方常驻 chip"Luna 等待验收"，assistant 消息出现"回传给 Luna"操作 |
| `feedback-delivered` | chip 消失，回到 executing |
| `closed` | 链路结束 |

### 方向不对称（重要）

- **Luna → 主会话**：run 完成是明确事件，Harness **自动生成**回传卡片。
- **主会话 → Luna**：没有可挂的"事件"（主 Agent 一直在聊，Harness 无从知道哪句是验收），**不自动生成意见卡片**。靠"常驻 chip 提醒 + 消息级回传按钮"，由**人显式指定哪条消息是验收意见**。

**Harness 不区分闲聊与 review 意见，也不应区分。** 拒绝的替代方案：不让模型自我声明"这是 review"、不做内容分类、不做关键词触发。路由永远由人显式选择。

### 幂等与降级

- 一条回传只注入一次，注入后状态固化，防止闲聊被重复塞进 Luna。
- origin 会话已归档/删除时，回传卡片降级为"仅查看"并提示发起会话不可写。

## 五、模式 C（handover）机制与存储

### 机制（与 luna 共享底层，不同 completion）

```
主Agent按模板生成总结 → Harness补充确定性工作区状态(零token)
  → 渲染交接文档 → 开启新会话并把文档注入其输入草稿(不自动发送)
  → 绑定工作区 → 双向血缘标记 → 旧会话退役
```

- 总结进**草稿**、不自动发送：用户可审查/编辑/决定发送时机；草稿正文不落库。
- 确定性部分（git 分支、改动文件、工作区路径）由 Harness 用占位符填充，不花模型 token。
- 主 Agent 的总结输出用 `<handover-summary>` 标记包裹，Harness 按标记提取，不依赖自然语言解析。

### 存储边界（沿用 state.sqlite 边界）

- **正文 → 文件**：`~/.codex-harness/handover/<doc-id>.md`。内容类不进库，可直接编辑、可被接力追加、可被 `mention` 引用。
- **元数据 → state.sqlite**：doc id、源/目标会话、工作区绑定、模板版本、状态、时间戳、血缘链接。
- 血缘：旧会话元数据记 `handed_over_to: <new-thread-id>`；新文档头记 `continued_from: <old-thread-id>`。
- draft 注入时把文件内容**拷贝**进草稿（非引用），用户编辑只影响草稿，文件保持官方版本。

### 模板

- 两个文件，均在 `~/.codex-harness/templates/`：
  - `handover.prompt.md` —— 发给主 Agent 的总结指令（控制"怎么总结"）；
  - `handover.template.md` —— 文档骨架（控制"长什么样"，含占位符）。
- 默认值内置在代码里，首用时物化到该路径，之后归用户所有；设置对话框新增 `templates` 面板可编辑。
- 占位符：`{{gitBranch}}` / `{{changedFiles}}` / `{{workspaceRoot}}` / `{{docId}}` / `{{sourceThreadId}}` / `{{createdAt}}` / `{{templateVersion}}` / `{{title}}` 由 Harness 填充；`{{summary}}` 由主 Agent 输出填充。
- handover 与提示词接力**共用同一交接文档模板**。

## 六、提示词接力 = 交接文档的可选载体

提示词插件收窄为"交接文档的载体与版本链，**不含 agent、不含编排**"：

- 持有的是结构化交接文档（同一模板），每完成一棒追加一段，形成接力链。
- **消费侧唯一原语是"注入输入框（经审批）"**；挂进接力链是可选增强，不强制。
- 不绑插件：跨项目或未装提示词插件时，handover 文档仍可独立注入。

## 七、范围

**一期（本次实现）**：handover v1 + 本范式文档 + 模板。

- 主 Agent 总结 → Harness 补工作区状态 → 新会话草稿 + 工作区绑定 + 血缘标记。
- 不抽象通用 spawn 原语，怎么快怎么来。

**二期（已落地）**：

- **luna 回传运行时**：`DelegationReturnCard`（`src/features/conversation/DelegationReturnCard.tsx`）——delegated run 完成时出现在发起会话输入框上方，提供注入（塞草稿经审批）/查看/忽略；注入后进入等待验收态，可输入意见**反向回传**子 Agent 草稿。事件由 agent-runs 的 run 完成状态驱动，无轮询。
- **底层共享机制**：`AgentRunService` 新增 `buildReturnDraft` / `markReturned` / `childThreadForFeedback`（塞草稿而非直接发 turn，落实不变式 3）；spawn + 注入 + origin 元数据复用既有 agent-runs。
- **Luna 纳管为路线 B**：`src/plugins/luna` 改为注册 quickAction 触发 delegated run。

**三期（backlog，不进本次）**：

- 提示词接力链 UI（交接文档挂链、版本链可视化）。
- 独立临时 Agent 总结路径（上下文已接近满、主 Agent 会先触发 compact 时）。
- 底层机制进一步抽象（把 handover v1 重构进共享 spawn/注入原语）。
- 消息级"回传给 Luna"操作（穿透消息列表的逐条回传，当前由卡片的反向输入框承载）。

**显式不做**：任何"自动多轮循环"。
