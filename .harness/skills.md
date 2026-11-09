# Harness 自有 Skill 的源码、分发与加载

所有 Skill 的唯一维护源码保留在本仓库 `.agents/skills/`。需要在应用会话中使用的 Skill，由 Harness 随应用携带、按内容版本分发真实文件副本，并通过 Provider 原生 Skill 能力加载。以后新增或接入应用的 Skill 都采用这条链路，不要求用户安装全局 Skill、创建软链或把 CLI 放到 PATH。

## 当前范围

| 源码目录 | 用途 | App 分发 | App 主动加载 |
| --- | --- | --- | --- |
| `harness-runtime` | 应用设置、工作区/会话、Router、通知及异步等待管理 | 是，Codex | Codex 会话首次使用当前版本；排除标题、回顾、记忆提炼、路由判定及简介生成等后台任务 |
| `project-doc` | 项目文档、决定和待办维护；会话中途新建/加入项目 | 是，Codex/Claude | 绑定项目的会话首次使用当前项目和资源版本；未绑定时可发现并按需申请接入 |
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
