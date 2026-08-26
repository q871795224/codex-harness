# 0.2.0 路线图：扩展能力与本地资源管理

状态：规划中（2026-08-26）

## 目标与边界

0.2.0 为 Codex Harness 增加可测试的扩展基础、MCP 与 Skills 的本地管理界面，以及首个内置插件——自动会话标题。现有 App Server 会话、审批和队列能力保持不变。

本版本区分两层对象，避免把它们混成同一套生命周期：

| 层 | 管理对象 | 0.2.0 的职责 |
| --- | --- | --- |
| Harness 扩展 | UI Tab、会话事件钩子、设置项 | 注册、启用/停用、错误隔离、持久化设置 |
| Codex 本地运行时 | MCP server、用户 Skills | 展示、校验和安全地调用 Codex/本地文件能力进行管理 |

`src/extensions/types.ts` 已预留 V2 扩展接口，但尚无注册表或加载器。前端与原生层继续经 `src/core/runtime/bridge.ts` 和 `src-tauri/src/lib.rs` 的 IPC 边界通信；`src-tauri/src/app_server.rs` 仍是唯一接触 App Server 传输协议的模块。

```text
测试基础 ──> 插件内核 ──> MCP / Skills 管理界面
                  └────> 自动标题插件
       \______________________________________/
                    0.2.0 发布门禁
```

## 里程碑 1：测试基础与发布门禁（已完成）

### 实施内容

- 为前端引入 Vitest，提供 `pnpm test` 与 `pnpm test:watch`。
- 为纯函数和状态转换补单元测试，优先覆盖 `src/core/domain/codex.ts`、`src/core/domain/format.ts`、队列与会话事件处理中的可独立逻辑。
- 为 Rust 层补 `#[cfg(test)]` 用例，优先覆盖 Git 主工作区解析、SQLite 状态读写和不依赖真实 Codex daemon 的错误分支。
- 把可替换的进程执行和文件系统访问收敛到可注入的边界，避免测试修改真实 `~/.codex` 或 `~/.codex-harness` 数据。
- 更新 `AGENTS.md`：发布前必须执行 `pnpm test`、`pnpm build`、`(cd src-tauri && cargo test)`，并完成核心手工冒烟验证。

### 验收标准

- 前端和 Rust 均有实际运行的测试，不再是零测试基线。
- 失败用例能以非零状态退出；测试不读取或覆盖个人配置、凭据和会话数据。
- `AGENTS.md` 的发布门禁与 `package.json` 中的命令一致。

## 里程碑 2：Harness 插件内核

### 实施内容

- 将现有 `HarnessExtension` 扩展为受版本约束的 manifest 与能力声明：标识、显示名称、版本、设置页、会话事件钩子和可选 Tab。
- 建立 `PluginRegistry`，负责发现、校验、排序、启用/停用和错误状态；插件失败不可阻断主会话。
- 定义受控事件模型，例如会话创建、首条用户消息、turn 完成、会话手动改名；插件只能使用显式暴露的上下文和 IPC 封装。
- 在本地状态库保存插件启用状态和设置。0.2.0 只支持内置插件与用户明确授权的本地开发插件，不做远程下载、市场或任意代码自动执行。
- 在设置页提供最小插件列表，展示版本、状态、错误原因和启用开关。

### 验收标准

- 一个最小测试插件可被注册、启用、停用和重新加载；其异常不会影响主 UI。
- 插件 Tab 与事件钩子按 manifest 生效，重复注册和不兼容版本有明确错误。
- 自动标题插件可完全通过该内核运行，不在 `App.tsx` 或 `useHarness` 中写特判。

## 里程碑 3：MCP 与 Skills 管理界面

### MCP

- 增加设置页中的 MCP 页面：读取详情、添加、编辑、删除和认证入口；首版覆盖 Codex CLI 已支持的 stdio 与 streamable HTTP server。
- Rust 原生层以参数数组执行 `codex mcp`，读取 `list --json` 与 `get --json` 的结构化结果；写操作后回读结果确认，不直接编辑 `config.toml`。
- 显示配置来源、连接/认证结果和下一步动作；环境变量值、Bearer token 与 OAuth 凭据必须脱敏，不能写入 Harness SQLite、日志或前端状态。
- 对新增子进程、删除 server、发起 OAuth 登录明确提示影响范围；Codex daemon 是否需要重连或重启，以实际回读/冒烟结果为准。

