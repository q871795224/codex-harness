import { describe, expect, it } from 'vitest'
import { PluginHost } from '../../core/plugins/runtime'
import { codexAnalyticsDefaultInstance, codexAnalyticsPlugin, formatTokens, readCounterMode } from './index'

describe('codex analytics plugin', () => {
  it('registers a Codex-only analysis tab', async () => {
    const host = new PluginHost([codexAnalyticsPlugin], {
      storage: () => ({ get: async () => null, set: async () => undefined }),
      services: { 'harness.codexAnalytics': { configure: async (mode: 'local' | 'official') => ({ mode, apiKeyConfigured: false, localEstimator: 'test' }), snapshot: async () => { throw new Error('not rendered') } } },
    })
    await host.syncInstances([codexAnalyticsDefaultInstance])
    expect(host.resolvedTabs({ provider: 'codex', threadId: 't', threadCwd: '/repo', workspaceRoot: '/repo' })[0].contribution.label).toBe('Codex 分析')
    expect(host.resolvedTabs({ provider: 'claude', threadId: 't', threadCwd: '/repo', workspaceRoot: '/repo' })).toHaveLength(0)
    await host.dispose()
  })

  it('formats compact token values', () => {
    expect(formatTokens(1_250)).toBe('1.3K')
    expect(formatTokens(2_500_000)).toBe('2.50M')
  })

  it('defaults invalid and legacy config to the local counter', () => {
    expect(readCounterMode({})).toBe('local')
    expect(readCounterMode({ tokenCounter: 'invalid' })).toBe('local')
    expect(readCounterMode({ tokenCounter: 'official' })).toBe('official')
  })
})
