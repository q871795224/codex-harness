# Codex Harness 协作说明

## 项目边界

- `src/` 是 Vite + React + TypeScript 前端：界面、状态管理和展示逻辑。
- `src-tauri/` 是 Tauri 的 Rust 原生层：应用入口、Tauri IPC 命令、本地 SQLite 状态，以及到 Codex App Server 的 Unix socket/WebSocket 连接。
- 前端只能经 `src/core/runtime/bridge.ts` 调用原生能力；新增 IPC 时，同时在 Rust 中注册命令，并在 bridge 中提供类型化封装。
- `src/core/domain/` 放共享领域类型和格式化逻辑；按界面功能组织的代码放在 `src/features/`。
- `src-tauri/src/app_server.rs` 是唯一可直接接触 App Server 传输协议的模块。不要在 React 组件中直接实现协议或连接逻辑。

## 本地状态与安全

- 本地 UI 状态保存在 `~/.codex-harness/state.sqlite`；不要把会话正文、凭据或 token 写入该库。
- 启动时会复用或启动 `codex app-server daemon`；关闭 Harness 不应停止该 daemon。

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
pnpm tauri build
pnpm tauri:build:dev
```

- `pnpm tauri dev` / `pnpm tauri build` 是蓝色稳定版；`pnpm tauri:dev` / `pnpm tauri:build:dev` 是绿色开发版。
- 两个 flavor 有独立的 macOS Bundle ID，可同时运行；它们有意共享 `~/.codex-harness`、Codex 配置和会话历史。

## 测试与发布

- 前端单元测试使用 Vitest；`pnpm test` 运行一次，`pnpm test:watch` 用于本地开发。
- Rust 单元测试在 `src-tauri/` 中运行：`cargo test`。测试必须使用临时目录或注入的依赖，不能触碰真实 `~/.codex` 或 `~/.codex-harness` 数据。
- 新增可独立验证的逻辑时，应同时补测试与对应的运行命令；改动 UI/IPC 流程时，至少执行 `pnpm build`。

发布前必须依次执行：

```bash
pnpm test
pnpm build
(cd src-tauri && cargo test)
pnpm tauri build
```

随后用 `pnpm tauri dev` 验证创建/恢复会话、消息发送、审批和工作区选择等核心流程。

## 改动原则

- 保持 TypeScript 与 Rust 的 IPC 参数和返回值一致；接口变更应同时更新两侧。
- 优先做小而聚焦的改动，不顺带重构无关代码。
- 更新本文件以记录稳定、会影响后续协作的项目约定，而不是临时进度。
