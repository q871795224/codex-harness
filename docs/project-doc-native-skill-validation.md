# 项目文档原生 Skill 加载验证

2026-11-05 的验证结果：Claude 的会话级插件加载、显式 Skill 调用与恢复均通过；Codex 0.166.0 在 daemon 已发现 Skill 后可以原生加载及恢复，但本次验证的单独路径输入、按 cwd 额外发现参数没有建立独立的会话级发现。正式接入暂不切换，继续保留现有入口，避免通过共享 daemon 的全局搜索根影响其他会话。

## 验证方法

运行真实 Codex App Server、Claude Code 和 Claude Agent SDK，把模型请求发到进程内的 loopback 假服务。临时 Skill 正文包含随机标记，首轮用户文本不包含该标记；只在真正提交给模型的 `input` / `instructions` 或 `messages` / `system` 中检查它是否出现。假服务返回固定完成结果，不调用真实模型。

每个测试使用临时 HOME、CODEX_HOME、工作区和 Skill 资源，退出后清理。没有连接日常 App Server daemon，没有修改全局 Skill、MCP、配置、应用安装或真实项目文档；也没有通过 developer instructions / system prompt 追加来替代 Skill 加载。仅输出版本、布尔值及次数，不保存模型请求正文或凭据。

测试中的“绑定”模拟宿主传递相应原生 Skill/插件参数，不代表已经完成 Harness 绑定流程的正式接线。这里检验原生机制，不检验真实模型能否正确执行项目文档维护指令。

## 环境与结果

- Codex CLI / App Server：0.166.0。
- Claude Code：2.1.303；Claude Agent SDK：0.3.252。
- macOS arm64；7 组首轮用例，另含 2 次恢复后的模型请求，全部发到本地假服务。

| 用例 | 原生发现结果 | 正文是否进入模型上下文 | 观察 |
| --- | --- | --- | --- |
| Codex：只传独立 Skill 路径 | 未发现 | 否 | turn 正常完成，不能据此认定 Skill 已加载 |
| Codex：`skills/list.perCwdExtraUserRoots` | 未发现 | 否 | 本机 0.166.0 的生成协议没有该字段；接口返回成功也未启用此路径 |
| Codex：隔离 daemon 注册 `skills/extraRoots/set`，使用发现返回的路径 | 已发现 | 是 | `thread/resume` 后不重复传 Skill，正文仍在后续请求中 |
| Codex：已注册，传同一文件的 `/var` 别名路径 | 已发现 | 否 | macOS `/var` 与 `/private/var` 指向同一文件，仍需使用 daemon 返回的规范路径 |
| Codex：已注册，但该会话不传 Skill 输入 | 可发现元信息 | 否 | 可以控制显式正文加载，无法据此声称发现范围也按会话隔离 |
| Claude：传会话本地插件并用 `/plugin:skill` 调用 | 该会话已发现 | 是 | 持久化在临时目录，SDK resume 后正文仍在后续请求中 |
| Claude：不传插件，不调用 Skill | 该会话未发现测试插件 | 否 | 同一测试进程中的宿主资源没有自动加入此会话 |

机器可读结果见 [validation.json](review/project-doc-native-skill/validation.json)。这是当时版本的观测结果，后续升级后应重跑，不把字段缺失或路径行为视为永久限制。

## 对接入方案的影响

原生 Skill 路径本身可用，关键在于由 Provider 发现后再显式调用。Codex 仅提交 `{type: skill, path: ...}` 不足以证明正文已生效；Claude 也需要验证实际调用，而不能只看初始化列表。

当前未确认符合要求的 Codex 会话级发现入口。`skills/extraRoots/set` 是 process 级替换操作；生产环境使用共享 daemon，不能为了本插件擅自改动其他客户端的搜索根，也不能把“只有绑定会话显式加载正文”描述为“其他会话无法发现元信息”。

因此本次 follow-up 只提交验证工具和记录，尚未打包资源或修改正式会话接入。若后续接受共享发现、要求只隔离正文调用，或升级后确认了合适的原生作用域入口，再继续实施 Skill 和命令同版本分发。保持原生加载要求，不以追加普通会话指令作为隐式 fallback。

## 复现

在仓库执行 `pnpm install`，确认本机 `codex`、`claude` 命令可用，然后运行：

```bash
node .agents/skills/harness-codex-audit/scripts/verify-native-project-skill.mjs
```

该脚本是显式执行的本机黑箱检查，不加入常规 CI；CI 环境未安装这两套原生程序。脚本使用临时目录和假模型服务，但会启动本机 CLI/SDK 进程，结果应结合输出版本解读。它不会对日常 daemon 注册搜索根。
