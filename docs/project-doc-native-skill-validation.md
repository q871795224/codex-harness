# 项目文档原生 Skill 加载验证

2026-11-05 的验证结果：Codex 0.166.0 与 Claude Code 2.1.303 / SDK 0.3.252 均支持本项目采用的原生 Skill 加载与恢复。用户确认共享发现元信息可接受，正式接入采用应用自带资源、仅绑定会话主动调用；不再要求发现范围也按会话隔离。当时 Codex 不替换共享 daemon 的搜索根，由原生 user-Skills 目录发现应用专属链接；2026-11-09 的实现改为版本化真实文件副本，当前约定见 [Skill 分发](../.harness/skills.md)。

## 验证方法

运行真实 Codex App Server、Claude Code 和 Claude Agent SDK，把模型请求发到进程内的 loopback 假服务。临时 Skill 正文包含随机标记，首轮用户文本不包含该标记；只在真正提交给模型的 `input` / `instructions` 或 `messages` / `system` 中检查它是否出现。假服务返回固定完成结果，不调用真实模型。

每个测试使用临时 HOME、CODEX_HOME、工作区和 Skill 资源，退出后清理。没有连接日常 App Server daemon，没有修改全局 Skill、MCP、配置、应用安装或真实项目文档；也没有通过 developer instructions / system prompt 追加来替代 Skill 加载。仅输出版本、布尔值及次数，不保存模型请求正文或凭据。

黑箱中的“绑定”模拟宿主传递的原生 Skill/插件参数；正式绑定和加载标记另由 Rust 测试、Claude daemon 集成测试覆盖。这里检验原生机制，不检验真实模型能否正确执行项目文档维护指令；没有启动并操作正式 Harness UI。

## 环境与结果

- Codex CLI / App Server：0.166.0。
- Claude Code：2.1.303；Claude Agent SDK：0.3.252。
- macOS arm64；9 组首轮用例，另含 3 次恢复后的模型请求，共 12 次请求，全部发到本地假服务。

| 用例 | 原生发现结果 | 正文是否进入模型上下文 | 观察 |
| --- | --- | --- | --- |
| Codex：只传独立 Skill 路径 | 未发现 | 否 | turn 正常完成，不能据此认定 Skill 已加载 |
| Codex：`skills/list.perCwdExtraUserRoots` | 未发现 | 否 | 本机 0.166.0 的生成协议没有该字段；接口返回成功也未启用此路径 |
| Codex：隔离 daemon 注册 `skills/extraRoots/set`，使用发现返回的路径 | 已发现 | 是 | `thread/resume` 后不重复传 Skill，正文仍在后续请求中 |
| Codex：已注册，传同一文件的 `/var` 别名路径 | 已发现 | 否 | macOS `/var` 与 `/private/var` 指向同一文件，仍需使用 daemon 返回的规范路径 |
| Codex：已注册，但该会话不传 Skill 输入 | 可发现元信息 | 否 | 可以控制显式正文加载，无法据此声称发现范围也按会话隔离 |
| Codex：应用托管 user-Skill 链接，与旧 project-doc 并存 | 两者均发现 | 是 | 使用 Git 中真实 Skill 和命令资源；路径含空格；恢复后保留正文，旧 Skill 仍可发现 |
| Codex：托管链接存在，未绑定会话不传 Skill 输入 | 已发现 | 否 | 不替换全局 extraRoots，也不主动调用正文 |
| Claude：传会话本地插件并用 `/plugin:skill` 调用 | 该会话已发现 | 是 | 持久化在临时目录，SDK resume 后正文仍在后续请求中 |
| Claude：不传插件，不调用 Skill | 该会话未发现测试插件 | 否 | 同一测试进程中的宿主资源没有自动加入此会话 |

机器可读结果见 [validation.json](review/project-doc-native-skill/validation.json)。这是当时版本的观测结果，后续升级后应重跑，不把字段缺失或路径行为视为永久限制。

## 对接入方案的影响

原生 Skill 路径本身可用，关键在于由 Provider 发现后再显式调用。Codex 仅提交 `{type: skill, path: ...}` 不足以证明正文已生效；Claude 也需要验证实际调用，而不能只看初始化列表。

`skills/extraRoots/set` 是 process 级替换操作，正式实现不使用它。2026-11-05 方案使用 `harness-project-doc` 专属链接；2026-11-09 改为 App 发布 `harness-project-doc-<内容版本>` 真实文件副本，不创建或更新软链。Skill 名称仍为 `harness-project-doc`，指令和 CLI 来自相同 Git 源码；旧资源、用户 Skill 与搜索配置保留。由 daemon 发现并返回规范路径后再显式调用。

Claude 采用会话级本地插件。验证发现，命令和参数分散在多文本块，或最后一个内容块为图片时，斜杠调用可能正常完成但没有展开 Skill。正式实现仅在首次调用时把图片放前面，所有文本合并到最后一个文本块并加原生命令。黑箱检查原始用户标记、背景标记、图片数据均保留，且 Skill 正文加载、恢复均通过；daemon 集成测试同时确认界面用户消息不被改写。

两套 Provider 都不以 developer instructions / system prompt 追加作为 fallback。加载标记按项目、会话、Provider 和资源版本保存，发送失败不标记；恢复与后续回合不重复加载同版本。资源随原生二进制编译，运行时按内容版本落盘，只分发执行所需文件；设计沿革不进入运行资源。开发测试没有替换本机现有全局链接或应用，安装新版 Harness 后才启用此接入。

## 复现

在仓库执行 `pnpm install`，确认本机 `codex`、`claude` 命令可用，然后运行：

```bash
node .agents/skills/harness-codex-audit/scripts/verify-native-project-skill.mjs
```

该脚本是显式执行的本机黑箱检查，不加入常规 CI；CI 环境未安装这两套原生程序。脚本使用临时目录和假模型服务，但会启动本机 CLI/SDK 进程，结果应结合输出版本解读。它不会对日常 daemon 注册搜索根。

2026-11-06 复验（Codex 0.167.0，Claude / SDK 版本不变）：未绑定会话需要通过 Skill 申请新建/加入项目，因此 Claude 的未绑定用例也配置本地插件，验证元信息可发现、正文未主动加载。首次来源标记与 Provider 协议 4 的接入另由 daemon 集成测试覆盖。

本次复验结果见 [native-validation.json](review/project-onboarding/native-validation.json)。上表与旧 validation.json 保留 2026-11-05 的发现范围，复验脚本现按新的未绑定发现要求运行。


## 2026-11-09：真实文件副本复验

Codex 0.167.0、Claude Code 2.1.303 / SDK 0.3.252 在本地假模型服务上完成9组用例，共12次模型请求。Codex的managed两组改为App托管的真实版本目录，没有创建Skill软链；已绑定组显式加载正文并在恢复后保留，未绑定组可发现但没有主动加载正文。旧用户Skill仍可发现，同版CLI可运行。额外放入同名旧版本资源时，当前版本仍能被发现并按规范路径加载。Claude沿用原有App会话插件，两组正文加载与恢复检查继续通过。

机器结果见 [项目文档真实副本复验](review/skill-copies/native-validation.json) 和 [管理Skill复验](review/skill-copies/runtime-validation.json)。管理Skill的3组用例同样验证同名旧版本共存、显式正文加载和恢复。Rust回归另外验证App分发不依赖旧链接、移除旧链接后CLI仍可运行、旧版本保留、用户Skill未被覆盖及资源篡改拒绝。结果只证明加载链路，实际业务配置操作仍由各管理接口测试验证。此次未安装应用，也未修改真实用户Skill目录。
