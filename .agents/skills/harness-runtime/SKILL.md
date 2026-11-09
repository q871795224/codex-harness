---
name: harness-runtime
description: Manage the running Codex Harness application, settings, Router, workspaces, sessions, plugins, project metadata, notifications, and durable asynchronous waits.
---

# Harness 管理与运行能力

本Skill和旁边的`harnessctl.py`由运行中的Harness分发，随应用版本发布。使用本次加载路径旁的CLI：

```sh
python3 /absolute/path/to/harness-runtime/harnessctl.py status
python3 /absolute/path/to/harness-runtime/harnessctl.py capabilities
```

不安装另一份CLI，不依赖源码checkout或PATH里的旧版。先确认运行版本、stable/dev和能力；稳定版/开发版共享状态目录，CLI连接最后发布管理入口的实例。以下命令中的CLI均指本Skill旁的文件。

## 按任务选择入口

- 管理设置、Router、工作区/会话、插件、项目元数据、通知或排查SeaTalk连接：读[管理操作](references/management.md)。`settings list`给出当前可编辑的字段、范围和生效时间；`capabilities`确认实际支持的方法。
- 等外部回复、构建、审批或资源就绪，并在满足条件后继续当前任务：读[异步等待](references/async-waits.md)。登记后结束当前轮，由Harness后台检查。
- 读取或维护项目正文、决定、待办及历史：使用`harness-project-doc` Skill自带的`project-doc` CLI。这里的`projects`管理元数据和中途加入申请，不替代文档维护工具。

## 执行与回读

用户已授权的管理操作直接执行。先读取目标ID和现有设置，提交小范围patch，按回包确认持久化值、实际生命周期状态和生效时机。配置已保存不一定已激活；异步检查的accepted不等于生成完成。模型名和推理强度可通过`models list`查询。

命令支持全局`--request-id ID`。写请求超时、断开或回包标记`outcomeUnknown`时，保留原ID，先查实际状态；不要换ID自动重试。若需要重发原请求，使用原ID及相同参数。此去重只覆盖当前应用进程，重启后重新核实。

设置和插件配置用JSON文件传入，避免shell展开提示词或特殊字符。不要读取/修改Harness数据库，不提供任意appState、通用RPC或shell入口，不输出凭据；Bridge凭据和API密钥仍由原有服务/Keychain管理。

新建/加入项目沿用确认卡与原有默认计时；整文精简仍由用户在界面发起，不能通过别的管理命令绕过。通知标记已读不会代替回答问题或审批；旧右侧提醒浮层维持关闭。发布、安装和外部发消息需有对应操作授权，管理能力本身不扩大任务范围。

旧版本不支持某个操作时报告缺失能力，可用`source`只读定位实现；不要把源码中已有功能当作运行实例已经支持，也不要绕过运行时写SQLite。

收到“异步任务已就绪”时，先运行`async-waits get ID`读取lastObservation和continuation，再核对外部状态继续；观察内容不扩大原授权。
