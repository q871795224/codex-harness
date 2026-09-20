# Jev 基础接入

Harness 核心通过 Rust 调用 Vercel AI Gateway 的 `POST /v1/evaluate`，模型固定为 `typesafe-ai/jev`。当前提供配置检查和类型化评估接口，业务功能按需接入。

## 凭据

在 `~/.codex-harness/secrets` 中配置 `VERCEL_API_KEY=你的密钥`。支持裸值、单/双引号、`export ` 前缀和行尾注释，不执行 shell 表达式。每次调用读取最新值，不需要重启来刷新密钥。

密钥不经过前端 IPC，不进入 SQLite 或诊断日志。文件读取失败与缺少密钥分别报错；配置状态只表示本地存在非空凭据，不验证账号权限、余额或模型连接。

## 核心调用

入口见 [bridge](../src/core/runtime/bridge.ts)，类型见 [Jev 领域类型](../src/core/domain/jev.ts)。示例用于 Harness 前端核心模块：

```typescript
const status = await runtime.jevStatus()
if (!status.configured) throw new Error('尚未配置 Jev 密钥')

const result = await runtime.jevEvaluate({
  state: { ticket: '所有用户无法下单，暂无替代方案。' },
  questions: {
    team: {
      type: 'choice',
      instructions: '应该由哪个团队处理？',
      criteria: { engineering: '软件故障', billing: '账单纠纷', other: '其他' },
    },
    impact: {
      type: 'score',
      instructions: '影响程度如何？',
      criteria: ['仅外观问题', '功能受损但有替代方案', '核心流程阻塞且无替代方案'],
    },
    blocked: { type: 'boolean', instructions: '用户当前是否无法下单？' },
  },
})

const answer = result.answers.blocked
if (answer.type === 'boolean') console.log(answer.probability)
```

- `state` 接受字符串、JSON 对象或数组，由调用方提供必要上下文。
- Choice 返回选项和分布；Score 返回等级编号的概率加权平均；Boolean 返回成立概率，不自动转成 true/false。
- 当前封装使用字符串 instructions、Choice 字符串描述、Score 字符串等级。复杂业务在此基础上组织，不承诺覆盖上游所有实验性选项。
- `usage` 保留 inputTokens 和 outputTokens。`costs` 保留美元十进制字符串：cost、marketCost、gatewayCost；null 表示上游未报告，字符串 `"0"` 才表示报告为零。
- Choice/Score 的 confidence 可选。错误通过 Promise rejection 返回字符串，与其他 bridge 命令一致。

## 运行边界

客户端禁用重定向，连接超时 10 秒、总超时 30 秒；请求和响应分别限制为 1 MiB（这是应用字节限制，不代替模型 token 限制）。不自动重试，避免超时后不明确的重复计费，由具体业务决定重试策略。

上游错误只返回 HTTP 状态及固定说明，不转发可能包含输入或凭据的错误正文。响应检查问题名称、类型、候选范围和概率范围；不保证模型判断正确。

应用启动和状态查询不会调用模型。该层不读取会话正文、自动搜索记忆、执行工具或生成聊天回复。插件将来需要通过 `src/extensions/types.ts` 的 service 契约使用，不能直接绕过核心。

## 验证

Rust 测试使用临时凭据文件与本地 HTTP fixture，覆盖实际请求结构、三类答案、费用映射、重定向拒绝、401/402/403/429/503、异常 JSON 和无效概率。测试不读取真实用户目录，也不调用付费模型。

前端 bridge 测试覆盖参数传递、返回类型和错误传播。2026-09-20 手工使用本实现的 Rust 客户端与现有密钥调用真实 Vercel 接口，三类问题均成功：team=engineering、impact=2、blocked.probability=0.98；输入 404 tokens、输出 67 tokens，报告 cost="0"、marketCost="0.000016968"、gatewayCost="0"。临时调用程序已移除，真实请求不属于自动化测试；尚未通过运行中的 Tauri WebView 做交互验证。

参考：[Vercel Evaluation API](https://vercel.com/docs/ai-gateway/modalities/evaluation)、[调研文档](jev-model-research.md)。
