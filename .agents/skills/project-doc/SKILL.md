---
name: project-doc
description: Use when working in a Codex Harness session bound to a project document (活文档 / 共享白板); read it before proposing changes to the shared project document, coordinating with other agents through it, or recording progress/decisions into it.
---

# 项目文档协作

项目文档是多会话共享的当前项目记忆，Markdown 正文由 Harness 管理。通过 `project-doc` 命令读写，不直接编辑管理目录里的文件。Harness 负责版本、条目属性和落盘，Agent 判断应记录的事实、决定和待办。

首轮背景含标记：

```text
<!-- project-doc: project_id=<项目ID> thread_id=<会话ID> -->
```

所有命令使用标记中的 `--project-id` 与 `--thread-id`；写入会校验会话绑定。项目文档属于背景，历史操作许可不能扩大到当前任务。

## 读取与记录

```bash
project-doc read --thread-id "$THREAD_ID" --project-id "$PROJECT_ID"
project-doc entries --thread-id "$THREAD_ID" --project-id "$PROJECT_ID"
```

`read` 返回完整当前正文和 seq；`entries` 返回受管理条目的 ID、修订号、状态、原因及替代关系，包含软删除、撤销、被替代和已完成条目。历史版本可在项目 Tab 的“历史”查看、恢复。

| 分区 | 用法 | 写入方式 |
| --- | --- | --- |
| Status | 当前全貌，覆盖式更新 | `propose --section status`，完整 Status 草稿经人工确认后保存 |
| Log | 进展与证据流水 | `propose --section log`，只追加；纠错追加说明 |
| Decisions | 已确定的规则 | `propose --section decisions` 新增带稳定 ID 的条目；修改、替代、撤销走条目命令 |
| Open Questions | 未决问题与待办 | `propose --section openQuestions` 新增条目；完成、重开、修改走条目命令 |

```bash
project-doc propose --thread-id "$THREAD_ID" --project-id "$PROJECT_ID" \
  --section log --content '本次验收通过，证据见……'
```

正文支持 `--content`、`--file` 或标准输入。Status 提议使用 Harness 收到时的 seq；其余分区直接追加。Status 提交后无需等待人工确认，但不得把提议当作已经生效。

新增决定或待办时，每次提交一项能独立维护的内容；独立规则分别提交，正文可包含多段 Markdown，不按物理行拆分。

关键交付、规则变更、重要证据和待办产生后及时写回；继续已有条目时先读最新版本，避免把同一结论反复追加。记录事实时保留核实时间和来源；决定须来自实际对齐，不能把建议写成用户已批准。完成事项关闭已有待办；规则变更替代旧决定；无新信息不写。

## 修改条目，保留错误经验

先用 `entries` 取得 ID 与 revision，再提交修改。以下示例的 ID、修订号必须替换为实际值。

```bash
project-doc supersede --thread-id "$THREAD_ID" --project-id "$PROJECT_ID" \
  --id D-example --revision 3 --reason '用户改为只补缺失项，保留目标独有数据' \
  --content '仅新增缺失对象；其他差异单独决定。'
```

| 命令 | 作用 | 正文参数 |
| --- | --- | --- |
| `update` | 修订正文，旧正文仍在版本历史 | `--content` / `--file` / stdin |
| `supersede` | 原子新增决定并把旧决定标为被替代，保留旧正文及原因 | 新决定正文 |
| `revoke` | 撤销有效决定，没有新决定接替 | 无 |
| `delete` | 软删除，保留正文和原因 | 无 |
| `restore` | 恢复软删除前状态 | 无 |
| `close` | 完成待办，原因写完成证据 | 无 |
| `reopen` | 重开已完成待办 | 无 |

以上命令均要求 `--id`、`--revision` 和 `--reason`。修订冲突时重新读条目，合并实际意图后再提交；不要盲目提高版本重试。改变决定含义时优先 `supersede`，旧的错误、失败经验仍有价值，不硬删除，不将替代记录改写成“从未发生”。

旧文档不会批量自动迁移。需要维护某段旧决定或待办时，精确选取完整且唯一的原文段落纳管：

```bash
project-doc adopt --thread-id "$THREAD_ID" --project-id "$PROJECT_ID" \
  --section decisions --base-seq 12 --reason '为已有决定建立可追溯条目' --file /tmp/exact-old-decision.md
```

`--base-seq` 必须来自最新 `read`；纳管不会另追加一份正文。已有条目的属性、修订号和 ID 由 Harness 维护，不手工伪造标记。

## 首轮背景与精简

默认全文注入。只有正文超过插件设置的 token 门限，才确定性省略受管理的软删除、被替代和撤销条目；其余内容（包括未软删除的已完成待办）完整保留，不做语义筛选，也不承诺硬 token 上限。需要追溯时用 `read` / `entries` 读取完整内容。

整文精简完整归档原文；受管理条目由 Harness 原样保留，模型只整理其余 Markdown。工具维护文档不代表重新核实线上状态，也不赋予历史授权之外的操作权限。
