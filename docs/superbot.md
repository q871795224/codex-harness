# Superbot 会话

Superbot 是 Harness 的第三种会话。它连接公司 Collab 的 naming 工作区和 SuperBot Agent，执行发生在公司的公共 DEMS Cloud；Codex、Claude 的本机工作区、Skills、MCP、项目文档和终端不会自动传给它。

## 使用

1. 已安装公司 Multica CLI 的机器先执行 `multica --server-url https://collab.shopee.io login`。Harness 原生层每次请求读取默认 `~/.multica/config.json` 的 token；进程显式设置的 `MULTICA_TOKEN` 优先。不扫描其他 profile，不调用 CLI setup，不启动本机 daemon。
2. 点击「新会话」右侧的图标按钮轮换到 Superbot（机器人图标），然后新建；已有会话显示在「Superbot」分组，SeaTalk 来源另带会话图标。
3. 默认模型为 Opus 5.5（`claude-opus-5-5`），推理强度为 `medium`。可以按会话修改，或选择「跟随 Collab 默认」；选择使用当前消息的 `run_config.model` / `thinking_level`，不修改 Agent 全局配置。
4. 会话页支持历史分页、执行过程、停止、重命名、归档/恢复和跳转原网页。置顶沿用 Harness 本机导航设置，归档/恢复同步 Collab；按钮与 Codex 一样在标题栏悬停或获得焦点时出现。运行中允许排队，服务端就绪时允许插话，归档前需先停止任务。

登录过期或离开公司网络时，页面保留草稿并显示错误。恢复网络/重新登录后点击刷新。发送超时或响应中断时，先刷新历史核对是否已接收，再决定重发；客户端不自动重试发送。文本大小上限为 256 KiB。普通会话可通过 `+` 或剪贴板上传图片、文件，每次最多 10 个、每个不超过 20 MiB；由原生层上传到当前云端会话，再发送附件 ID，本机路径不会写入云端消息。历史显示附件名称，点击通过浏览器查看；SeaTalk 来源会话沿用 Collab 网页规则，暂不开放上传。

输入纠正、反馈词库、延迟发送复用核心 Composer。延迟支持 1/5/10 分钟和取消，切换会话继续计时，退出 App 取消计时并保留草稿；失败不自动重发。排队由 Collab 服务端保存并自动继续，队列支持撤回和转为插话，能力以服务端 `supports_queue` / `can_guide` 为准；转插话失败时保留已接收的排队消息，不重复发送。

标题下展示云端来源、已绑定仓库和基础分支；当前普通聊天接口不提供云端执行目录和实际 Git 状态，缺失时不猜测，不接入本机工作区操作。左右快捷面板复用现有组件，全局快捷命令可用；需要本机工作区的 Agent 任务保留并禁用，云端会话不显示本机发布入口。

## 协议与运行状态

Rust `superbot.rs` 是唯一 Collab 网络入口，固定访问 `https://collab.shopee.io`，请求携带 naming workspace header。IPC 使用封闭的操作枚举，不接受 URL、HTTP method 或通用 API path。原生层验证远端会话的 workspace、agent、只读和归档状态，拒绝重定向；错误信息不回显响应正文或 token。

普通聊天和 Collab 中已关注的 SeaTalk 私聊话题通过各自的列表接口读取，按远端 ID 合并去重。SeaTalk 话题保留来源标记，归档/恢复使用用户级接口及 `seatalk_archived_at`；取消关注的话题沿用 Collab 的列表规则隐藏。空标题显示「新对话」。

会话 ID 使用 `superbot:<remote UUID>`，没有本机 cwd。标题栏、消息、执行过程、模型选择和输入框复用 Codex/Claude 的共享会话组件；Superbot 只适配数据与能力，不维护单独的样式。模型目录由公共 runtime 的模型发现接口返回。Collab 创建新会话时会记录目录中的旧系统 DEMS runtime；发送前要求当前公共 DEMS Cloud 在线，且会话绑定也是同一系统所有者的公共 DEMS runtime，拒绝个人或私有 runtime。真正的 dispatch 和运行环境选择沿用 Collab 服务端。

第一版使用 HTTP 轮询：当前会话运行中约 2.5 秒刷新状态、最新历史和任务记录，空闲时约 15 秒刷新；会话列表约 30 秒刷新，已观察到的后台运行也会继续核对。请求串行续排，不把网络延迟叠加为无界并发。断开窗口或退出 Harness 不停止云端任务，重新打开后从远端恢复。此版本未接 WebSocket，也不承诺逐 token 流式显示。

历史与执行记录只保存在界面内存，未发送草稿复用核心 ComposerDraft 存储。凭据、已发送的正文、模型回复和工具输入输出不写入 Harness 状态数据库或诊断日志。远端文件链接和图片不会触发本机文件读取；外部链接仍经 bridge 打开系统浏览器。

## 第一版边界

支持文字及普通会话附件，不接项目背景自动注入、Router、Git、终端、团队任务、Harness 的 SeaTalk 远程控制通道、SeaTalk 绑定/关注/同步管理、Skills/MCP 配置、用量统计和审批交互。云端工具行为由公司 Superbot 的配置决定；需要完整功能或遇到需要人工操作的任务时，可打开原 Collab 会话处理。

自动测试使用临时文件、localhost HTTP fixture 和模拟 IPC，不依赖公司网络或真实 token。真实服务核验覆盖登录、会话/历史读取、模型目录、公共云状态和会话元数据，以及首版空会话创建和归档；本次附件、排队、插话与停止用 localhost fixture 验证，没有向真实 Superbot 发送测试消息或上传文件。
