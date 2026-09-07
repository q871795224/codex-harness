import { describe, expect, it } from 'vitest'
import { mergeUsagePlugins } from './usageMigration'
import type { PluginInstanceRecord } from '../../extensions/types'
const record = (pluginId: string, enabled = true, config = {}): PluginInstanceRecord => ({ pluginId, instanceId: `${pluginId}:default`, enabled, config, scope: { kind: 'global' }, createdAt: 0, updatedAt: 0 })
describe('merged usage plugin migration', () => {
  it('preserves an enabled official counter and removes the old instance', () => {
    const result = mergeUsagePlugins([record('builtin.usage'), record('builtin.codex-analytics', true, { tokenCounter: 'official' })])
    expect(result.save[0].config.tokenCounter).toBe('official')
    expect(result.remove).toEqual(['builtin.codex-analytics:default'])
  })
  it('does not enable the official counter from a disabled legacy plugin', () => {
    expect(mergeUsagePlugins([record('builtin.usage'), record('builtin.codex-analytics', false, { tokenCounter: 'official' })]).save[0].config.tokenCounter).toBe('local')
  })
  it('keeps both-disabled plugins disabled', () => {
    expect(mergeUsagePlugins([record('builtin.usage', false), record('builtin.codex-analytics', false)]).save[0].enabled).toBe(false)
  })
  it('restores the single entry for analytics-only users and is idempotent', () => {
    const result = mergeUsagePlugins([record('builtin.codex-analytics')])
    expect(result.save[0].pluginId).toBe('builtin.usage')
    expect(mergeUsagePlugins(result.save)).toEqual({ save: [], remove: [] })
  })
})
