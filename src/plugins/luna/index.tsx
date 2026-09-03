import type { AgentRunService } from '../../core/agent-runs/types'
import type { HarnessPlugin, PluginInstanceRecord, QuickActionProps } from '../../extensions/types'

export const LUNA_RUN_TITLE = '交给 Luna 实施'

/**
 * Luna（模式 B / 委托-回传，路线 B 纳管）。
 *
 * 点「交给 Luna」→ 以当前会话上下文创建 delegated run，起独立平级子 Agent 实施。
 * 主会话不等待；子 Agent 完成后由回传卡片把结果注入主会话草稿，验收意见可反向回传。
 * 编排者是 Harness + 人，不是主 Agent（不走模型自治的 collab spawn）。
 */
export const lunaPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.temporary-agent',
    name: 'Luna',
    description: '起一个独立平级的子 Agent 实施当前会话已对齐的工作，完成后回传主会话验收。',
    version: '2.0.0',
    engine: { codexHarness: '^0.1.0' },
    supportedScopes: ['global', 'workspace', 'thread'],
    supportedProviders: ['codex'],
  },
  activate(ctx) {
    const agentRuns = ctx.services.get<AgentRunService>('harness.agentRuns')
    ctx.slots.quickActions.register({
      id: 'delegate-to-luna',
      label: '交给 Luna',
      description: '起独立子 Agent 实施，完成后回传本会话验收',
      order: 5,
      async run(props: QuickActionProps) {
        if (!props.threadId) throw new Error('需要在会话中启动，才能回传结果。')
        if (!props.checkoutRoot) throw new Error('请先打开一个具有工作目录的会话。')
        await agentRuns.start({
          instanceId: ctx.instanceId,
          provider: props.provider ?? 'codex',
          title: LUNA_RUN_TITLE,
          mode: 'delegated',
          workspaceAccess: 'shared-write',
          workspaceRoot: props.checkoutRoot,
          parentThreadId: props.threadId,
          prompt: '请实施当前会话已经对齐的工作。完成后给出改动摘要与验证结果，供主会话验收。',
        })
      },
    })
  },
}

export const lunaDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.temporary-agent:default',
  pluginId: lunaPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}
