# GitHub 交付与发布协作

本文是 Codex Harness 在 GitHub 上进行分支开发、Pull Request 合并和发布衔接的约定。具体构建、安装、制品上传和发布核对仍以项目级 Skill `.agents/skills/harness-release/SKILL.md` 为准。

## 基本约束

| 事项 | 约定 |
| --- | --- |
| 默认分支 | `main` |
| 代码交付 | 所有改动都通过 GitHub Pull Request 进入 `main` |
| 直接修改 `main` | 禁止在 `main` 上承载任务改动、直接 commit 或直接 push |
| Jira key | branch、commit、PR 和 release 都不要求 Jira key；不得因缺少 Jira key 阻塞交付，也不得自行编造 key |
| 默认合并方式 | 使用 **Squash and merge**；需要保留原始提交历史时由用户另行指定 |
| 必需检查 | PR 必须基于最新 `main`，并通过分支保护要求的 checks；当前要求 `test-and-build` |

开始修改前先 fetch 最新远端，从 `origin/main` 创建描述性分支。当前 checkout 不适合切换分支时，使用独立 worktree，保留用户已有的未提交改动。

## 标准交付流程

```text
origin/main
    │
    ├─ 创建任务分支或独立 worktree
    │
    ├─ 修改、测试、commit
    │
    ├─ push 分支并创建 PR
    │
    ├─ 同步最新 main，等待 required checks
    │
    └─ 获得合并授权后 Squash and merge
                         │
                         └─ 回读 PR 与 main，确认远端终态
```

分支名、commit message 和 PR 标题应直接描述改动，例如 `docs/github-workflow`、`fix/session-status`。不添加无来源的 Jira key 或其他工单前缀。

PR 创建后检查以下信息：

- base branch 是 `main`，head branch 和目标改动一致；
- diff 不包含其他任务或用户未提交的改动；
- PR 可合并且没有未解决冲突；
- required checks 已实际创建并成功完成；
- PR 落后于 `main` 时先同步，再依据新 head SHA 检查 CI。

`Update branch` 会通过 merge commit 同步 `main`，不会重写已有提交；`Update with rebase` 会重写 PR 分支提交。多人共享分支或没有特别要求时使用 `Update branch`。最终采用 squash merge 时，中间的 merge commit 不会进入 `main`。

如果 required check 长时间处于 expected 或 pending，但 PR head 上没有 check run，先确认 workflow 是否已存在于默认分支并能被当前事件触发，不能把“没有启动”当作“仍在执行”。

## Agent 的 GitHub 操作权限

Agent 可以使用当前环境提供的 GitHub 工具、GitHub CLI 或 GitHub API 完成操作，不要求用户手动点击网页。操作权限按影响区分：

| 操作 | 要求 |
| --- | --- |
| 查询仓库、PR、checks、workflow 和分支保护 | 可为当前任务直接执行只读检查 |
| push 分支、创建或更新 PR | 用户要求交付 PR，或当前任务明确包含这些动作时执行 |
| merge PR | 必须获得用户对本次合并的明确授权；仅有“修改代码”“创建 PR”不等于授权合并 |
| bypass 分支保护、跳过失败检查、force push、删除远端数据 | 普通合并授权不包含这些动作；必须有针对该动作的明确授权，并遵守仓库安全约束 |

执行 merge 前重新读取 PR，而不是依赖较早的状态。至少确认目标 PR、base/head、最新 head SHA、mergeable 状态和 required checks。条件满足后默认执行 squash merge，并使用仓库自动生成的 squash commit message；GitHub 当前配置会使用 commit 或 PR 标题，并在正文汇总 commit messages。

合并后回读 PR 状态和 `origin/main`，确认 squash commit 已进入 `main`。是否删除远端分支按用户要求执行，不把删除分支视为 merge 的隐含授权。

## 发布衔接

发布同样遵守 PR 交付，不在 `main` 上直接制作 release commit。先确认本次任务属于哪种范围：

| 范围 | 版本提交与 tag | 安装 | GitHub 远端 |
| --- | --- | --- | --- |
| 开发构建或 smoke test | 不修改版本，不 commit，不打 tag | 不替换稳定版 | 不创建 release PR 或 Release |
| 本机正式发布 | 修改版本并通过 release PR 合入 `main`；在合并后的 commit 创建本地 annotated tag | 打包并替换本机稳定版 | push release 分支并合并 PR；不 push tag、不上传制品、不创建 GitHub Release |
| GitHub 正式发布 | 修改版本并通过 release PR 合入 `main`；在合并后的 commit 创建 annotated tag | 打包并替换本机稳定版 | push tag、上传制品并创建 GitHub Release |

“不发布到 GitHub”在本项目中表示不 push tag、不上传制品、不创建 GitHub Release；release PR 仍然需要通过 GitHub 合入受保护的 `main`。如果任务要求完全不写 GitHub 远端，则不能同时形成进入 `main` 的正式版本提交，只能执行开发构建或 smoke test。

本机正式发布和 GitHub 正式发布遵循以下流程：

1. 从最新 `origin/main` 创建 release 分支，按 `harness-release` Skill 修改版本并执行完整门禁。
2. push release 分支并创建 PR；版本文件、release notes 或其他发布改动都通过该 PR 审核。
3. required checks 通过且用户明确授权后，将 release PR squash merge 到 `main`。
4. fetch 并核对远端 `main` 的合并结果。annotated tag 必须指向合并后的 `main` commit，不能指向因 squash 而未进入 `main` 的 release 分支 commit。
5. 从该 commit 打包并安装稳定版。本机正式发布到此结束，tag 只保留在本地；GitHub 正式发布继续 push tag、上传制品并创建 GitHub Release。

发布授权、PR 合并授权和绕过保护授权是不同权限。用户只授权其中一项时，不扩大为其他动作。

Codex Harness 的 GitHub 正式发布使用本项目 workspace 专属的“发布”快捷命令，不使用 Quick Agent。命令只显示基于最新 `origin/main` 计算的 patch 和 minor 两个目标版本号；用户选择版本即授权本次 release PR 在 required checks 通过后 squash merge，并授权创建和 push tag、打包、安装、上传制品及创建 GitHub Release。该授权仍不包含绕过分支保护或失败检查。

发布 runner 使用独立 worktree，并脱离 Harness 应用生命周期执行，避免安装新版本导致发起进程退出后中断任务。运行状态属于 workspace，同 workspace 的所有 thread 展示同一状态和失败卡片；其他项目 workspace 不显示此命令。失败现场和日志保留，只有用户主动要求排查时才启动 Agent。
