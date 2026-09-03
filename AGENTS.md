# Codex Harness 协作说明

## 任务路由

本文只放每次任务都必须知道的项目边界和安全约束。详细背景按任务需要读取，不要默认把 `.harness/` 下的全部文件加载进上下文。

- 先读 [.harness/README.md](.harness/README.md)，再按任务类型读取对应文档。
- 项目架构读 [.harness/architecture.md](.harness/architecture.md)。
- 项目长期记忆读 [.harness/memory.md](.harness/memory.md)。
- 测试和验证要求读 [.harness/test.md](.harness/test.md)。
- 已确认的坑点读 [.harness/pitfall.md](.harness/pitfall.md)。
- GitHub 分支、Pull Request、合并和发布衔接读 [.harness/github.md](.harness/github.md)。
- 沟通术语以 [.harness/glossary.md](.harness/glossary.md) 为准；出现名词歧义（如标题栏、turn、item）时查它，新约定沉淀进去。
- 发布、打包和安装流程使用项目级 Skill `.agents/skills/harness-release/SKILL.md`，不要把发布清单带入普通开发任务。
- Codex CLI/Harness 请求对照和 token 成本排查使用项目级 Skill `.agents/skills/harness-codex-audit/SKILL.md`。

文档只记录稳定、可复用的约定；临时进度放在任务记录或对话中。规则发生变化时，只修改职责对应的文档，并同步更新本路由。

## 每次任务必须知道的边界

- `src/` 是 Vite + React + TypeScript 前端；`src-tauri/` 是 Tauri Rust 原生层，负责 IPC、本地 SQLite 和 Codex App Server 连接。
- 前端只能通过 `src/core/runtime/bridge.ts` 调用原生能力；新增 IPC 必须同时更新 Rust 命令、bridge 类型封装和测试。
- `src/core/domain/` 放共享领域类型和格式化逻辑；界面功能代码放 `src/features/`。
- `src/core/plugins/` 是插件内核和 React host，`src/plugins/` 是内置插件。插件只能通过 `src/extensions/types.ts` 的 context、service、event、slot 契约接入能力。
- `src-tauri/src/app_server.rs` 是唯一直接接触 Codex App Server 传输协议的模块；React 和插件不得自行连接或拼装协议。
- Codex 的模型、推理强度、审批、上下文、附件、Skills、MCP 等原生能力属于 Harness 核心，不通过插件绕过核心实现。
- Skill 的发现、解析、启停和最终列表以共享 App Server daemon 为准，前端不得自行扫描或解析 `SKILL.md`。
- MCP 是共享 App Server daemon 的全局配置；必须区分配置启用、实际运行、启动失败和认证异常，不能把“已启用”当成“已连接”。

## Agent Job 与命令

- 快捷 Agent Job 通过 `quickActions` slot 和 `harness.agentRuns` 启动独立会话；插件不能直接调用 App Server。Run 必须记录发起会话，并允许同一会话按产品约定并发启动。
- Job 必须声明 `read-only`、`shared-write` 或 `isolated-delivery` 工作区模式；同一 checkout 的共享写任务互斥。隔离 worktree 固定在 `~/.codex-harness/agent-worktrees/<run-id>`，完成后保留，不自动清理。
- 清理隔离 worktree 不得使用 `--force`；有未提交改动时必须失败并保留目录，分支始终保留。
- `completion: 'return-to-parent'` 只能由用户在子任务完成后手动回传一次；父会话 active 时必须拒绝，不能自动形成父子多轮循环。
- 快捷命令必须通过 `harness.quickCommands` 调用 Rust 固定允许的命令，插件不能执行任意 shell 字符串。

## 状态、安全与运行时

- UI 状态和输入区未发送草稿保存在 `~/.codex-harness/state.sqlite`；草稿成功发送后清除，不得写入已发送的会话正文、凭据或模型 response。API Workbench 使用独立数据库，Secret 变量只进 macOS Keychain。
- Harness 复用或启动共享 `codex app-server daemon`；关闭 Harness 不停止 daemon。由 Harness 启动 daemon 时，必须从实际 `.codex` 安装路径推导并显式设置真实用户的 `HOME`、`CODEX_HOME`，文件描述符软限制为 4096。
- Claude Provider 是独立常驻 daemon；涉及 Claude 时先读 `.harness/architecture.md`，本次 Codex token 工作不主动扩展 Claude 范围。
- 图片使用 App Server 的 `localImage` 输入，普通文件使用结构化 `mention`；附件只保留在输入草稿和 Codex 会话中。
- 斜杠命令先由 `composerCommands.ts` 精确匹配并在本地执行；HTTP(S) 链接经 bridge 打开系统浏览器，不让 WebView 离开应用。

## 交付约定

- 本仓库所有改动都通过 GitHub Pull Request 进入 `main`，不得直接在 `main` 上修改、commit 或 push；详见 [.harness/github.md](.harness/github.md)。
- branch、commit、PR 和 release 不要求 Jira key，不得因缺少 Jira key 阻塞交付或自行编造 key。

## 常用命令

```bash
pnpm install
pnpm tauri dev
pnpm tauri:dev
pnpm test
pnpm test:watch
pnpm build
pnpm build:dev
(cd src-tauri && cargo test)
pnpm tauri:build
pnpm tauri:build:dev
```

`pnpm tauri dev` / `pnpm tauri:build` 是蓝色稳定版；`pnpm tauri:dev` / `pnpm tauri:build:dev` 是绿色开发版。两个 flavor 都构建 `universal-apple-darwin`，并共享 `~/.codex-harness`、Codex 配置和会话历史。

## 验证与版本边界

- 前端单元测试使用 Vitest，Rust 单元测试使用 `cargo test`；测试必须使用临时目录或注入依赖，不得触碰真实 `~/.codex` 或 `~/.codex-harness` 数据。
- 新增可独立验证的逻辑要补测试；改动 UI 或 IPC 流程至少执行 `pnpm build`。
- 发布前的完整门禁、版本递增、release commit、tag、安装、上传和远端核对流程只在明确发布授权后执行，详见 `harness-release` Skill。
- 已用于 release commit、构建发布或同名 tag 的版本不得继续承载后续改动；后续改动先按 SemVer 递增版本号，major 必须取得用户明确确认。

## 改动原则

- 保持 TypeScript 与 Rust IPC 参数、返回值和错误语义一致。
- 优先做小而聚焦的改动；不顺带重构无关代码。
- 只有稳定且会影响后续协作的约定才进入本文件或 `.harness/`，临时判断不要固化。
