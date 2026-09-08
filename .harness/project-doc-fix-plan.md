# 项目文档插件修复方案（已交付：#37、#38）

> 状态：已实现并合并（#37 = #2+#3；#38 = #1）。本文固化了三个问题的根因与最终方案，作为后续维护的依据。

## 问题诊断（已核实）

1. **#1 审批卡不出现**：根因是「文本协议」对 Agent 几乎必然失败——Agent 写 Status 拿不到真实 seq（首轮注入故意不含 seq），`base_seq` 缺失/不符 → 静默丢弃（无害失败，不出卡不报错）。磁盘证据：所有项目文档 `updated_by` 全是 `user`，无任何 agent 写入。
2. **#2 编辑只能改 Status**:`ProjectEditPanel` 只取 `sectionBody(content,'Status')`;`write_section` 只有分区替换语义，无整文写入通道。
3. **#3 turn 无归档按钮**:`MessageActions` 只接受 copy/fork/raw 三个固定 props、无扩展点；且 agent 消息分支根本没渲染 MessageActions；归档入口目前只在 composer 的 `composer-actions`。

## 已确认的解决方案

### #1 — 砍掉文本协议，改 skill + 本地命令 + HTTP 回传（方案甲传 id）
- **Rust**:harness 起本地 HTTP 服务（`127.0.0.1:0` 随机端口、只收 loopback，参考 api_workbench.rs 的 TcpListener）。
  - `POST /propose` `{thread_id, project_id, section, content}` → 服务端读当前 seq 补 `base_seq` → 写待审批队列 → 返回 202 立即返回（不阻塞 Agent）。
  - `GET /read?project_id=` → 返回当前正文 + seq。
  - 端点/端口写到 `~/.codex-harness/project-doc-server.json` 供 skill 脚本读取。
- **skill 改造**(`.agents/skills/project-doc/`，全局软链不变）：加 `bin/project-doc` wrapper（仿 gitlab-api 模式），子命令 `propose` / `read`;SKILL.md 改为「用 project-doc 命令写文档，不要 emit 标记块」。
- **id 传递（方案甲）**：首轮注入正文加一行机器可读 `<!-- project-doc: project_id=xxx thread_id=yyy -->`,skill 教 Agent 调命令时带上；服务端校验 project 是否真绑在该 thread，不符则拒。
- **审批队列 + UI**：收到 /propose → 落 state.sqlite 待审批 → 复用 ProjectDocApprovalCards 的确认/CAS/冲突逻辑（数据源从扫 transcript 换成读审批队列）。status 走审批卡；log/decisions/openQuestions 服务端直接落盘（保持追加区免审语义）。
- **删除**:`extractProjectDocUpdates` 文本解析、ProjectDocApprovalCards 扫 transcript、ProjectDocLogAutoWriter。
- seq CAS 仍在 Rust write_section 兜底。

### #2 — 编辑全文（直接编辑整篇 markdown）
- Rust `write_document(project_id, base_seq, full_content, updated_by, summary)`：整文替换 + seq CAS + 快照（复用 write_section 临界区/落盘逻辑）。
- bridge + ProjectDocService.writeDocument 透传。
- ProjectTab「编辑」加「编辑全文」模式：textarea 装 snapshot.content 整篇，保存走 writeDocument,CAS 冲突复用现有提示；front matter 仍由 Rust 生成、不进编辑框。

### #3 — turn 右下角归档按钮
- `MessageActions` 加 `trailingActions?: ReactNode`（右对齐 margin-left:auto)。
- ConversationView 透传 `renderAgentTurnActions?(ctx)`,App.tsx 注入（ctx 带 threadId/boundProjectId/items)，仅 boundProjectId 存在时渲染。
- 按钮复用插件 startArchiveRun，挂在 final-answer 的 copy/raw/fork 那行、右对齐。

## 交付
- PR 1(#37):#2 + #3(纯前端 + 一条 Rust 命令，小）— 已合并
- PR 2(#38):#1（大，砍文本协议 + 起 HTTP 服务 + skill 命令）— 已合并
- 分支从 origin/main 拉；不动 main；走 GitHub PR。

## skill 命令上 PATH（已定：方案 B，#40 修 wrapper）

`~/.codex/skills/project-doc` 是指向仓库 `.agents/skills/project-doc/` 的软链，SKILL.md 改动随仓库即时生效。但 `project-doc` **可执行命令**不会因属于 skill 就自动上 PATH。

**定案（方案 B）**：保留 `bin/project-doc` 包装 + `install.toml`，把 wrapper 软链进 `~/.local/bin`（与 yf-skill 装的 bin 同目录）。project-doc 属本仓库 skill、不在 yf-agent-skills 仓库，故不经 `yf-skill install`，直接 `ln -sf` 指向仓库 wrapper。

注意（#40 修复）：wrapper 不能硬编码 `$HOME/.agents/skills/...`——该 skill 在仓库里、经 `~/.codex/skills/` 软链，wrapper 必须按脚本自身所在目录解析 `project_doc.py`。
