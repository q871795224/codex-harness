# 记忆阶段 1：按钮保存

2026-09-21。本阶段实现用户点击“保存到记忆”，临时 Agent 提炼当前会话，Harness 校验并写入正文与索引。模板已完成初步对齐。纠正、遗忘、轮转、自动记忆和新会话召回留到后续阶段。

## 目录与身份

```text
~/.codex-harness/memory/
├── global/
│   ├── memory_summary.md
│   └── MEMORY.md
├── domain/<domain-name>/
│   ├── memory_summary.md
│   └── MEMORY.md
└── workspace/
    ├── <workspace-name>/
    │   ├── memory_summary.md
    │   └── MEMORY.md
    └── other/
        ├── memory_summary.md
        └── MEMORY.md
```

| 项目 | 当前方向 |
| --- | --- |
| 全局 | 固定使用 global |
| 领域 | 一个领域一个目录，以唯一的 domain name 作为键和目录名 |
| Git 工作区 | 同一仓库的 linked worktree 共用工作区记忆，以 Git common directory 识别其归属 |
| 独立 clone | 即使远端相同，也先分别识别；跨 clone 合并暂不处理 |
| 非 Git 目录 | 按用户提议统一放 workspace/other；条目仍保留来源目录和适用范围，共用目录不代表全部知识通用 |

领域名称在领域内唯一，工作区名称在工作区内唯一，分别直接作为目录名和关联键；允许领域与工作区同名。other 是保留的工作区名称。Git common directory 用于识别仓库与 worktree 的归属，与名称分开保存。名称作为单个目录名使用，重名时需另取名称。当前名称允许文字、数字、连字符、下划线和点，不能以点开头。同名不同仓库报告冲突，不自动合并。改名和仓库搬迁后续处理。

## 关联存储

复用 Harness 现有的 `~/.codex-harness/state.sqlite`，新增记忆管理相关表，沿用现有数据库初始化与迁移方式：

| 数据 | 最小内容 |
| --- | --- |
| 领域 | domain_name，唯一键 |
| 记忆工作区 | workspace_name，唯一键；Git common directory；other 为保留项 |
| 领域与工作区关联 | domain_name、workspace_name，多对多 |

例如 dns-agent 和 dpdkdns 都关联 DNS 领域，在对应工作区执行任务时，可以找到 DNS 领域的记忆入口。是否读取具体内容仍取决于任务。

记忆正文以 Markdown 为准，SQLite 先只保存身份与关联，不保存另一份正文。记忆表随 Harness 状态库初始化；保存前登记来源工作区，领域及其关联在工作区设置中维护。现有应用工作区的内部标识保持不变，复用其 Git common directory 归属解析结果进行映射。本次开发验证使用临时目录，没有迁移或写入真实记忆。

## 两份模板

| 文件 | 用途 |
| --- | --- |
| [memory_summary.md](memory_summary.md) | 简短说明和主题入口，帮助决定是否读取正文 |
| [MEMORY.md](MEMORY.md) | 按主题保存具体记忆，附来源、时间和适用范围 |

模板中的尖括号都是待填写内容，不是真实记忆。三个范围共用模板，YAML front matter 填写对应的 scope，例如 `global`、`domain/dns`、`workspace/dns-agent`、`workspace/other`。scope 是文件元信息，正文不重复填写。other 中的记忆尤其需要填写具体适用目录或明确的通用条件。

一条新增记忆先包含：稳定 ID、类型、写入时间、来源、适用条件、具体内容。验证时间和证据在有依据时填写；缺失时保留“未验证”，不因成功落盘就标记为事实已确认。新增条目同时在索引增加入口，详细内容只保留在正文。

本阶段先跑通用户点击保存，不以完整质量评测为门槛。后续使用实际会话调整提示词、输入配置和范围判断。

## 按钮与执行链路

按钮位于输入框项目归档按钮旁边，hover 和无障碍名称均为“保存到记忆”，无须绑定项目。第一版支持 Codex 会话。运行中禁用重复点击，切换会话后任务继续；关闭应用后不保证前端任务继续处理结果。

1. 核心通过 App Server 分页获取设置指定的会话历史，包含用户/Agent 消息及工具证据；跳过 reasoning 和识别出的 AGENTS.md/skill 注入片段。默认读取全部轮次；指定最近 N 轮时从末尾分页，读够即停止，再按时间正序提炼。不局限于界面已经加载的消息。
2. 读取已保存的记忆设置；未指定提炼模型时跟随 cwd 配置，缺省回退 gpt-5.6-luna。推理强度可配置，默认 low。
3. 优先使用记忆设置指定的窗口大小；为 0 时使用 cwd 的 model_context_window，否则保守回退 150,000；有效窗口比例取 model_effective_context_window_percent，缺省 95%。这两项作为临时线程覆盖配置显式传入，不修改用户配置。
4. 按设置的有效窗口比例分配输入预算（默认 70%），以 UTF-8 字节 / 4 估算 token。先预留提炼指令、输出 schema 和范围信息；剩余预算用于会话内容。未超限时完整保留，超限时保留首尾并标记中间省略。该估算不等同模型 tokenizer 或最终实际 usage。
5. 核心启动 ephemeral、read-only 的 Agent，关闭原生 memory、hooks、Apps、Plugins 和已配置的 MCP；使用 turn/start.outputSchema 约束返回 JSON。Agent 只提炼，不负责文件写入，允许返回空列表。
6. Harness 校验整批候选的类型、来源 turn、范围和路径，再追加到 MEMORY.md 和 memory_summary.md。scope 写入 YAML front matter。领域和关联由用户在工作区设置中维护。候选只能选择当前来源工作区已关联的领域，落盘时在写事务内重新检查关联。
7. 通知展示保存数量、标题、范围与文件位置；空结果显示“本次没有值得保存的记忆”；提炼、解析或落盘失败显示失败，不误报保存成功。

