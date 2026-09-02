# Harness 词表

团队沟通的统一术语表。提到本表中的词时，以本表定义为准，避免"标题栏"这类歧义。

## 归属图例

- **[协议]** = Codex App Server 传输协议原生概念（`app_server.rs` / RPC 方法 / 通知里的真实字段）
- **[Harness]** = 本仓库自定义概念，Codex 协议里没有
- **[UI]** = 前端界面区域或控件
- **[Claude]** = Claude Provider 侧概念（独立 daemon），仅用于对照

---

## 一、Agent / 协议层术语

### 1. 核心三词：thread / turn / item

这是协议层最重要的三个概念，呈包含关系：**一个 thread 里有多个 turn，一个 turn 里有多个 item**。

| 术语 | 归属 | 中文 | 定义 |
| --- | --- | --- | --- |
| **Thread** | [协议] | 会话 / 线程 | Codex App Server 的会话实体（`id/cwd/preview/status/turns`）。开启一个 thread = 开启一个多轮会话。协议方法 `thread/start`、`thread/resume` 等操作的都是它。见 `src/core/domain/codex.ts` |
| **Turn** | [协议] | 轮次 / 一轮 | 一次"用户输入 → Agent 处理 → 完成"的完整执行单元，有 `id/status/items`。发一条消息、Agent 跑到底（改文件、跑命令、给回答），这一整轮是一个 turn |
| **Item** | [协议] | 条目 | turn 内的**每一条具体内容/动作**，归属某个 `turnId`。注意：**用户的输入本身也是一个 item**（`userMessage`），不只是 Agent 的反馈。Agent 的一段回复、一次命令执行、一次文件改动、一段思考，各自是一个 item |

一个 turn 的典型内容：

```
turn
 ├─ item: userMessage       ← 用户输入(也是 item)
 ├─ item: reasoning         ← Agent 的一段思考
 ├─ item: commandExecution  ← 跑了一条命令
 ├─ item: fileChange        ← 改了个文件
 └─ item: agentMessage      ← Agent 的最终回答
```

item 类型取值：`userMessage` / `agentMessage` / `commandExecution` / `fileChange` / `reasoning` / `plan` / `mcpToolCall` / `dynamicToolCall` / `collabAgentToolCall` / `rawResponse`。

> 记法：turn 是"一轮"，item 是这一轮里的"每一格画面"。说"这条命令卡片""这个文件改动"指的就是某个 item。

### 2. event（与上面三词的区别）

| 术语 | 中文 | 定义 |
| --- | --- | --- |
| **Event** | 事件 | "发生的事情的通知"，不是数据实体，是一条"某事发生了"的广播。Agent 运行时服务端实时推送，前端靠监听 event 刷新界面（流式打字、进度条都靠它） |

- thread/turn/item 是**状态**（东西）；event 是**变动通知**（事情）。
- 典型 event：`turn/started`、`item/agentMessage/delta`（流式文本增量）、`item/completed`、`turn/completed`。
- 注意 event 分两层、同名不同层：**协议通知**（`item/started` 这类服务端推送）与 **Harness 内部 reducer 事件**（`ThreadDetailEvent`，如 `turnStarted`，是协议事件转换后的内部输入，见 `conversationEventReducer.ts`）。

### 3. 会话的三个叫法（thread / conversation / session）

| 术语 | 归属 | 指什么 |
| --- | --- | --- |
| Thread | [协议] | Codex 协议会话实体 |
| **Conversation** | [Harness] | UI 统一层的会话抽象（`ConversationView`、`selectedConversationId`），底下可能是 Codex thread 或 Claude session |
| Session | [Claude] | Claude provider 侧会话，id 前缀 `claude:` |

> 约定：日常说"会话"默认指 UI 上的 Conversation；涉及协议细节说 thread；明确 Claude 的才说 session。另：Codex 落盘的会话文件叫 `rollout`（`Thread.sessionId` 指向它），平时很少提到。

### 4. 插话 vs 排队（steer vs queue）

| 术语 | 中文 | 定义 |
| --- | --- | --- |
| `turn/steer` | **插话** | 往**正在进行**的 turn 追加输入，改变当前这轮（带 `expectedTurnId` 防止插错轮） |
| `thread/queue/*` | **排队** | 进服务端队列，等当前轮结束后作为**下一轮**跑 |

对应 UI：输入框右下角"后续消息行为"切换（排队 / 插话）。

### 5. Run vs Job（子 Agent，均为 [Harness]）

