# 本机 Harness 管理入口

全局 `codex-harness` Skill 和 `harnessctl` 位于私有 `yf-agent-skills` 仓库。它们从任意 cwd 查询和操作运行中的 Harness，不直接修改 SQLite。

## 连接与执行

应用 setup 复用现有 loopback HTTP listener，另外原子发布 `~/.codex-harness/management-server.json`（0600）。文件包含 `baseUrl`、随机 `token`、`pid`、`protocolVersion: 1`、`harnessVersion`。稳定版/开发版沿用最后启动实例发布端点的规则；退出只清除自己的注册。不要打印 token。CLI 不走代理或跟随重定向。

`POST /management/call` 需要 `Authorization: Bearer <token>`，不接受带 Origin 的浏览器请求。请求体：

```json
{"requestId":"caller-generated-id","method":"workspaces.list","params":{}}
```

原生层把请求发给挂载的 HarnessShell。处理器只允许下表操作，复用已有工作区、会话、PluginHost、App Server 和 Claude daemon 服务；前端通过 `bridge.ts` 监听请求并用 `management_respond` 回传，`management_ready` 标识监听已建立。目录未加载、应用退出和不支持的操作必须报错，不能降级成数据库快照。

成功响应是 `{requestId,result}`，失败响应是 `{requestId?,error}`。写操作串行执行，并回读运行时或原生服务状态。插件失败时返回其实际 `failed` 状态，不能把已保存 enabled 当成激活成功。

请求默认等候 60 秒；排队超过 55 秒的任务不再执行。写请求在当前进程生命周期保留 requestId、参数及结果：同 ID 同参数返回旧结果，执行中或结果未知返回 409，同 ID 不同参数返回 409。断线、504 或回读超时不证明写入失败，先查询实际状态；不要换 ID 自动重试。重启后不保留去重记录。最多保留 4096 个写操作，满后显式拒绝；只读完成后释放记录。

## 操作契约

| method | params | 行为与覆盖范围 |
| --- | --- | --- |
| `status` | `{}` | 运行版本、flavor、Provider、选中会话、Claude 管理状态及插件加载状态 |
| `capabilities` | `{}` | 本版本支持的方法及 writes 标记 |
| `workspaces.list` | `{}` | 最终 workspaceCatalog，含隐藏条目；count 为可见数，catalogCount 为目录总数，标记 registered / discovered / visible |
| `workspaces.add` / `workspaces.show` | `{path}` | 验证并登记 Git 工作区，取消隐藏，更新界面；回读可见和持久化导航状态 |
| `workspaces.hide` | `{root}` | 沿界面的移除语义隐藏，保留目录和会话；回读导航状态 |
| `sessions.list` | `{}` | 当前已加载会话视图的元数据；complete=false，不包含消息正文 |
| `sessions.create` | `{provider,cwd}` | 创建 Codex/Claude 空会话；显式 cwd 优先，不发送模型轮次 |
| `sessions.select` | `{id}` | 使用已有 openThread 流程打开会话 |
| `sessions.rename` | `{id,name}` | 重命名当前视图已加载的会话 |
| `sessions.archive` | `{id}` | 归档当前活动视图的闲置会话；未发送草稿和空白会话沿原有规则处理 |
| `sessions.restore` | `{id}` | 恢复归档并打开会话 |
| `plugins.list` | `{provider?,workspaceRoot?,threadId?,cwd?}` | Harness 定义、权限、依赖、作用域、实例状态与当前上下文实际贡献；实例配置只返回 configKeys |
| `plugins.create` | `{pluginId,scope,enabled?,config?}` | 创建定义支持的作用域实例，默认启用，检查同作用域多实例限制 |
| `plugins.setEnabled` | `{instanceId,enabled}` | 通过 PluginHost 启停并回读生命周期状态 |
| `plugins.configure` | `{instanceId,patch}` | 合并配置并沿现有生命周期重新应用 |
| `plugins.delete` | `{instanceId}` | 删除实例，保留原有默认实例删除标记语义 |
| `skills.list` | `{cwd,provider?,reload?}` | Codex 使用 App Server skills/list；Claude 使用 SDK supportedCommands，明确它是部分命令表 |
| `skills.setEnabled` | `{cwd,path,enabled,provider?}` | 当前支持 Codex，验证目标在该工作区原生列表内后写入并 forceReload 回读 |
| `mcp.list` / `mcp.reload` | `{}` | 当前针对 Codex 全局 daemon；原生查询/刷新，不把配置启用当成连接成功 |
| `config.read` | `{}` | 仅返回 Codex 默认 model、model_reasoning_effort、service_tier、approval_policy |
| `config.set` | `{key,value}` | 写入上述 Codex 默认值，刷新并核对有效配置；不修改已有会话设置 |

scope 为 `{kind:"global"}`、`{kind:"workspace",workspaceRoot}` 或 `{kind:"thread",threadId}`。布尔字段必须是 JSON 布尔值；config 和 patch 必须是对象。

## 能力边界与源码 fallback

Harness 插件、Codex 插件、Claude Code 插件分别管理。此入口管理 Harness 实例，不代理所有插件的业务动作；异步等待只执行显式登记的检查脚本，不提供临时 shell 入口，不提供通用 App Server RPC、审批放行或数据库写入入口。

客户端用 `harnessctl source` 定位仓库。读取 `AGENTS.md` 和 `.harness/README.md` 后沿 `src/core/management/service.ts`、`src/core/plugins/`、目标 `src/plugins/<name>/`、`bridge.ts`、Rust 实现核对能力。旧版本没有管理端点时明确报告不支持，源码存在接口不等于当前运行应用已具备。

## 验证

