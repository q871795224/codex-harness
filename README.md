# Codex Harness

本地 macOS 桌面工作台。它把 Codex App Server 当作 runtime：Harness 负责会话管理与界面，Codex CLI / App Server 仍负责登录、权限、模型和 agent 执行。

## V1

- Git 主工作区分组；linked worktree 不会成为可选工作区。
- 新建、恢复、搜索、重命名、归档 / 恢复 Codex 会话；历史直接由 App Server 读取，不迁移。
- 每个会话有 `对话` 与 `轨迹` Tab。
- 支持 App Server 原生插话、服务器队列、停止与审批卡片。
- 本地 UI 状态只保存到 `~/.codex-harness/state.sqlite`，不复制会话正文或凭据。

不在 V1：模型 / 沙箱选择器、任务与监控、内嵌终端、永久删除、插件运行时。

## 开发

先确保本机已安装并登录 Codex CLI。Harness 会在连接前检查 `codex app-server daemon`，未运行时启动它，运行中时直接复用；关闭 Harness 不会停止 daemon。

```bash
pnpm install
pnpm tauri dev
```

构建未签名 macOS App：

```bash
pnpm tauri build
```

开发版与稳定版使用相同的 Harness 本地状态和 Codex 历史，但有独立的 macOS App 身份，可同时运行。开发版使用绿色图标和主题：

```bash
pnpm tauri:dev
pnpm tauri:build:dev
```

稳定版保持蓝色图标和主题，继续使用默认的 `pnpm tauri dev` 与 `pnpm tauri build`。

如果 GUI 进程找不到 Codex CLI，可显式设置 `CODEX_HARNESS_CODEX_PATH` 为 `codex` 可执行文件路径。

## 分层

`src-tauri/src/app_server.rs` 是唯一接触 Unix socket WebSocket 和 JSON-RPC 的 native bridge；React 只通过 Tauri IPC 调用它。功能代码按 `src/features` 分组，`src/extensions/types.ts` 仅保留未来插件协议的类型边界，V1 不加载任何外部插件。

DeepSeek Harness 仅作为 MIT 许可的交互参考；本项目未复制其源代码。
