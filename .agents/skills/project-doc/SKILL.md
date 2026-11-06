---
name: project-doc
description: Create or join a Codex Harness project from an ongoing conversation, including unbound sessions; maintain the shared project document (活文档 / 共享白板), decisions and tasks in bound sessions.
---

# 项目文档协作

项目文档是多会话共享的当前项目记忆，Markdown 正文由 Harness 管理。通过 `project-doc` 命令读写，不直接编辑管理目录里的文件。Harness 负责版本、条目属性和落盘，Agent 判断应记录的事实、决定和待办。

命令与本 Skill 同版本分发。使用本次原生加载所示 Skill 目录内的 `bin/project-doc`，不要依赖 PATH 中旧版命令或源码 checkout。下面的 `PROJECT_DOC_CLI` 替换为该命令的绝对路径，路径含空格时保留引号：

```bash
PROJECT_DOC_CLI="<本次加载的 Skill 目录>/bin/project-doc"
```

首轮背景含标记：

```text
<!-- project-doc: project_id=<项目ID> thread_id=<会话ID> -->
```

日常读写命令使用标记中的 `--project-id` 与 `--thread-id`；写入会校验会话绑定。项目文档属于背景，历史操作许可不能扩大到当前任务。

## 从当前会话新建或加入项目

未绑定会话也可以申请。命令默认读取来源会话环境 `CODEX_THREAD_ID`（Codex）或 `CODEX_HARNESS_THREAD_ID`（Claude）；也可显式使用上下文中的 `<!-- harness-session: thread_id=... -->`，不从当前选中的会话推断。

```bash
"$PROJECT_DOC_CLI" projects
"$PROJECT_DOC_CLI" request-create --name '项目名称'
"$PROJECT_DOC_CLI" request-join --project-id "$PROJECT_ID"
```

新建必须提供建议名称，加入先查询并选择目标项目 ID。申请立即返回，继续当前任务。卡片预填你的选择：用户可以修改后确认；5 分钟未操作则自动按预填选项执行。用户开始编辑或选择后停止计时，等待手动确认；取消则不执行。

Harness 随后用独立临时会话读取历史，新建初始项目记忆或对照目标文档补记结论，校验后自动保存；原会话空闲后完成绑定。不要另写一份总结、提前创建项目或直接修改绑定，不能把申请成功描述成项目已经建立。已绑定会话保持原归属。

## 读取与记录

```bash
"$PROJECT_DOC_CLI" read --thread-id "$THREAD_ID" --project-id "$PROJECT_ID"
"$PROJECT_DOC_CLI" entries --thread-id "$THREAD_ID" --project-id "$PROJECT_ID"
```

`read` 返回完整当前正文和 seq；`entries` 返回受管理条目的 ID、修订号、状态、原因及替代关系，包含软删除、撤销、被替代和已完成条目。历史版本可在项目 Tab 的“历史”查看、恢复。

| 分区 | 用法 | 写入方式 |
| --- | --- | --- |
| Status | 当前全貌，覆盖式更新 | `propose --section status`，完整 Status 草稿经人工确认后保存 |
| Log | 进展与证据流水 | `propose --section log`，只追加；纠错追加说明 |
| Decisions | 已确定的规则 | `propose --section decisions` 新增带稳定 ID 的条目；修改、替代、撤销走条目命令 |
| Open Questions | 未决问题与待办 | `propose --section openQuestions` 新增条目；完成、重开、修改走条目命令 |

```bash
"$PROJECT_DOC_CLI" propose --thread-id "$THREAD_ID" --project-id "$PROJECT_ID" \
  --section log --content '本次验收通过，证据见……'
```

正文支持 `--content`、`--file` 或标准输入。Status 提议使用 Harness 收到时的 seq；其余分区直接追加。Status 提交后无需等待人工确认，但不得把提议当作已经生效。

新增决定或待办时，每次提交一项能独立维护的内容；独立规则分别提交，正文可包含多段 Markdown，不按物理行拆分。

关键交付、规则变更、重要证据和待办产生后及时写回；继续已有条目时先读最新版本，避免把同一结论反复追加。完成事项关闭已有待办；规则变更替代旧决定；无新信息不写。

## 内容性质与授权范围