记忆的目录初始化发生在首次实际写入时。正文是唯一知识正文；索引只保留标题、适用条件和锚点。完全相同的范围、类型、内容、适用条件生成相同条目 ID，重复操作不会再次追加；尚不做语义去重或更新合并。

文件批次写入受 SQLite 写事务锁协调，临时文件替换单个文件；`.pending.json` 临时日志用于恢复中断的正文/索引批次，成功后删除。失败后的下一次记忆操作先恢复未完成批次。只有文件批次成功才报告已保存。

## 文件查看与编辑

Harness tab 使用同一文件树：虚拟 `harness` 根下展示全局和工作区指令文档，工作区 `.harness` 位于对应实际目录内；`memory` 根展示 Harness 记忆目录中的 Markdown 文件。

现有 MEMORY.md 与 memory_summary.md 支持编辑，scope 必须与目录一致。保存正文会根据条目 ID、标题和适用条件重建索引；直接编辑索引的内容会在下一次正文保存时被重建。保存前比较读取时的正文，发现并发变化则保留草稿并报错，刷新确认后重新读取。记忆文件不通过此入口新建、重命名或删除，历史 Markdown 目前只读。删除正文条目会移除对应索引入口，尚不具备阻止历史重提炼的永久忘记语义。

## 工作区领域标签

在“设置 → 工作区”的“领域标签”区域创建或删除领域，在每个工作区下点击 tag 关联或解除关联。一个工作区可以选择多个 tag，一个领域可以覆盖多个工作区；linked worktree 继承主仓库的关联。other 行管理所有非 Git 目录共用的领域。

- 名称使用现有目录命名约束，创建时去除首尾空白，拒绝仅大小写不同的重复名称。
- 删除领域需在界面再次确认，将删除领域定义及所有关联，记忆文件保留；重新创建同名领域后可继续使用原目录。解除单个 tag 只影响对应工作区。
- 提炼输入只列出来源工作区当前关联的领域。模型不再输出 relatedWorkspaces，也不能创建领域或修改关联；工作区范围仍可按实际讨论内容选择已知工作区。
- Harness 写入前重新校验领域关联；提炼期间解除 tag 或删除领域，旧候选会被拒绝，需重新提炼。
- 单个 tag 使用增量绑定/解绑，避免一个窗口覆盖另一个窗口对其他 tag 的修改。接口失败保留错误反馈，可刷新后重试。

## 核心设置

在“设置 → 记忆”统一编辑并保存以下配置：

| 配置 | 默认值 | 行为 |
| --- | --- | --- |
| 模型 | 跟随工作区默认模型 | 可选择独立的提炼模型 |
| 推理强度 | low | 随所选模型提供支持的选项，也可使用模型默认 |
| 提炼提示词 | 初版提炼指令 | 可直接编辑或恢复默认；结构化输出 schema 仍由核心约束 |
| 上下文轮数 | 0（全部） | 大于 0 时仅取最近 N 个 Codex turn |
| 上下文预算 | 70% | 对选定轮次应用预算，超限时保留首尾 |
| 上下文窗口 | 0（自动） | 可手动指定窗口大小，用于不同模型或自定义模型 |

设置保存在共享状态库 app_state 的 memory.settings.v1。点击“保存设置”后下次提炼生效，运行中任务不变；“恢复默认”先填入草稿，保存后生效。记忆按钮直接属于核心 UI，不受项目文档或其他插件启停影响。设置加载失败或内容无效时报告错误，不悄悄使用另一份配置执行。

## 代码与验证

| 部分 | 入口 |
| --- | --- |
| 核心按钮 | [MemoryButton.tsx](../../../src/features/memory/MemoryButton.tsx) |
| 核心设置 | [MemorySettings.tsx](../../../src/features/settings/MemorySettings.tsx) |
| 会话获取与临时 Agent | [核心服务](../../../src/core/memory/service.ts) |
| 提炼提示词、schema、截断 | [extraction.ts](../../../src/core/memory/extraction.ts) |
| SQLite 与 Markdown 写入 | [store/memory.rs](../../../src-tauri/src/store/memory.rs) |

本机 CLI 0.155.1 的 experimental App Server schema 已核对 ephemeral、outputSchema、分页和 thread/unsubscribe 字段。没有发送真实模型请求；真实会话下的提炼质量和实际模型 token 开销尚未验证。

测试覆盖完整分页、70% 预算与中文首尾截断、空结果、结构化结果、重复点击、超时、保存失败，以及临时目录中的 scope、来源校验、名称冲突、非 Git other、并发追加、重复写入和中断恢复。领域标签增量另覆盖多对多关联、重复名称、解绑/删除后的写入拒绝、worktree 继承、文件保留和中文输入法。完整 Vitest 675 项、Rust 157 项及前端构建通过。

## 参考与调整

参考已有《Codex 原生记忆机制》调研的 rust-v0.154.0 固定版本：短摘要与检索入口放 memory_summary.md，按任务或主题组织的详细经验放 MEMORY.md。

本草稿增加 Harness 的范围和条目 ID，简化为“主题 → 条目 → 内容与来源”。没有照搬原生流水线、会话摘要目录、skills 或摘要首行 v1 的兼容约束，也不作为 Codex 原生记忆文件使用。

源码依据：[固定版本整合提示词](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/memories/write/templates/memories/consolidation.md)。本轮沿用已有版本调研，不声明当前新版行为。
