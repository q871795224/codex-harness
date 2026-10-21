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

Harness 插件、Codex 插件、Claude Code 插件分别管理。此入口管理 Harness 实例，不代理所有插件的业务动作，不执行任意 shell，不提供通用 App Server RPC、审批放行或数据库写入入口。

客户端用 `harnessctl source` 定位仓库。读取 `AGENTS.md` 和 `.harness/README.md` 后沿 `src/core/management/service.ts`、`src/core/plugins/`、目标 `src/plugins/<name>/`、`bridge.ts`、Rust 实现核对能力。旧版本没有管理端点时明确报告不支持，源码存在接口不等于当前运行应用已具备。

## 验证

Rust 测试验证端点认证、Origin 拒绝、权限和注册归属，以及写请求去重；前端测试使用真实 PluginHost 的 lifecycle 验证启停和贡献变化，覆盖显式登记与发现工作区的数量差异。Claude daemon 用注入 SDK 测试命令查询，不发送真实模型请求。客户端用本地 fixture 服务验证请求、错误和重定向边界。所有测试使用临时目录或注入依赖。