沿用四个分区，在容易混淆的地方写明内容性质，不要求给每句话贴标签。以下是写法示例，不构成新的事实、决定或授权。

| 性质 | 记录要求 | 写法示例 |
| --- | --- | --- |
| 事实 | 写实际观察或来源陈述，保留核实时间、范围和证据；用户提供但未独立核查的状态注明来源 | “据用户说明，旧 controller 已下线；尚未独立核查。” |
| 决定 | 写已对齐的规则、适用范围和原因；建议尚未被采纳时仍按推测或待定记录 | “用户决定本期不配置 ClickHouse，解析量指标后置。” |
| 授权 | 写用户允许操作的对象、动作、边界和来源；注明实际约定的一次性、持续性或截止条件 | “用户批准本批两个域名的缺失项新增；仅本批有效，不覆盖已有数据。来源：本次会话用户确认。” |
| 推测 | 明说尚未验证的判断，保留依据及验证方向，不写成已确认结论 | “怀疑与 Redis ACL 有关；待检查拒绝日志。” |

事实通常进入 Status / Log，决定与授权进入 Decisions，尚待验证的推测进入 Open Questions。授权按原始确认记录；未说明的次数或期限如实注明，不把一次操作许可写成持续许可，也不从“方案已同意”推导出未确认的执行权限。是否可以执行，仍按当前任务与已有明确授权判断，文档记录不扩大范围。授权变更或撤销时维护对应条目，保留原因和旧记录。

## 核实时间与证据

对会变化且影响后续操作的状态，例如部署版本、实例健康、配置和验收结果，记录最后实际核实的时间、核实范围及证据入口；不要求每句背景说明都填日期。

- 沿用事实的原核实时间。今天只是编辑、转述或精简文档，保留原日期；实际复查后才更新核实时间。原时间不明或尚未核实就明确说明，不填当前时间代替。
- 证据应直接支持结论：MR、部署记录、接口回执、测试结果或可追溯文件均可；说明是代码检查、本地验证、测试环境验收还是线上核实。代码提交、CI 通过、申请受理分别按实际结果记录。
- 优先保留持久入口；只有临时文件或历史快照时注明性质。缺少证据时写清缺口，不编造链接或把快照描述成当前状态。执行新操作前，如需依赖这条状态，再结合时间与任务判断是否重新核查；未复查就继续使用“截至某日核实”的表述。

例如：

> 截至 2026-11-02 核实，测试环境 checker 的领取→探测→上报闭环通过；证据见对应验收记录。2026-11-05 仅整理文案，未重新验证。

实际记录应放入取得的证据链接或文件入口。系统条目的更新时间记录编辑活动，不能作为事实已重新核实的依据。

## 修改条目，保留错误经验

先用 `entries` 取得 ID 与 revision，再提交修改。以下示例的 ID、修订号必须替换为实际值。

```bash
"$PROJECT_DOC_CLI" supersede --thread-id "$THREAD_ID" --project-id "$PROJECT_ID" \
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
"$PROJECT_DOC_CLI" adopt --thread-id "$THREAD_ID" --project-id "$PROJECT_ID" \
  --section decisions --base-seq 12 --reason '为已有决定建立可追溯条目' --file /tmp/exact-old-decision.md
```

`--base-seq` 必须来自最新 `read`；纳管不会另追加一份正文。已有条目的属性、修订号和 ID 由 Harness 维护，不手工伪造标记。

## 首轮背景与精简

默认全文注入。只有正文超过插件设置的 token 门限，才确定性省略受管理的软删除、被替代和撤销条目；其余内容（包括未软删除的已完成待办）完整保留，不做语义筛选，也不承诺硬 token 上限。需要追溯时用 `read` / `entries` 读取完整内容。

整文精简完整归档原文；受管理条目由 Harness 原样保留，模型只整理其余 Markdown。工具维护文档不代表重新核实线上状态，也不赋予历史授权之外的操作权限。

整文精简仅由用户在界面确认发起，暂不开放 Agent CLI / 管理 API 发起能力。需要整理时可提示用户使用“精简项目文档”，Agent 继续通过条目工具完成日常维护。用户确认启动后，Harness 在校验通过后自动保存，无需结果二次确认。