| 术语 | 中文 | 定义 |
| --- | --- | --- |
| **Job**（`QuickAgentJob`） | 快捷 Agent / 任务模板 | 保存好的快捷 Agent 配置（prompt/model/effort/工作区模式…），是"模板" |
| **Run**（`AgentRun`） | 运行实例 | 跑一次 job 产生的实例，底层对应一个真实的 Codex child thread + turn |

> job 是模板，run 是实例。"提交、推送并创建 MR"是一个 job；点一下跑出来的那次是一个 run。

### 6. 审批 / 权限

| 术语 | 中文 | 定义 |
| --- | --- | --- |
| ApprovalRequest | 审批请求 | 服务端发来要用户确认的（命令执行/文件改动/请求输入） |
| ApprovalPolicy | 审批策略 | `untrusted` / `on-request` / `never` |
| SandboxMode / SandboxPolicy | 沙箱模式 / 沙箱策略 | 前者是 UI 三态（`read-only`/`workspace-write`/`danger-full-access`）；后者是发到协议的判别联合。说"沙箱"时分清是 UI 态还是协议态 |
| **yoloMode** | 一把梭 / YOLO | [Harness] 派生概念：**审批策略 `never` 且沙箱 `danger-full-access` 两个条件同时满足**才算，非协议字段 |

### 7. 输入附件（UserInput 五种）

`text`（文本）/ `localImage`（本地图片）/ `mention`（文件提及，"@了个文件"）/ `skill`（技能引用，"用了个 $skill"）/ `image`（网络图片）。

### 8. 其他高频协议词

| 术语 | 中文 | 说明 |
| --- | --- | --- |
| App Server / daemon | 应用服务器 / 守护进程 | 同一个东西的两个角度：App Server 是程序（`codex app-server`），daemon 是它的常驻运行形态。Harness 关闭不停止它 |
| notification / server-request | 通知 / 服务端请求 | 前者是服务端纯推送（不用回）；后者带 `id` 要 Harness `respond` 应答（审批/输入） |
| turnTrigger | 轮次触发源 | [Harness] 给 turn 打的来源标签（普通对话/快捷 Agent/回传/标题生成），用于 token 成本分析 |
| MCP 状态 | — | **已启用 ≠ 已连接**；运行态：`notStarted/starting/connected/authenticationRequired/failed/cancelled/disabled` |

---

## 二、前端界面术语

### 1. 整体布局

```
┌─────────────────────────────────────────────────┐
│  原生标题栏(隐藏的拖拽条,28px,无文字)           │
├──────────┬──────────────────────────────────────┤
│          │  会话头部(会话名/路径/置顶/归档)      │
│          ├──────────────────────────────────────┤
│  侧边栏  │  页签栏(对话/轨迹/待办/用量…+连接状态)│
│          ├──────────────────────────────────────┤
│  品牌行  │                                      │
│  新会话  │         对话内容区(消息流)           │
│  会话列表│                                      │
│          ├──────────────────────────────────────┤
│  归档切换│  排队坞(排队消息/插话)               │
│  设置入口│  输入区(Composer)                    │
│          │  底部信息条(token/成本统计)          │
├──────────┴──────────────────────────────────────┤
│        右下:快捷 Agent 坞   左下:快捷命令坞      │
└─────────────────────────────────────────────────┘
```

### 2. 区域统一叫法（中文 ↔ 代码锚点）

**左侧：**

| 中文 | 代码 | 说明 |
| --- | --- | --- |
| **侧边栏 / 侧栏** | `<aside class="sidebar">`（`Sidebar.tsx`） | 整个左侧导航 |
| **品牌行** | `.brand-row` | 侧栏顶部 logo + "codex HARNESS" |
| **新会话按钮组** | `.new-chat-split` | 新会话 + Codex/Claude provider 切换 |
| **会话列表** | `.thread-list` / `.thread-row` | 中部会话条目（状态点+标题+时间） |
| **侧栏底部区** | `.sidebar-footer` | 归档切换 + 设置/插件入口 |

**中部主区（`.main-pane`）：**

| 中文 | 代码 | 说明 |
| --- | --- | --- |
| **会话头部** | `.thread-header`（`ConversationView.tsx`） | 会话名（可改名）/工作区/分支/路径/置顶/归档。**不要叫"标题栏"** |
| **页签栏** | `.tab-bar` | 对话/轨迹/待办/用量…页签 + 右侧连接状态（`.connection-state`） |
| **对话内容区** | `.conversation-pane` + `.conversation-scroll` | 消息流滚动区 |
| **输入区 / Composer** | `.composer-zone` + `.composer-card` | 底部输入框卡片 |
| **底部信息条** | `.conversation-stats` | token/成本/统计行 |

**角落浮层（统一叫"坞" dock）：**