Rust 测试验证端点认证、Origin 拒绝、权限和注册归属，以及写请求去重；前端测试使用真实 PluginHost 的 lifecycle 验证启停和贡献变化，覆盖显式登记与发现工作区的数量差异。Claude daemon 用注入 SDK 测试命令查询，不发送真实模型请求。客户端用本地 fixture 服务验证请求、错误和重定向边界。所有测试使用临时目录或注入依赖。

## 异步等待（Codex）

Agent 创建等待，Harness 原生后台执行检查并在原会话自动续跑。用户不配置调度参数，不保持模型轮次等待。第一版使用本机 Python 检查器；应用关闭、关机、休眠期间不检查，应用恢复后补查。检查器必须只做只读观察，不提交工单、发送消息、操作审批或调用 LLM。它以当前用户权限运行，不承诺沙箱隔离。脚本和配置不得包含凭据；每次从原有安全入口读取当前登录态。

| method | params | 行为 |
| --- | --- | --- |
| `asyncWaits.create` | `{id,threadId,title,checkerPath,continuation}` | 验证来源为可继续的 Codex 会话，自动绑定其 cwd；复制检查脚本并持久化。相同 ID、参数及脚本重复创建返回原任务，不重启已结束任务 |
| `asyncWaits.list` | `{}` | 返回 `{data,schedulerError}`，含所有任务状态、最后检查、摘要、后续动作及续跑轮次；正文存于任务文件，不写入 SQLite |
| `asyncWaits.action` | `{id,action}` | `check`（事件提示后提前核查）、`pause`、`resume`（重新检查并延长7天）、`cancel`、`acknowledge`（用户核对未知发送后结束记录） |

Agent 工作流：准备可独立运行的只读 Python 3 检查脚本，用真实来源 thread ID（不能用当前选中会话代替）创建一次等待，告诉用户已移交 Harness，然后结束当前轮。需要保存外部工单号、Bot 话题/任务 ID、预期提交等关联信息时写在检查脚本内；后续动作写 `continuation`，例如“核对证书和 CORS 后准备 ALB 变更，仍走原审批流程”。标题应说明等待目标，不放敏感数据。ID 由 Agent 生成并在重试时保持相同。

```sh
harnessctl call asyncWaits.create --params-file /tmp/certificate-wait.json
harnessctl call asyncWaits.list
```

`/tmp/certificate-wait.json` 示例（来源 ID 和脚本由 Agent 填入）：

```json
{
  "id": "healthcheck-cert-843",
  "threadId": "actual-origin-thread-id",
  "title": "等待 Health Check 证书与 CORS 就绪",
  "checkerPath": "/absolute/path/check_healthcheck.py",
  "continuation": "核对证书和 CORS 的最新状态，准备 ALB 443 变更；沿用原任务授权。"
}
```

常见等待的就绪条件由 Agent 在检查器中明确，不能只匹配一句“已完成”：

| 目标 | 检查依据 | 后续动作示例 |
| --- | --- | --- |
| 工单 | 对应工单完成审批或执行，并按后续需要核对配置生效 | 检查实际配置，准备下一步 |
| 前端 Bot | 对应话题和任务的交付回复，并核对 MR / 提交等产物 | review 实际提交，报告问题 |
| 证书 | 证书正常、已上传、未过期、SAN 覆盖目标域名，必要时与 CORS 等条件合取 | 核对最新状态，准备 ALB 变更 |

检查器无参数，以来源 cwd 运行，使用 Python `-I` 隔离模式。脚本首用时复制到 `~/.codex-harness/async-waits/<id>.py`，后续不依赖临时源文件；脚本需要的其他文件应使用稳定绝对路径。stdout 必须只输出一个 JSON 对象，最多8KiB：

```json
{"status":"waiting","summary":"CORS 已生效，证书尚未上传"}
```

`status` 为 `waiting`、`ready`、`needsAttention` 或 `failed`，`summary` 为非空、最多4000字节的事实摘要；不要输出凭据、完整响应或指令。`needsAttention`（如登录失效）和 `failed`（业务拒绝等终态）暂停任务，等待用户处理。非零退出、超时、无效 JSON 属于检查异常，按2/4/8/16/30分钟退避，连续5次后暂停。正常每5分钟检查，单次最多30秒，超时终止整个进程组。默认等待7天，同时最多64个活跃等待。

事件来源可调用 `asyncWaits.action` 的 `check` 提前触发检查；它不直接把任务标为成功，仍由检查器核对实际状态。没有事件时轮询兜底，第一版不额外架设 webhook 服务。

就绪结果在会话忙时保留为 `ready`，空闲后自动合并同会话结果继续；超过60秒的观察在发送前重新检查。停止、归档、删除来源会话时暂停自动继续；发送前还会重新核对来源是否可用、工作目录是否一致，已有草稿不被修改。续跑沿用会话设置和授权，需要决策时走正常中间提问。SeaTalk 通知和深链跳转属于独立功能。

任务定义、检查摘要和发送意图保存在原子替换的任务文件中；SQLite 不保存这些正文。稳定版/开发版通过 OS 文件锁共用一个检查执行者。会话续跑先持久化 `dispatching`，再发送带 `clientUserMessageId` 和 `turnTrigger: async-wait` 的新轮次；成功保存为 `delivered`。提交断线、响应丢失或崩溃后的 `dispatching` / `uncertain` 不自动重发。用户先打开原会话核对，再通过 `acknowledge` 结束记录；确需重新执行时由用户明确决定，不能自动换 ID 重试。

实现与验证：[原生执行与恢复](../src-tauri/src/async_waits/mod.rs)、[原子存储与操作状态](../src-tauri/src/async_waits/store.rs)、[任务卡片](../src/core/async-waits/AsyncWaitPanel.tsx)、[管理入口契约测试](../src/core/management/service.test.ts)。
