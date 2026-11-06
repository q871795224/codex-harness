# Harness 项目上下文路由

根目录 `AGENTS.md` 是每次任务的最小必读规则。本目录采用渐进式披露：只读取与当前任务直接相关的文件，不要为了了解项目而一次性加载全部文档。

| 任务 | 文档 | 读取时机 |
| --- | --- | --- |
| 了解模块边界、IPC、App Server、插件和 daemon | [architecture.md](architecture.md) | 改动跨层流程、运行时或插件宿主前 |
| 从 Agent 查询或管理 Harness 本身 | [../docs/management.md](../docs/management.md) | 使用全局 codex-harness Skill、harnessctl 或维护本机管理入口时 |
| 记录已经确认的长期决策和当前状态 | [memory.md](memory.md) | 需要延续历史决策，或任务完成后沉淀结论 |
| 项目文档维护、会话中途新建/加入、注入与人工精简边界 | [architecture.md](architecture.md) 的“项目文档维护”；中途接入见 [project-doc-onboarding.md](../docs/project-doc-onboarding.md) | 修改项目文档插件或讨论 Agent 管理接口前 |
| 工作区自动选择、简介缓存、纠错案例、切换与后端评估 | [workspace-router.md](workspace-router.md) | 修改 Router 或重新讨论其决策前 |
| 执行测试、构建、人工检查和黑箱对照 | [test.md](test.md) | 修改代码或验证行为前 |
| 遇到已知的脆弱点、协议差异或数据安全问题 | [pitfall.md](pitfall.md) | 相关路径排查或修改前 |
| 在固定 UI 区域（侧栏底部操作行、顶部主按钮、会话 tab 栏）新增或修改样式 | [frontend-style.md](frontend-style.md) | 改动这些区域的结构、共用选择器组或深色主题前 |
| 使用 GitHub 分支、Pull Request、合并或衔接发布 | [github.md](github.md) | 开始交付、操作 PR 或准备 release 分支前 |
| 外部异步等待的创建、检查器契约与恢复行为 | [../docs/management.md](../docs/management.md) 的“异步等待” | 创建或维护异步任务、原生调度与自动续跑前 |
| 对齐 Agent 间协作（handover、luna 回传、接力、completion 语义） | [agent-interaction.md](agent-interaction.md) | 新增或修改成员、团队调度或任何 Agent 间交互能力前 |
| 对齐沟通术语，确认某个词（如标题栏、turn、item）具体指什么 | [glossary.md](glossary.md) | 沟通中出现名词歧义，或涉及协议概念与界面区域命名时 |

详细发布流程是低频工作，使用项目级 `.agents/skills/harness-release/SKILL.md`，不在普通任务中预加载。

Codex CLI/Harness 请求对照和 token 成本排查使用项目级 `.agents/skills/harness-codex-audit/SKILL.md`；它只在需要审计时加载。

新增稳定知识时，优先放入职责最匹配的文件；不要在多个文件复制同一条规则。临时排查结果只有在确认长期有用后才写入 `memory.md` 或 `pitfall.md`。