| 中文 | 代码 | 说明 |
| --- | --- | --- |
| **快捷 Agent 坞** | `.quick-action-dock`（右下） | 运行快捷 Agent 任务（Run） |
| **快捷命令坞** | `.quick-command-dock`（左下） | 运行后台命令 |

**模态/弹层：**

| 中文 | 类型 | 说明 |
| --- | --- | --- |
| **设置对话框** | 居中模态 `.settings-dialog` | 左侧导航 + 右面板 + 底部版本条 |
| **插件设置对话框** | 居中模态 | 与设置对话框同一外壳的另一种形态 |
| 就地小浮层 | 弹层/菜单 | 视图排序弹层 `.navigation-options`、输入补全弹层 `.composer-suggestions`、发送行为菜单 `.follow-up-menu` |

> 命名规则：角落浮层叫「坞」，居中模态叫「对话框」，就地小浮层叫「弹层/菜单」。

### 3. "标题栏"歧义拆解（重点）

日常说"标题栏"可能指四个不同东西，**统一禁用"标题栏"一词**，改用：

| 想指的 | 统一叫法 | 代码 |
| --- | --- | --- |
| 窗口最顶拖动窗口那条 | **原生标题栏** | `.native-titlebar-drag-region` |
| 侧栏顶部 logo 行 | **品牌行** | `.brand-row` |
| 主区顶部会话名那行 | **会话头部** | `.thread-header` |
| 设置页里的标题 | **面板页标题** | `.settings-panel-head` |

### 4. 易混的"栏"对比

- **侧边栏**（左，导航）≠ **页签栏**（会话头部下的 tab 条）≠ **会话头部**（`.thread-header`）≠ **输入框底栏**（`.composer-footer`，输入框里那排控件）≠ **底部信息条**（`.conversation-stats`，输入框下方统计行）
- 应用没有传统 status bar；状态相关的是 `.status-dot`（状态点）和 `.connection-state`（连接状态）。

### 5. 输入区（Composer）内部

| 中文 | 代码 | 说明 |
| --- | --- | --- |
| 输入框 | `<textarea>` | 消息输入本体 |
| **输入框底栏** | `.composer-footer` | 左侧：附件+、审批模式下拉、YOLO、Fast；右侧：RAW、插件动作、模型/推理强度、上下文环、发送钮 |
| 自动补全弹层 | `.composer-suggestions` | @文件 / $Skill / /命令 |
| **排队坞** | `.queue-dock`（`QueueDock.tsx`） | 输入框上方的排队消息/插话区 |

### 6. 对话区内的"卡片"

| 中文 | 代码 |
| --- | --- |
| 消息气泡 | `.user-message` / `.agent-message` |
| 工具卡片 | `.tool-card`（命令卡/文件卡/MCP 卡/子 Agent 活动卡） |
| 审批卡片 | `.approval-card`（"允许一次/本会话允许/拒绝"） |
| 执行过程折叠组 / 最终回答区 | `.process-group` / `.final-answer` |

---

## 三、跨层易混概念速查

| 易混 | 区分 |
| --- | --- |
| thread / conversation / session | 协议实体 / UI 统一抽象 / Claude 会话 |
| turn / item / event | 一轮 / turn 内每一条（含用户输入）/ 实时变动通知（还分协议通知与内部 reducer 事件两层） |
| run / job | 运行实例 / 任务模板 |
| steer / queue | 插进当前轮 / 排队等下一轮 |
| SandboxMode / SandboxPolicy | UI 三态 / 协议判别联合 |
| "标题栏" | 禁用；拆成：原生标题栏 / 品牌行 / 会话头部 / 面板页标题 |
| 快捷 Agent 坞 / 快捷命令坞 | 右下跑 Agent / 左下跑命令 |
| MCP 已启用 / 已连接 | 配置开了 ≠ 真的连上了 |
| YOLO | 审批 `never` + 沙箱 `danger-full-access`，缺一不可 |

---

## 关键源文件索引

- 传输协议唯一入口：`src-tauri/src/app_server.rs`
- 共享领域类型：`src/core/domain/codex.ts`
- 协议方法客户端：`src/core/runtime/appServerClient.ts`
- IPC 桥：`src/core/runtime/bridge.ts`
- 协议事件分发：`src/features/conversation/useHarness.ts`（handleEvent）
- 界面骨架：`src/App.tsx`；侧栏 `src/features/navigation/Sidebar.tsx`；对话区与输入区 `src/features/conversation/ConversationView.tsx`、`Composer.tsx`、`QueueDock.tsx`；设置 `src/features/settings/SettingsDialog.tsx`
