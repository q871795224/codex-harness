import { describe, expect, it } from 'vitest'
import type { PluginInstanceRecord } from '../../extensions/types'
import { defaultPluginInstancesToSeed, removedDefaultPluginInstanceIds } from './defaults'

function instance(pluginId: string, instanceId = `${pluginId}:default`): PluginInstanceRecord {
  return {
    instanceId,
    pluginId,
    scope: { kind: 'global' },
    enabled: true,
    config: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('defaultPluginInstancesToSeed', () => {
  const defaults = [instance('plugin-a'), instance('plugin-b')]

  it('seeds only plugin types that have no persisted instance on first run', () => {
    expect(defaultPluginInstancesToSeed([instance('plugin-a', 'custom-a')], defaults))
      .toEqual([instance('plugin-b')])
  })

  it('does not restore a default instance explicitly removed by the user', () => {
    expect(defaultPluginInstancesToSeed([], defaults, ['plugin-a:default'])).toEqual([instance('plugin-b')])
  })

  it('ignores malformed removal state', () => {
    expect(removedDefaultPluginInstanceIds('{')).toEqual([])
    expect(removedDefaultPluginInstanceIds('["plugin-a:default", 1, "plugin-a:default"]'))
      .toEqual(['plugin-a:default'])
  })
})
