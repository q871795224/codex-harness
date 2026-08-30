import { describe, expect, it } from 'vitest'
import type { HarnessFileNode, HarnessFilesService } from '../../core/harness-files/types'
import { PluginHost } from '../../core/plugins/runtime'
import { flattenNodes, harnessFilesDefaultInstance, harnessFilesPlugin } from './index'

function node(name: string, children: HarnessFileNode[] = []): HarnessFileNode {
  return {
    path: `/${name}`,
    name,
    kind: children.length > 0 ? 'directory' : 'file',
    source: 'harness',
    exists: true,
    instructionStatus: null,
    children,
  }
}

describe('flattenNodes', () => {
  it('keeps explorer order while flattening nested Harness files', () => {
    const nested = node('plans', [node('today.md'), node('later.md')])

    expect(flattenNodes([node('AGENTS.md'), nested]).map((entry) => entry.name))
      .toEqual(['AGENTS.md', 'plans', 'today.md', 'later.md'])
  })
})

describe('harnessFilesPlugin', () => {
  it('registers a tab backed by the restricted Harness file service', async () => {
    const files: HarnessFilesService = {
      configurationKey: () => '[]:32768',
      list: async () => ({ cwd: '/repo', projectRoot: '/repo', roots: [] }),
      read: async () => '',
      write: async () => undefined,
      createDirectory: async () => undefined,
      rename: async () => undefined,
      remove: async () => undefined,
    }
    const host = new PluginHost([harnessFilesPlugin], {
      storage: () => ({ get: async () => null, set: async () => undefined }),
      services: { 'harness.files': files },
    })

    await host.syncInstances([harnessFilesDefaultInstance])

    expect(host.status(harnessFilesDefaultInstance.instanceId).phase).toBe('active')
    expect(host.resolvedTabs({ threadId: 'thread-1', threadCwd: '/repo', workspaceRoot: '/repo' }))
      .toHaveLength(1)
    await host.dispose()
  })
})
