import type { PluginInstanceRecord } from '../../extensions/types'

export function defaultPluginInstancesToSeed(
  storedInstances: PluginInstanceRecord[],
  defaultInstances: PluginInstanceRecord[],
  removedDefaultInstanceIds: Iterable<string> = [],
): PluginInstanceRecord[] {
  const removed = new Set(removedDefaultInstanceIds)
  return defaultInstances.filter((fallback) =>
    !removed.has(fallback.instanceId)
      && !storedInstances.some((instance) => instance.pluginId === fallback.pluginId),
  )
}

export function removedDefaultPluginInstanceIds(raw: string | null): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value)
      ? [...new Set(value.filter((instanceId): instanceId is string => typeof instanceId === 'string'))]
      : []
  } catch {
    return []
  }
}
