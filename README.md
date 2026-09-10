# Codex Harness

本地 macOS 桌面工作台。它把 Codex App Server 当作 runtime：Harness 负责会话管理与界面，Codex CLI / App Server 仍负责登录、权限、模型和 agent 执行。

## 当前能力

- Git 主工作区分组；linked worktree 不会成为可选工作区。
- 新建、恢复、搜索、重命名、归档 / 恢复 Codex 会话；历史直接由 App Server 读取，不迁移。
- 每个会话有 `对话` 与 `轨迹` Tab。
- 支持 App Server 原生插话、服务器队列、停止与审批卡片。
- 支持从指定 turn 分支为新会话；分支复制对话历史，但不会复制或回滚工作目录中的文件。
- Codex 原生子 Agent 活动会按会话汇总状态、任务和待审批数，可跳转或停止仍在运行的子 Agent。
- 输入框支持图片 / 文件、模型、推理强度、审批模式和上下文窗口；模型、Skills 与 MCP 默认项在设置中管理。
- Codex 回复中的本地文件链接和文件修改列表可直接跳转到 GoLand；不在 Harness 内重复实现 diff。
- 会话标题栏可打开 GoLand、复制当前分支，并从 `origin` 跳转到 GitHub PR 或 GitLab MR 创建页。
- 本地 UI 状态只保存到 `~/.codex-harness/state.sqlite`，不复制会话正文或凭据。

当前不做：内置 diff、会话 revert、任意 shell hook、外部 Harness 插件市场。

## 阶段 2

- Harness 已加载随 App 发布的内置插件；外部 Harness 插件需等待独立 WebView 权限隔离完成，Codex 插件继续由 App Server 管理。
- 插件实例可归属于全局、workspace 或 thread，并拥有独立启停、配置和本地 KV。
- “轨迹”已作为首个内置插件通过 `conversation.tabs` slot 接入。
- “临时 Agent”通过独立 child thread 支持后台运行与人工确认回传，运行索引不保存会话正文。快捷 Agent 可声明只读、共享写入或隔离交付，也可声明完成后由用户手动回传发起会话；共享目录的并发写任务会被拦截，隔离交付使用独立 Git worktree。运行记录可直接停止 active Run、打开子会话/GoLand、复制分支，并在任务结束后安全清理干净的 worktree。
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

## Linux / WSL2（实验性）

Windows 使用场景优先采用 WSL2 + Ubuntu + WSLg：Harness、Linux 版 Codex CLI 和项目文件都放在 WSL 内，窗口由 WSLg 显示在 Windows 桌面。无需安装完整 Linux 桌面。WSLg 要求 Windows 11 或 Windows 10 build 19044+，且发行版必须使用 WSL2，见 [Microsoft GUI 应用说明](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps)。

在 PowerShell 中用 `wsl --version`、`wsl -l -v` 检查版本；旧版 WSL 可用 `wsl --update` 更新，保存 WSL 内工作后执行 `wsl --shutdown` 并重新打开发行版。

首个打包目标是 Ubuntu 的 `.deb`。当前已提供构建配置与 Linux CI，尚未完成 WSLg 实机验收；CI 通过只能证明编译、测试与打包成功。系统通知和 Claude 登录自启暂不支持 Linux，GoLand 启动仍依赖 macOS 路径。macOS 发布快捷命令不适用于 Linux。

在 Ubuntu 内安装构建依赖，并准备 Rust stable、Node.js 22 和 pnpm 8：

```bash
sudo apt update
sudo apt install -y build-essential pkg-config curl wget file libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev patchelf fonts-dejavu-core fonts-noto-cjk
```

在 WSL 内安装并登录 Linux 版 Codex CLI，先确认 `codex --version` 和 `codex login status` 正常，再在仓库目录构建：

```bash
pnpm install --frozen-lockfile
pnpm tauri:build:linux
```

此命令必须在 Linux/WSL 内执行，按当前主机架构构建；不从 macOS 交叉编译。Tauri 自动合并 [Linux 配置](src-tauri/tauri.linux.conf.json)，使用现有 PNG 图标。产物在 `src-tauri/target/release/bundle/deb/`，用 `sudo apt install ./实际文件名.deb` 安装后运行 `codex-harness`，不需要 Vite、Rust 或 pnpm。仍需单独安装 Codex CLI；使用 Claude Provider 还需要 Node.js。

[Linux CI](.github/workflows/linux.yml) 在 Ubuntu 22.04 x86_64 上编译、运行 Rust 测试并保存 `.deb` artifact。选择较旧构建基线可降低 glibc 兼容风险，见 [Tauri Debian 打包说明](https://v2.tauri.app/distribute/debian/)。默认 macOS 构建命令保持不变。

建议先把项目放在 WSL 的 `~/projects/` 下验收。WSL 中的 `~/.codex` 和 `~/.codex-harness` 默认与 Windows/macOS 独立。Codex 凭据存储由 `cli_auth_credentials_store` 决定；文件模式使用 `auth.json`，不是 `config.toml`，见 [Codex 身份验证说明](https://developers.openai.com/codex/auth/)。

首次运行需要检查：窗口与中文显示、Codex 连接与发送/恢复会话、终端、附件选择、剪贴板和外部链接。若出现 WebKit 白屏，可先尝试单次启动 `WEBKIT_DISABLE_DMABUF_RENDERER=1 codex-harness` 排查，不默认全局关闭渲染能力。

## 分层

`src-tauri/src/app_server.rs` 是唯一接触 Unix socket WebSocket 和 JSON-RPC 的 native bridge；React 只通过 Tauri IPC 和 `src/core/runtime/appServerClient.ts` 的类型化方法调用它。功能代码按 `src/features` 分组，插件契约位于 `src/extensions/types.ts`，内核与 React host 位于 `src/core/plugins/`，随 App 发布的内置插件位于 `src/plugins/`。当前不加载任何外部插件。

DeepSeek Harness 仅作为 MIT 许可的交互参考；本项目未复制其源代码。
