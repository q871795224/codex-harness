# Codex Harness

本地 macOS 桌面工作台。它把 Codex App Server 当作 runtime：Harness 负责会话管理与界面，Codex CLI / App Server 仍负责登录、权限、模型和 agent 执行。

## 当前能力

- Git 主工作区分组；linked worktree 不会成为可选工作区。
- 新建、恢复、搜索、重命名、归档 / 恢复 Codex 会话；历史直接由 App Server 读取，不迁移。
- 每个会话有 `对话` 与 `轨迹` Tab。
- 支持 App Server 原生插话、服务器队列、停止与审批卡片。
- 支持从指定 turn 分支为新会话；分支复制对话历史，但不会复制或回滚工作目录中的文件。
- Codex 原生子 Agent 活动会展示目标会话与运行状态，并可跳转到子 Agent 会话。
- 输入框支持图片 / 文件、模型、推理强度、审批模式和上下文窗口；模型、Skills 与 MCP 默认项在设置中管理。
- Codex 回复中的本地文件链接和文件修改列表可直接跳转到 GoLand；不在 Harness 内重复实现 diff。
- 本地 UI 状态只保存到 `~/.codex-harness/state.sqlite`，不复制会话正文或凭据。

当前不做：内置 diff、会话 revert、任意 shell hook、外部 Harness 插件市场。

## 阶段 2

- Harness 已加载随 App 发布的内置插件；外部 Harness 插件需等待独立 WebView 权限隔离完成，Codex 插件继续由 App Server 管理。
- 插件实例可归属于全局、workspace 或 thread，并拥有独立启停、配置和本地 KV。
- “轨迹”已作为首个内置插件通过 `conversation.tabs` slot 接入。
- “临时 Agent”通过独立 child thread 支持后台运行与人工确认回传，运行索引不保存会话正文。
- “SeaTalk Bridge”复用本机 companion，提供内存 Inbox、Codex 草稿、编辑预览和显式确认发送；凭据仍由 companion 管理。
- “会话启动器”通过 `newThreadPanels` slot 在空白新会话中展示 Codex Radar 模型表，并将 YOLO、Auto-review 或 Manual 模式作为完整的审批 reviewer 与 sandbox 组合写入 App Server。

## 开发

先确保本机已安装并登录 Codex CLI。Harness 会在连接前检查 `codex app-server daemon`，未运行时启动它，运行中时直接复用；关闭 Harness 不会停止 daemon。

```bash
pnpm install
pnpm tauri dev
```

单元测试和覆盖率报告：

```bash
pnpm test
pnpm test:coverage
(cd src-tauri && cargo test)
```

覆盖率阈值以当前代码基线为起点，用于阻止回退；新增可独立验证的逻辑应同步补测试。

构建未签名 macOS App：

```bash
pnpm tauri:build
```

开发版与稳定版使用相同的 Harness 本地状态和 Codex 历史，但有独立的 macOS App 身份，可同时运行。开发版使用绿色图标和主题：

```bash
pnpm tauri:dev
pnpm tauri:build:dev
```

稳定版保持蓝色图标和主题，使用 `pnpm tauri dev` 开发，并通过 `pnpm tauri:build` 打包。两个 flavor 的打包产物都是同时支持 Apple 芯片与 Intel Mac 的 Universal App。

如果 GUI 进程找不到 Codex CLI，可显式设置 `CODEX_HARNESS_CODEX_PATH` 为 `codex` 可执行文件路径。

## 分层

`src-tauri/src/app_server.rs` 是唯一接触 Unix socket WebSocket 和 JSON-RPC 的 native bridge；React 只通过 Tauri IPC 调用它。功能代码按 `src/features` 分组，插件契约位于 `src/extensions/types.ts`，内核与 React host 位于 `src/core/plugins/`，随 App 发布的内置插件位于 `src/plugins/`。当前不加载任何外部插件。

DeepSeek Harness 仅作为 MIT 许可的交互参考；本项目未复制其源代码。
