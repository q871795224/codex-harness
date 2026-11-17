# Superbot 会话

Superbot 是 Harness 的第三种会话。它连接公司 Collab 的 naming 工作区和 SuperBot Agent，执行发生在公司的公共 DEMS Cloud；Codex、Claude 的本机工作区、Skills、MCP、项目文档和终端不会自动传给它。

## 使用

1. 已安装公司 Multica CLI 的机器先执行 `multica --server-url https://collab.shopee.io login`。Harness 原生层每次请求读取默认 `~/.multica/config.json` 的 token；进程显式设置的 `MULTICA_TOKEN` 优先。不扫描其他 profile，不调用 CLI setup，不启动本机 daemon。
2. 在「新会话」右侧选择 Superbot，然后新建；已有 Superbot 会话显示在「Superbot · 公司云端」分组。
3. 选择模型和推理强度后发送文字。默认选项沿用远端 Agent 配置；显式选择使用当前消息的 `run_config.model` / `thinking_level`，不修改 Agent 全局配置。
4. 会话页支持历史分页、执行过程、停止、重命名、归档/恢复和跳转原网页。运行中只开放停止与草稿编辑，归档前需先停止任务。

登录过期或离开公司网络时，页面保留草稿并显示错误。恢复网络/重新登录后点击刷新。发送超时或响应中断时，先刷新历史核对是否已接收，再决定重发；客户端不自动重试发送。文本大小上限为 256 KiB。

## 协议与运行状态

Rust `superbot.rs` 是唯一 Collab 网络入口，固定访问 `https://collab.shopee.io`，请求携带 naming workspace header。IPC 使用封闭的操作枚举，不接受 URL、HTTP method 或通用 API path。原生层验证远端会话的 workspace、agent、只读和归档状态，拒绝重定向；错误信息不回显响应正文或 token。

会话 ID 使用 `superbot:<remote UUID>`，没有本机 cwd。标题栏、消息、执行过程、模型选择和输入框复用 Codex/Claude 的共享会话组件；Superbot 只适配数据与能力，不维护单独的样式。模型目录由公共 runtime 的模型发现接口返回。Collab 创建新会话时会记录目录中的旧系统 DEMS runtime；发送前要求当前公共 DEMS Cloud 在线，且会话绑定也是同一系统所有者的公共 DEMS runtime，拒绝个人或私有 runtime。真正的 dispatch 和运行环境选择沿用 Collab 服务端。

第一版使用 HTTP 轮询：当前会话运行中约 2.5 秒刷新状态、最新历史和任务记录，空闲时约 15 秒刷新；会话列表约 30 秒刷新，已观察到的后台运行也会继续核对。请求串行续排，不把网络延迟叠加为无界并发。断开窗口或退出 Harness 不停止云端任务，重新打开后从远端恢复。此版本未接 WebSocket，也不承诺逐 token 流式显示。

历史与执行记录只保存在界面内存，未发送草稿复用核心 ComposerDraft 存储。凭据、已发送的正文、模型回复和工具输入输出不写入 Harness 状态数据库或诊断日志。远端文件链接和图片不会触发本机文件读取；外部链接仍经 bridge 打开系统浏览器。

## 第一版边界

只接文字聊天，不接本机附件、项目背景自动注入、Router、Git、终端、团队任务、SeaTalk 续聊、Skills/MCP 配置、用量统计和审批交互。云端工具行为由公司 Superbot 的配置决定；需要完整功能或遇到需要人工操作的任务时，可打开原 Collab 会话处理。

自动测试使用临时文件、localhost HTTP fixture 和模拟 IPC，不依赖公司网络或真实 token。真实服务核验覆盖登录、会话/历史读取、模型目录、公共云状态，以及空会话创建和归档；没有向真实 Superbot 发送测试消息。
