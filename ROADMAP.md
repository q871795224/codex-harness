# Codex Harness 产品路线图

更新时间：2026-08-31

## 产品定位

Codex Harness 是 Codex App Server 上的本地工作台，重点是会话组织、运行态可见性和向 IDE / MR 的交付衔接。它不重复实现 GoLand 和 GitLab 已经做得更好的 diff，也不为了对齐 Codex App、Claude Code 或其他 Harness 而复制功能。

功能进入产品前至少满足一个条件：解决现有高频流程中的明确摩擦；让 App Server 已有但不可见的能力变得可操作；或降低并发 Agent 修改同一工作区的风险。

## 已完成的基础

- App Server daemon 复用、会话创建/恢复、分页历史、审批、队列、插话和停止。
- Git 主工作区 / linked worktree 映射与会话导航。
- 模型、推理强度、service tier、审批 reviewer、sandbox、Skills、MCP 和 Codex 更新管理。
- 内置插件内核，以及会话启动器、快捷 Agent、快捷命令、终端、用量、API Workbench 等内置能力。
- 从指定 turn 调用稳定版 `thread/fork` 创建分支，并显示来源关系与共享工作区提示。
- Codex 原生子 Agent 活动卡片：显示动作、状态、任务摘要和目标 thread 跳转。
- Codex 回复与 file change 到 GoLand 文件/行的快捷跳转。
- Vitest、Rust 单元测试、`pnpm test:coverage` 和基线覆盖率门禁。

## 本轮已完成

### 交付衔接

- 会话标题栏提供聚焦的交付动作：打开 GoLand、复制当前分支、打开对应 GitHub PR / GitLab MR 新建页面。
- MR 跳转必须从 Git remote 安全推导，无法识别时只展示可解释的降级动作。
- 不新增 Harness diff；如 GoLand 未来提供稳定的 Changes/Diff 深链，再增加对应快捷入口。

### 并发写入安全

- 为快捷 Agent Job 声明运行模式：只读、共享工作区写入、隔离交付。
- 同一 cwd 已有写任务时，对第二个写任务给出明确冲突提示；不能把“不同会话”误认为“文件已隔离”。
- 只有隔离交付场景需要自动 worktree；不建设通用 Worktree Center。
- 快捷 Agent 运行记录承载隔离交付闭环：打开子会话或 GoLand、复制分支、手动清理干净的 worktree；清理不使用 `--force` 且保留分支。

### Agent Activity

- 基于 transcript 中的稳定 `collabAgentToolCall` 增加会话级 Agent Activity 汇总，不依赖 experimental 父子筛选。
- 汇总运行中、等待审批、失败和已完成子 Agent；审批仍进入 Harness 统一审批流。
- 仅在 App Server 明确支持 direct input 时提供输入；停止和追加任务也必须遵循原生协议能力。

### 工程质量

- 将 App Server method string 收口到类型化 facade，业务组件不再直接发送任意协议方法；ThreadDetail 事件更新、App Server 事件字段解析、会话恢复/新建状态组装、turn 启动/queue/steer 和审批协议映射已抽成可测试逻辑，后续继续拆分其余会话操作。
- 停止包含待处理插话的 turn 时保留原始结构化输入，后续重发不会把图片、Skill 或文件 mention 降级为展示文本。
- 为 fork、事件 reducer、并发写入保护和 IPC 错误分支增加测试；逐步提高覆盖率阈值。
- 按真实 bundle profile 延迟加载设置页、Terminal/xterm 和 API Workbench sandbox；继续以首屏成本而非 warning 数量决定后续拆分。
- 启用 Tauri CSP：生产 WebView 只允许本地资源与 IPC，开发态额外允许 localhost/HMR；API Workbench 脚本执行所需的 `unsafe-eval` 明确保留。

## 明确不做

- Harness 内置 diff、完整 Git 客户端或 MR review 界面。
- `thread/revert` / 已废弃 rollback 的 UI；它们不能恢复工作目录，容易让用户误判。
- 通用 hook 管理器或允许执行任意 shell 的插件接口。
- 外部 Harness 插件市场；在独立 WebView、权限声明和签名模型完成前只维护内置插件。
- 仅为“竞品有”而增加 goals、sections 或手动 compact。需要先由实际使用数据证明场景。

## 发布门禁

普通改动至少执行：

```bash
pnpm test
pnpm build
(cd src-tauri && cargo test)
```

发布时遵循 `AGENTS.md` 的完整测试、Universal App 构建、smoke test、版本和 tag 约束。版本递增和发布都需要单独授权。
