# 管理操作

以下用`CLI`表示本次Skill目录旁的`harnessctl.py`绝对路径，调用形式为`python3 "$CLI" ...`。先看status与capabilities；主文件中的授权与未知结果处理规则适用全部命令。

## 设置

```sh
python3 "$CLI" settings list
python3 "$CLI" settings read router
python3 "$CLI" models list --provider codex
python3 "$CLI" settings update router --file /tmp/router-patch.json
```

patch示例：`{"backend":"codex","feedbackCount":5,"feedbackRule":"recent"}`。只更新指定字段；descriptions、fontSizes、actionShortcuts按键合并。Router descriptions使用工作区root，null删除对应手填介绍；自动缓存介绍用Router入口管理。inputCorrection.rules和conversationStats.items是整体数组，修改前先读取并保留要留下的项。

设置组由`settings list`返回：appearance、navigation、keyboard、threadTitle、recap、conversationStats、router、memory、history、inputCorrection、handover。响应中的effect说明立即生效、下次使用生效或需要重启；修改历史响应上限不会自动重启应用。已运行的模型任务使用启动时配置。

多人/多会话同时配置时，可以给update附`--expected-file FILE`，内容为先前read回包中settings字段的JSON对象；不匹配则拒绝写入，重新读取后再决定。未知设置组和字段会被拒绝。CLI不会授予任意状态键访问。

Codex默认设置仍用`config read`、`config set model MODEL`、`config set model_reasoning_effort EFFORT`；只影响默认值，不更改已有会话。MCP用`mcp list/reload`，Skill用`skills list/enable/disable --cwd PATH`；以实际Provider能力为准，不称Claude命令列表为完整Skill目录。

## Router

| 命令 | 作用 |
| --- | --- |
| `router summaries` | 当前可见工作区的缓存介绍、检查时间和错误状态 |
| `router refresh ROOT` / `router refresh --all` | 跳过24小时等待检查指定/全部工作区；内容变化时可能调用简介模型，返回受理回执，随后查summaries确认完成 |
| `router preview` | 只读组装实际后端请求，用户输入为占位符，不调用模型 |
| `router preview --input-file FILE` | 用指定文字组装请求并选择相关案例，不调用模型，不保存请求正文 |
| `router record THREAD_ID` | 查询该会话路由选择、模型、耗时、反馈等元数据 |
| `router feedback --offset 0 --limit 20` | 分页读取明确反馈元数据，不复制用户消息正文 |
| `router set-feedback THREAD_ID --accurate` | 根据用户明确反馈记录准确 |
| `router set-feedback THREAD_ID --workspace ROOT` / `--general` | 保存用户明确纠正，当前执行/目录不变 |
| `router correct THREAD_ID --workspace ROOT` / `--general` | 保存纠正并通过原有流程切换后续工作区；目标Codex会话须已加载且空闲，不重放原任务 |

先列出工作区确认root与checkoutRoot，二者不要互换。反馈必须来自用户明确评价，不为了获得更好的测试成绩自行填标签；继续聊天的implicit-accurate不当作人工确认。管理命令不把错误工作区的历史操作回滚。

## 项目

`projects list`列元数据，`projects get ID`补充工作区关联；`projects update ID --file FILE`支持name、shortName，简称最多12个字符且无换行/方括号，空字符串清除。简称影响后续命名，不批量重命名历史会话。可选expected-file是`{"name":"原名","shortName":null}`这样的先前元数据。

```sh
python3 "$CLI" projects request-create '新项目名称'
python3 "$CLI" projects request-join PROJECT_ID
python3 "$CLI" projects request-status
```

来源thread优先使用显式`--thread-id`，否则读取当前进程CODEX_THREAD_ID或CODEX_HARNESS_THREAD_ID；绝不使用界面当前选中的会话代替。申请只显示确认卡，5分钟未操作按预填选项执行，开始编辑则等待确认；用request-status核对reading/running/saving/binding/done/error，不把申请受理当作项目已创建。项目归属锁定、文档Status审批和人工精简规则保持原样。

项目正文及条目操作使用`harness-project-doc` Skill：read、entries、propose、update、supersede、close等。此Skill不复制另一套项目维护接口。

## 插件、SeaTalk与通知

先`plugins list`定位instanceId、作用域和生命周期。`plugins read ID`返回已声明的非秘密配置、可编辑字段和隐藏配置键名；未知插件的配置值不导出。`plugins configure ID --file FILE`合并patch并应用原有生命周期；create/enable/disable/delete沿用原命令。读到failed时按失败处理，不能只看enabled。

项目文档插件可配置compactionThreshold、archiveModel、archiveEffort；它们也用于中途接入的整理模型。旧归档入口已下线，不通过配置恢复。SeaTalk提问通知插件可配置本机Bridge地址、account和targetId；SeaTalk草稿插件可配置默认接收目标；凭据由Bridge保管。系统通知启停通过对应插件，不恢复右侧浮层。

`seatalk status`看远程续聊通道是否reachable/connected及账号信息，`seatalk bindings`列threadId/rootId映射。这两个命令只诊断，不发送消息、不领取手机指令、不回答审批。续聊通道由核心挂载，旧SeaTalk草稿插件启停不代表续聊通道状态。

`notifications list --unread --thread-id THREAD_ID`分页查通知摘要（省略原始details），`notifications read ID`或`notifications read --all`标记已读。已读与源问题/审批是否处理相互独立；这不是批准操作或提交回答的入口。

## 工作区、会话与异步等待

`workspaces list/add/hide/show`读取合并目录并沿原有流程登记/隐藏；隐藏不删除目录或会话。`sessions list`只覆盖已加载视图，不读取消息正文。`sessions create --provider codex`建立自动选择工作区的空会话；显式传`--cwd PATH`绑定checkout。创建本身不发模型轮次。select/rename/archive/restore沿用原有命令与运行状态检查。

`async-waits list/get/create/check/pause/resume/cancel/acknowledge`完整流程见[异步等待](async-waits.md)。具体业务就绪条件与continuation由Agent写清楚；注册后移交Harness，等待结果时不持续空转轮次。
