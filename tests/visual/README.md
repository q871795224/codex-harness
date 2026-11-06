# 会话反馈与提醒验收

当前应用保留 main 禁用应用内提醒的策略，通知入口打开历史；本页的右栏仅验证保留组件，不代表应用已启用右栏。

此页直接渲染生产组件 `ConversationHeader`、`ConversationView`、`RouterFeedbackCard`、`UserInputRequestCard`、`Composer` 和 `NotificationViewport`，使用内存数据和模拟发送，不连接原生运行时、不调用模型。页面只供 Vite 开发验证，不进入正式构建。

```bash
pnpm install --frozen-lockfile
CHOKIDAR_USEPOLLING=1 pnpm exec vite --host 127.0.0.1 --port 1435 --strictPort
```

打开 `http://127.0.0.1:1435/tests/visual/conversation-feedback.html`。

- 默认页：点准 / 不准保存反馈，再发送第二条消息，检查路由卡隐藏与输入清空。
- `?scenario=question`：一行答案；Shift+Enter 或长内容自动增高。
- `?theme=light`：浅色主题。
- `?sidebar=1`：284px 侧栏布局占位与完整 tab 列表，用于检查 980×640 最小窗口。占位不模拟侧栏业务。

使用独立 Playwright session 运行 `run-code --filename tests/visual/verify-conversation-feedback.js`，自动检查选中态、发送清空、卡片隐藏、Shift+Enter、自动增高、深浅主题，以及包含侧栏与多个 tab 的最小窗口边界。截图输出到 `output/playwright/`；`screenshots/` 保存本次 PR 的四项实际浏览器截图。

发送中切走并返回、失败保留草稿、后续草稿保护、路由反馈持久化与重开等异步行为由对应 Vitest 覆盖；此页不替代原生应用端到端验证。

## 工作区简介与纠正

启动 `pnpm exec vite --host 127.0.0.1 --port 1439 --strictPort`，打开 `/tests/visual/router-context.html`。
该页用真实 RouterSettings 和 RouterFeedbackCard，加内存数据替代 native 调用，不访问真实缓存或模型。
用独立 Playwright session 执行 `run-code --filename tests/visual/verify-router-context.js`，检查介绍与倒计时、立即更新、第二步模型/推理配置保存、保留旧介绍的失败状态、深浅主题和640px窄窗口。使用 `?scenario=correction` 仍可手工复查原纠正卡片。截图在 `docs/review/workspace-router/`；不代表原生应用和真实模型端到端验收。
