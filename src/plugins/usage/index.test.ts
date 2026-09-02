import { describe, expect, it } from 'vitest'
import type { UsageProvider } from '../../core/usage/types'
import { PluginHost } from '../../core/plugins/runtime'
import { usageDateRange, usageDefaultInstance, usagePlugin, weakestQuota } from './index'

function provider(id: UsageProvider['id'], remaining: number): UsageProvider {
  return {
    id,
    label: id,
    sourceKind: id === 'ais' ? 'ais' : id === 'claude' ? 'claude' : 'codex',
    status: 'ready',
    message: null,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, costUsd: 0 },
    periods: [],
    models: [],
    quota: [{ label: '窗口', usedPercent: 100 - remaining, remainingPercent: remaining, windowDurationMins: null, resetsAt: null }],
    budget: null,
  }
}

describe('usage date ranges', () => {
  const now = new Date(2026, 7, 30, 12)

  it('builds inclusive rolling ranges in local time', () => {
    expect(usageDateRange('7d', now)).toEqual({ since: '2026-08-24', until: '2026-08-30' })
    expect(usageDateRange('30d', now)).toEqual({ since: '2026-08-01', until: '2026-08-30' })
  })

  it('starts the month range on the first day', () => {
    expect(usageDateRange('month', now)).toEqual({ since: '2026-08-01', until: '2026-08-30' })
  })
})

describe('usage quota summary', () => {
  it('finds the most constrained rate window', () => {
    expect(weakestQuota([provider('codex-business', 70), provider('codex-personal', 18)])?.provider.id).toBe('codex-personal')
  })
})

describe('usage plugin', () => {
  it('registers one global tab backed by the restricted usage service', async () => {
    const host = new PluginHost([usagePlugin], {
      storage: () => ({ get: async () => null, set: async () => undefined }),
      services: { 'harness.usage': {
        cachedSnapshot: async () => null,
        refreshSnapshot: async () => ({ fetchedAt: 0, since: '', until: '', providers: [] }),
      } },
    })
    await host.syncInstances([usageDefaultInstance])
    const tabs = host.resolvedTabs({ threadId: 'thread-1', threadCwd: '/repo', workspaceRoot: '/repo' })
    expect(tabs).toHaveLength(1)
    expect(tabs[0].contribution.label).toBe('用量')
    await host.dispose()
  })
})
