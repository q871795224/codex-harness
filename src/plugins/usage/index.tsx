import { BarChart3 } from 'lucide-react'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'
import type { UsageService } from '../../core/usage/types'
import type { CodexAnalyticsService } from '../../core/codex-analytics/types'
import type { ConversationService } from '../../core/conversations/types'
import { AnalysisPage } from './AnalysisPage'
import { CodexAnalyticsSettings, readCounterMode } from './settings'
import { usageDateRange } from './history'
export { usageDateRange, weakestQuota } from './history'
const USAGE_REFRESH_INTERVAL_MS = 15 * 60 * 1_000

export const usagePlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.usage',
    name: '用量分析',
    description: '分析 Harness 中的 Codex Token、模型、Skill 与 MCP，保留账号额度和历史用量。',
    version: '2.0.0',
    engine: { codexHarness: '^0.8.0' },
    supportedScopes: ['global'],
    permissions: ['local:codex-analytics', 'local:agent-usage', 'network:compass.llm.shopee.io'],
  },
  settings: CodexAnalyticsSettings,
  async activate(ctx) {
    const usage = ctx.services.get<UsageService>('harness.usage')
    const analytics = ctx.services.get<CodexAnalyticsService>('harness.codexAnalytics')
    const conversations = ctx.services.get<ConversationService>('harness.conversations')
    await analytics.configure(readCounterMode(ctx.config))
    const refreshDefaultRange = () => {
      const dates = usageDateRange('30d')
      void usage.refreshSnapshot(dates.since, dates.until).catch(() => undefined)
    }
    refreshDefaultRange()
    const refreshTimer = globalThis.setInterval(refreshDefaultRange, USAGE_REFRESH_INTERVAL_MS)
    ctx.effect(() => globalThis.clearInterval(refreshTimer))
    ctx.slots.conversationTabs.register({
      id: 'usage',
      label: '用量',
      order: 15,
      icon: BarChart3,
      hideComposer: true,
      render: (props) => <AnalysisPage service={analytics} usage={usage} conversations={conversations} threads={props.threads} />,
    })
  },
}

export const usageDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.usage:default',
  pluginId: usagePlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}
