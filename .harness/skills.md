# Harness Agent 能力接入与 Skill 分发

所有 Skill 的唯一维护源码保留在本仓库 `.agents/skills/`。需要在应用会话中使用的 Skill，由 Harness 随应用携带、按内容版本分发真实文件副本，并通过 Provider 原生 Skill 能力加载。Codex 新建的持久会话通过 App Server 动态工具维护项目文档，工具替代该会话的项目维护 Skill 主动加载；管理 Skill、旧 Codex 会话和 Claude 继续使用原生 Skill 链路。

## Agent 能力接入原则

新增 Agent 能力默认通过 Skill 提供操作流程、CLI 用法和按需参考资料，按任务需要加载和使用。已有 CLI 能通过业务参数或会话环境稳定定位目标时，沿用该入口。

采用自定义工具前，先确认以下条件：

1. 有明确的 Agent 调用需求，能够说清用户在什么任务中需要 Agent 执行该操作。
2. 操作目标依赖 Harness 维护的当前会话、项目或其他归属关系；让 Agent 自行定位会依赖额外注入的内部身份标记、手工传递的宿主 ID 或不可靠的界面状态。
3. 自定义工具能够由宿主可靠解析这些关系，解决实际定位问题。仅有工具扩展能力、参数中带 ID 或操作属于某个具体事项，都不足以触发迁移。

Harness 负责隐含身份与归属，Agent 负责业务参数。例如，当前项目由 Harness 根据 App Server 回调的会话 ID 查绑定；文档内容、条目 ID 和修订号仍由 Agent 根据任务及读取结果提供。来源会话以调用上下文为准，不使用界面当前选中的会话代替。

Skill 与自定义工具可以组合：Skill 说明复杂流程，工具只提供其中需要宿主解析身份的操作。新增工具仍复用既有业务服务、审批、版本校验和权限边界；不因接入新传输路径而扩大业务能力。

### 现有能力的接入选择

项目文档读写沿用已实现的原生工具，具体链路见下文“Codex 原生项目工具”。以下能力保持现有 Skill、CLI 或 UI 入口，不迁移为自定义工具：

- 异步等待的创建、查询与控制：CLI 传递来源会话，Harness 维护任务状态并在就绪后恢复来源会话；检查脚本与后续动作继续按需准备。
- 项目元数据读写：项目名称、简称等低频属性沿用现有入口。
- Router 记录与反馈：沿用日志、反馈界面和现有管理 CLI。
- 当前会话通知、重命名及作用域插件操作：沿用现有管理入口。

新建／加入项目保持现有实现，其触发与交互优化单独讨论，不纳入本次工具迁移。

## 当前范围

| 源码目录 | 用途 | App 分发 | App 主动加载 |
| --- | --- | --- | --- |
| `harness-runtime` | 应用设置、工作区/会话、Router、通知及异步等待管理 | 是，Codex | Codex 会话首次使用当前版本；排除标题、回顾、记忆提炼、路由判定及简介生成等后台任务 |
| `project-doc` | 已绑定会话的项目文档、决定和待办维护 | 是，Codex/Claude | 旧 Codex / Claude 绑定会话首次使用当前项目和资源版本；原生项目工具会话不主动加载 |
| `harness-release` | Harness 发布流程与恢复脚本 | 暂不接入 | 暂不接入，保留仓库开发用途 |
| `harness-codex-audit` | 请求、Token 与 Skill 原生加载验证 | 暂不接入 | 暂不接入，保留仓库开发用途 |

发布和成本审计属于低频开发维护用途，本期先保留源码，不加载进日常会话。以后如需应用内使用，再通过同一 App 托管链路接入，不新增软链安装路径。开发任务仍可按仓库路由读取这两份 Skill。

## 运行约定

- Skill、CLI、执行必需脚本和按需参考文档随应用编译；内容和资源路径参与版本计算。维护者的设计沿革、测试脚本不作为日常运行资源。
- Codex 的发现目录中存放版本化真实目录，例如 `skills/harness-runtime-<版本>`、`skills/harness-project-doc-<版本>`。由共享 daemon 发现后，Harness 采用其返回的规范路径，发送原生 `skill` 输入。App 决定是否主动加载，Codex 负责解析；不把正文拼入 developer instructions，也不替换共享 daemon 的 extraRoots。
- Claude 项目文档继续使用 App 自带的会话本地插件与原生调用；管理 Skill 尚未接入 Claude，不能把源码存在当成所有 Provider 都已支持。
- 共享 daemon 的其他客户端可以发现 Skill 元信息；这不改变 Harness 的主动加载条件。仅发送被 Provider 接受后保存加载标记，失败允许重试，恢复会话不重复主动加载同版本。
- 同版本副本逐文件核对内容，拒绝被修改或替换为软链的资源；旧版本文件保留供历史会话引用。项目文档旧链接和用户自行安装的 Skill 不作为新链路依赖，不覆盖用户文件。
- Agent 使用本次加载目录里的同版本命令。Git 合并不改变已运行 App 的内置资源，需后续构建安装新应用才生效。

分发实现为 `src-tauri/src/bundled_skill.rs`、`runtime_skill.rs`、`project_doc_skill.rs`，调用入口为 `app_server.rs` 和 `claude_runtime.rs`。管理操作见 [管理契约](../docs/management.md)，原生加载验证见 [验证记录](../docs/project-doc-native-skill-validation.md)。

## Codex 原生项目工具

`app_server.rs` 为新建的非 ephemeral 会话注册 `harness_project_read`、`harness_project_propose`、`harness_project_mutate_entry`。工具说明承担项目维护操作指引，参数不接受项目或会话 ID；`project_tools.rs` 使用 App Server 回调的 threadId 查 Harness 绑定。正文按需作为工具结果返回，输入区只附项目绑定后的读取提示，消息不附带项目全文、身份标记或项目维护 Skill。`harness-runtime` 管理 Skill 保留。

App Server 持久化工具定义并在恢复和 Fork 时继承；Harness 持久化注册标记，并在会话元数据中返回 `harnessProjectTools`。0.167.0 的 `thread/resume` 不接受 dynamicTools，旧会话继续使用兼容链路。验证与复现见 [原生项目工具验证](../docs/native-project-tools.md)。
