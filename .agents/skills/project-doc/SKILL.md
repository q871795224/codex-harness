---
name: project-doc
description: Use when working in a Codex Harness session bound to a project document (活文档 / 共享白板); read it before proposing changes to the shared project document, coordinating with other agents through it, or recording progress/decisions into it.
---

# 项目文档（活文档）协作协议

项目文档是多个 Agent 围绕同一目标协作的**共享中间态**。你不是唯一写者：其他 Agent 和人也会改它。本协议保证你的写入不覆盖别人、可被追溯。

文档落在 Harness 管理的目录，**你不能直接写文件**。你通过在输出里 emit 一个结构化提议块来表达"想改文档"，由 Harness 校验、经人审批后落盘。

## 文档分区

文档正文按分区组织（推荐约定，非强制 schema）：

| 分区 | 性质 | 你能怎么写 |
| --- | --- | --- |
| `Status` | 受控区：当前阶段、结论 | **必须带 `base_seq`**（见下），整段替换你的子区 |
| `Log` | 追加区：进展流水 | 追加一条，无需 `base_seq` |
| `Decisions` | 追加区：已拍板决定 | 追加一条（带你的 run 标识），无需 `base_seq` |
| `Open Questions` | 追加区：留给后续 Agent / 人的问题 | 追加一条，无需 `base_seq` |

多 Agent 并行时，Status 里每个活跃 run 有自己的子区，用 `### <run-id>: <一句标题>` 标识，**只改你自己的子区**，不动别人的。

## 提议格式：`<project-doc-update>`

想写文档时，在输出里 emit 一个块（头 + 空行 + 内容）：

```
<project-doc-update>
section: status
base_seq: 5

### run-abc: 实现速率限制改造
已完成代码改动，测试通过
</project-doc-update>
```

- `section`：目标分区，必填，取值 `status` / `log` / `decisions` / `openQuestions`。
- `base_seq`：**仅 `status` 必填**，填你读到的当前 `seq`（CAS：你基于哪个版本改）。追加区不要填。
- 头部与内容之间**必须有一个空行**。
- 一次输出可 emit 多个块，各自独立审批。

## 读：动手前先读

- 会话绑定项目时，文档正文和文件路径已注入你的初始上下文，里面标了当前 `seq`。
- **改 Status 前必须先 re-read 文档拿到最新 `seq`**——期间别人可能改过。追加区（Log 等）不要求先读。
- 需要最新内容时直接读文档文件（路径在初始上下文里）。

## 审批与冲突

- 你的提议会渲染成审批卡，**人确认后才落盘**。落盘后 `seq` 自动 +1。
- **提议即继续**：emit 提议后继续手头工作，不要把"文档已更新"当作后续步骤的前提。如果某次更新确实是前提（罕见），提议后结束本轮，等人确认再继续。
- **冲突**：你确认时 `base_seq` 已不是最新（别人先改了），提议进冲突态，人决定覆盖 / 放弃 / 回传给你。**收到回传时**：重新读最新文档，把你的意图合并进最新版本，再 emit 一个带新 `base_seq` 的提议。不要重发旧 `base_seq` 的提议。

## 纪律

- 不要绕过协议用 shell / 编辑器直接改文档文件——那会被检测为"协议外修改"并标记。
- 只追加别人的 Log / Decisions 之外，不要删改历史条目；纠错用新条目说明。
- 决策写"原因"，失败过的路明确标注，避免下一个 Agent 重蹈覆辙。