### Skills

- 增加 Skills 页面，先管理用户可写的 Codex Skill 根目录：列出、查看元数据、创建/编辑、导入和删除；系统随附或市场安装的内容只读显示。
- 按实际 Codex `SKILL.md` 约定校验元数据和目录边界；所有路径必须 canonicalize 后仍位于允许的 Skill 根目录，删除与覆盖必须二次确认。
- 将 Skill 文件操作放在 Rust 原生层，前端只传递受限的请求模型；不允许通过名称或压缩包条目穿越目标目录。

### 验收标准

- 可以在临时 Codex 配置下完整验证 MCP 的 list/add/remove 和失败提示，不影响用户真实配置。
- 可以在临时 Skill 根目录验证新增、编辑、无效元数据拒绝和删除边界。
- 管理页在配置读取失败、认证未完成、文件格式错误时给出可操作的错误，不泄露秘密信息。

## 里程碑 4：自动会话标题插件

### 实施内容

- 作为第一个内置插件实现，监听首条有效用户输入与首个完成的 turn。
- 标题生成优先使用隔离的标题生成能力；不得将隐藏提示词或标题生成结果写进用户正在进行的会话记录。实现前先验证 App Server 是否提供合适的隔离调用；没有时使用确定性的首条消息摘要作为降级策略。
- 生成标题通过既有 `thread/name/set` 写回 Codex；保存标题来源与完成标记，避免重复改名。
- 用户手动重命名后永久优先；插件提供开关、失败降级和长度/敏感信息处理策略。

### 验收标准

- 新会话在首轮完成后得到稳定标题，生成失败不影响对话。
- 手动标题不会被后续插件事件覆盖；恢复会话或刷新页面不会重复生成。
- 标题触发、手动优先和失败降级均有自动化测试。

## 发布门禁

完成上述功能后，在发布 0.2.0 前执行：

```bash
pnpm test
pnpm build
(cd src-tauri && cargo test)
pnpm tauri build
```

并在临时配置中手工验证：创建/恢复会话、插件启停、MCP 的增删与认证失败路径、Skill 的边界校验、自动标题和手动改名优先级。发布前同步更新版本号、README 与 `AGENTS.md`。

## 待在实现前确认的决策

| 决策 | 当前建议 | 原因 |
| --- | --- | --- |
| 插件信任模型 | 内置 + 用户明确授权的本地开发插件 | 任意第三方代码需要额外的签名、权限和沙箱设计，不纳入 0.2.0。 |
| MCP 生效方式 | 调用 Codex CLI，写后回读 | 已安装 CLI 提供结构化 list/get 与 add/remove 命令，避免自行维护 Codex 配置格式。 |
| Skills 管理范围 | 仅用户可写根目录可修改 | 防止修改系统/市场内容，也便于做路径边界测试。 |
| 自动标题生成 | 隔离调用优先，首条消息摘要兜底 | 不能污染用户会话或覆盖手动标题。 |

## 参考依据

- 当前代码的 V2 接缝：[src/extensions/types.ts](src/extensions/types.ts)；App Server IPC 边界：[src/core/runtime/bridge.ts](src/core/runtime/bridge.ts) 与 [src-tauri/src/app_server.rs](src-tauri/src/app_server.rs)。
- DeepSeek Harness 的“能力由插件提供”与生命周期思路可供参考，但不引入其 Cordis 依赖，也不复制其源代码：[官方说明](https://deepseek.com/harness/)。
- MCP 的命名空间、配置校验和重连状态可借鉴其官方 MCP client 的设计：[dsh-mcp-client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)。
- 本机已核对的 Codex CLI 能力：`codex mcp list/get/add/remove/login/logout` 与 `codex plugin`。实际接入时以目标 Codex 版本的 `--help` 和结构化输出为准。
