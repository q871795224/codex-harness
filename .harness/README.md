# Harness 项目上下文路由

根目录 `AGENTS.md` 是每次任务的最小必读规则。本目录采用渐进式披露：只读取与当前任务直接相关的文件，不要为了了解项目而一次性加载全部文档。

| 任务 | 文档 | 读取时机 |
| --- | --- | --- |
| 了解模块边界、IPC、App Server、插件和 daemon | [architecture.md](architecture.md) | 改动跨层流程、运行时或插件宿主前 |
| 记录已经确认的长期决策和当前状态 | [memory.md](memory.md) | 需要延续历史决策，或任务完成后沉淀结论 |
| 执行测试、构建、人工检查和黑箱对照 | [test.md](test.md) | 修改代码或验证行为前 |
| 遇到已知的脆弱点、协议差异或数据安全问题 | [pitfall.md](pitfall.md) | 相关路径排查或修改前 |

详细发布流程是低频工作，使用项目级 `.agents/skills/harness-release/SKILL.md`，不在普通任务中预加载。

Codex CLI/Harness 请求对照和 token 成本排查使用项目级 `.agents/skills/harness-codex-audit/SKILL.md`；它只在需要审计时加载。

新增稳定知识时，优先放入职责最匹配的文件；不要在多个文件复制同一条规则。临时排查结果只有在确认长期有用后才写入 `memory.md` 或 `pitfall.md`。
