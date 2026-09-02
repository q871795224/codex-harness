---
name: harness-release
description: Use when preparing, packaging, installing, or publishing a Codex Harness release; ordinary development builds and tests do not need this skill.
---

# Codex Harness 发布流程

发布动作需要用户在当前请求中明确授权。只要求开发构建、测试或 smoke test 时，不执行 release commit、创建/推送 tag、替换稳定版、上传产物或创建 GitHub Release。

## 版本和工作树

- 先检查工作树和 diff，确认没有夹带无关改动。
- 版本号一旦用于 release commit、构建发布或同名 tag，后续改动必须先按 SemVer 递增版本号；patch/minor 可直接递增，major 需要用户明确确认。
- 发布版本同步修改 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`，变更过的内置插件同步更新 manifest 版本。

## 发布前验证

按顺序执行：

```bash
pnpm test
pnpm build
(cd src-tauri && cargo test)
pnpm tauri:build
```

任一环节失败都不能提交、打 tag 或发布。校验构建出的 macOS App 的 `CFBundleShortVersionString` 与目标版本一致；再用 `pnpm tauri dev` 验证创建/恢复会话、消息发送、审批和工作区选择。

## 提交、安装和发布

获得明确授权且所有门禁通过后：

1. 提交 release commit，annotated tag 的 message 概括实际改动，不能只写版本号。
2. 将稳定版 `Codex Harness.app` 安装到 `~/Applications`；旧版本先移入废纸篓或可恢复备份，启动后确认版本、daemon 连接和 initialize 正常。
3. push release commit 和 tag。正式发布时，将 App 压缩为版本化 zip，计算 SHA-256，并创建 GitHub Release；notes 列出主要改动、安装方式和校验值。
4. 最后核对远端 main、tag peeled commit、Release asset、本机安装版本和本地 HEAD 一致，工作树保持干净。

不要 amend 已发布的 release commit，不要移动已发布 tag，也不要把普通验证权限当成发布授权。
