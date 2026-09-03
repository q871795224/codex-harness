---
name: harness-release
description: Use when preparing, packaging, installing, or publishing a Codex Harness release; ordinary development builds and tests do not need this skill.
---

# Codex Harness 发布流程

发布动作需要用户在当前请求中明确授权。先区分 `.harness/github.md` 定义的开发构建、本机正式发布和 GitHub 正式发布。只要求开发构建、测试或 smoke test 时，不执行 release commit、创建/推送 tag、替换稳定版、上传产物或创建 GitHub Release。

开始发布前必须读取 `.harness/github.md`。发布改动通过 release 分支和 Pull Request 进入 `main`，不得直接在 `main` 上修改、commit 或 push；branch、commit、PR 和 release 都不要求 Jira key。

固定步骤使用 `scripts/release.py`，不要重新拼装等价命令，也不要额外运行脚本自身的单元测试。脚本按阶段输出 JSON 结果；失败时保留现场，Agent 只判断异常和授权边界。每个 phase 只启动一次；长命令返回 running session 时只等待同一 session 完成，不检查进程后重新执行，也不以 1 秒间隔轮询。

## 版本和工作树

- 先检查工作树和 diff，确认没有夹带无关改动。
- 版本号一旦用于 release commit、构建发布或同名 tag，后续改动必须先按 SemVer 递增版本号；patch/minor 可直接递增，major 需要用户明确确认。
- 在 `isolated-delivery` worktree 中选择版本后执行 `scripts/release.py prepare <version>`，由脚本从最新 `origin/main` 创建 release 分支并同步 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json`。变更过的内置插件仍由 Agent 检查并同步 manifest 版本。

## 发布前验证

版本修改完成后执行：

```bash
.agents/skills/harness-release/scripts/release.py check <version>
```

脚本执行 required CI 未覆盖的 Rust 测试；PR 的 `test-and-build` 负责前端测试和构建。任一环节失败都不能合并、打 tag 或发布。PR 合并后只执行一次 Tauri 正式构建，不在本地重复 CI 已完成的前端门禁，也不在 merge 前后重复打包。

## 提交、合并、安装和发布

本机正式发布和 GitHub 正式发布获得对应授权且所有门禁通过后：

1. 检查通过且用户已授权本次 PR 合并后，执行 `scripts/release.py submit <version>`。脚本提交并 push release 分支、创建 PR、等待 required checks、校验 head SHA、squash merge，并切到合并后的 `origin/main` commit。
2. GitHub 正式发布获得授权后执行 `scripts/release.py publish <version>`。脚本只在合并后的 `origin/main` 上运行，完成 Tauri 构建、bundle 版本/签名/双架构校验、可恢复安装、进程启动、本地与远端 annotated tag、版本化 zip、SHA-256、GitHub Release 和远端 asset digest 回读。
3. 本机正式发布执行 `scripts/release.py publish <version> --local`，使用同一套机械校验，只保留本地 tag、zip 和安装结果，不 push tag 或创建 GitHub Release。

安装验证不使用截图、OCR、AppleScript UI 遍历或 `pnpm tauri dev`。版本、签名、架构、安装路径和进程启动都通过脚本机械校验；只有用户明确要求 UI 验收时才进行人工界面检查。

不要 amend 已发布的 release commit，不要移动已发布 tag，也不要把普通验证权限当成发布、PR 合并或绕过分支保护的授权。
