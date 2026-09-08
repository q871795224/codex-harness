---
name: project-doc
description: Use when working in a Codex Harness session bound to a project document (活文档 / 共享白板); read it before proposing changes to the shared project document, coordinating with other agents through it, or recording progress/decisions into it.
---

# 项目文档（活文档）协作协议

项目文档是多个 Agent 围绕同一目标协作的**共享中间态**。你不是唯一写者：其他 Agent 和人也会改它。本协议保证你的写入不覆盖别人、可被追溯。

文档落在 Harness 管理的目录，**你不能直接写文件**。你用 skill 自带的 `project-doc` 命令把写意图回传给本机 Codex Harness，由 Harness 校验、经人审批后落盘。

## 你的会话标识

绑定项目的会话，首轮消息会注入项目文档正文，正文开头有一行机器可读标记：

```
<!-- project-doc: project_id=<项目ID> thread_id=<会话ID> -->
```

调用 `project-doc` 命令时，`--project-id` 和 `--thread-id` 用这行里的值。命令会校验该项目确实绑定在该会话上；传错会被拒绝。

## 文档分区

文档正文按分区组织（推荐约定，非强制 schema）：

| 分区 | 性质 | 你怎么写 |
| --- | --- | --- |
| `Status` | 受控区：当前阶段、结论 | `project-doc propose --section status`，**整段替换你的子区**；需经人审批 |
| `Log` | 追加区：进展流水 | `project-doc propose --section log`，追加一条，免审批直落盘 |
| `Decisions` | 追加区：已拍板决定 | `project-doc propose --section decisions`，追加一条（带你的 run 标识），免审批 |
| `Open Questions` | 追加区：留给后续 Agent / 人的问题 | `project-doc propose --section openQuestions`，追加一条，免审批 |

多 Agent 并行时，Status 里每个活跃 run 有自己的子区，用 `### <run-id>: <一句标题>` 标识，**只改你自己的子区**，不动别人的。

## 写：用 `project-doc propose`

```bash
# 追加一条进展（Log 区，免审批，立即落盘）
project-doc propose --thread-id "$THREAD_ID" --project-id "$PROJECT_ID" \
  --section log --content "跑完测试，全绿"

# 提议更新 Status（受控区，进审批卡，人确认后才落盘）
project-doc propose --thread-id "$THREAD_ID" --project-id "$PROJECT_ID" \
  --section status --file /tmp/status.md
```

- `--section` 取值 `status` / `log` / `decisions` / `openQuestions`。
- 内容用 `--content`（单行）或 `--file`（多行正文）或标准输入提供。
- **不用管版本号（`base_seq`）**：Harness 收到提议时按当前 seq 自动处理。status 进审批队列；追加区直接落盘。
- 提交后立即返回，**不阻塞你**：status 提议等人确认；追加区已生效。提议即继续，不要把"文档已更新"当作后续步骤的前提。

## 读：动手前先读

```bash
project-doc read --thread-id "$THREAD_ID" --project-id "$PROJECT_ID"
```

- 返回当前**正文 + seq**。改 Status 前建议先读一次，确认最新全貌（期间别人可能改过）。
- 首轮注入的正文也是背景；要最新 seq 或不确定时，以 `read` 的结果为准。追加区（Log 等）不要求先读。

## 审批与冲突

- **status 提议**会渲染成审批卡，**人确认后才落盘**，落盘后 `seq` 自动 +1。
- **冲突**：你确认时别人已先改了 Status（版本过期），审批卡进冲突态，由人决定覆盖 / 放弃 / 让你重写。如需你重写：重新 `project-doc read` 拿最新正文，把你的意图合并进去，再 `propose` 一次（不用管版本号，Harness 会按最新 seq 处理）。

## 纪律

- 不要绕过协议用 shell / 编辑器直接改文档文件——那会被检测为"协议外修改"并标记。
- 只追加别人的 Log / Decisions 之外，不要删改历史条目；纠错用新条目说明。
- 决策写"原因"，失败过的路明确标注，避免下一个 Agent 重蹈覆辙。
