import type { PluginInstanceRecord } from '../../extensions/types'

// Preserve an enabled legacy counter configuration before retiring its separate tab.
export function mergeUsagePlugins(instances: PluginInstanceRecord[]): { save: PluginInstanceRecord[]; remove: string[] } {
  const legacy = instances.filter((i) => i.pluginId === 'builtin.codex-analytics')
  if (!legacy.length) return { save: [], remove: [] }
  const usage = instances.filter((i) => i.pluginId === 'builtin.usage')
  const counter = legacy.filter((i) => i.enabled).sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const targets = usage.length ? usage : [{ ...legacy[0], pluginId: 'builtin.usage', instanceId: 'builtin.usage:default', config: {} }]
  return {
    save: targets.map((i) => ({ ...i, enabled: i.enabled || legacy.some((l) => l.enabled), config: {
      ...i.config, tokenCounter: i.config.tokenCounter ?? (counter?.config.tokenCounter === 'official' ? 'official' : 'local'),
    } })),
    remove: legacy.map((i) => i.instanceId),
  }
}
