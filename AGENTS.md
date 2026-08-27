# Codex Harness 协作说明

## 项目边界

- `src/` 是 Vite + React + TypeScript 前端：界面、状态管理和展示逻辑。
- `src-tauri/` 是 Tauri 的 Rust 原生层：应用入口、Tauri IPC 命令、本地 SQLite 状态，以及到 Codex App Server 的 Unix socket/WebSocket 连接。
- 前端只能经 `src/core/runtime/bridge.ts` 调用原生能力；新增 IPC 时，同时在 Rust 中注册命令，并在 bridge 中提供类型化封装。
- `src/core/domain/` 放共享领域类型和格式化逻辑；按界面功能组织的代码放在 `src/features/`。
- `src/core/plugins/` 放 Harness 插件内核与 React host，`src/plugins/` 放随 App 发布的内置插件；插件只能通过 `src/extensions/types.ts` 中的 context、service、event 和 slot 契约接入能力。
- 插件实例归属于 `global`、`workspace` 或 `thread`。实例生命周期独立于当前选中的会话，切换页面只改变 contribution 可见性，不能中断后台任务或连接。
- `src-tauri/src/app_server.rs` 是唯一可直接接触 App Server 传输协议的模块。不要在 React 组件中直接实现协议或连接逻辑。
- Skill 的发现、解析、启停状态和最终列表以共享 App Server daemon 为准，前端不要自行扫描或解析 `SKILL.md`。
- MCP 是共享 App Server daemon 的全局配置：应用核心启动时加载一次，仅在用户手动 reload 时刷新；打开设置页不重复请求，状态只显示 App Server `config/read` 的启用/停用配置，不展示会话级连接状态。
- Codex 原生能力（模型、推理强度、审批、上下文、附件、Skills 与 MCP）属于 Harness 核心，不通过 Harness 插件 contribution 实现；默认项和管理入口放在设置界面，会话级覆盖放在输入框。
- 新会话空白区的增强 UI 使用 `newThreadPanels` 插件 slot；插件通过宿主传入的类型化会话设置更新函数修改模型、推理强度、审批 reviewer 和 sandbox，不能自行连接 App Server。
- Codex Radar 网络请求由 Rust 原生层的固定域名客户端完成并缓存，内置会话启动器插件只能通过 `harness.codexRadar` service 读取整理后的模型指标。
- 图片使用 App Server 的 `localImage` 输入，普通文件使用结构化路径 mention；附件只保留在输入草稿和 Codex 会话中，不写入 Harness 状态库。

## 本地状态与安全

- 本地 UI 状态保存在 `~/.codex-harness/state.sqlite`；不要把会话正文、凭据或 token 写入该库。
- 启动时会复用或启动 `codex app-server daemon`；关闭 Harness 不应停止该 daemon。
- Harness 管理 daemon 时必须从实际 `.codex` 安装路径推导并显式设置真实用户的 `HOME` 与 `CODEX_HOME`，不能继承 `codex-personal` 等隔离环境；新启动 daemon 的文件描述符软限制设为 4096。

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
