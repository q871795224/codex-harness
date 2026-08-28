import { describe, expect, it } from 'vitest'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'
import { PluginHost, resolveScopedContributions, sortPluginDefinitions } from './runtime'

const storage = {
  async get<T>() { return null as T | null },
  async set() {},
}

function instance(overrides: Partial<PluginInstanceRecord> = {}): PluginInstanceRecord {
  return {
    instanceId: 'instance-1',
    pluginId: 'plugin-a',
    scope: { kind: 'global' },
    enabled: true,
    config: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function plugin(id: string, activate: HarnessPlugin['activate'] = () => undefined, requires: string[] = []): HarnessPlugin {
  return {
    manifest: {
      schemaVersion: 1,
      id,
      name: id,
      description: id,
      version: '1.0.0',
      engine: { codexHarness: '^0.1.0' },
      supportedScopes: ['global', 'workspace', 'thread'],
      requires,
    },
    activate,
  }
}

describe('plugin dependency order', () => {
  it('orders dependencies first and rejects cycles', () => {
    expect(sortPluginDefinitions([
      plugin('consumer', undefined, ['provider']),
      plugin('provider'),
    ]).map((definition) => definition.manifest.id)).toEqual(['provider', 'consumer'])

    expect(() => sortPluginDefinitions([
      plugin('a', undefined, ['b']),
      plugin('b', undefined, ['a']),
    ])).toThrow(/循环/)
  })
})

describe('scoped contributions', () => {
  it('selects the most specific matching instance and keeps stable ordering', () => {
    const contribution = (id: string, order: number) => ({ id, label: id, order, render: () => null })
    const resolved = resolveScopedContributions([
      { pluginId: 'trajectory', instanceId: 'global', scope: { kind: 'global' }, contribution: contribution('tab', 20) },
      { pluginId: 'trajectory', instanceId: 'workspace', scope: { kind: 'workspace', workspaceRoot: '/repo' }, contribution: contribution('tab', 20) },
      { pluginId: 'tasks', instanceId: 'tasks', scope: { kind: 'global' }, contribution: contribution('tasks', 10) },
    ], { threadId: 'thread-1', workspaceRoot: '/repo' })

    expect(resolved.map((entry) => entry.instanceId)).toEqual(['tasks', 'workspace'])
  })

  it('keeps distinct contributions from global and workspace instances', () => {
    const contribution = (id: string) => ({ id, label: id, run: () => undefined })
    const resolved = resolveScopedContributions([
      { pluginId: 'quick-agent', instanceId: 'global', scope: { kind: 'global' }, contribution: contribution('global-job') },
      { pluginId: 'quick-agent', instanceId: 'workspace', scope: { kind: 'workspace', workspaceRoot: '/repo' }, contribution: contribution('workspace-job') },
    ], { threadId: 'thread-1', workspaceRoot: '/repo' })

    expect(resolved.map((entry) => entry.contribution.id)).toEqual(['global-job', 'workspace-job'])
  })
})

describe('plugin host lifecycle', () => {
  it('isolates activation failures and disposes effects in reverse order', async () => {
    const calls: string[] = []
    const good = plugin('plugin-a', (ctx) => {
      ctx.effect(() => { calls.push('first') })
      ctx.effect(() => { calls.push('second') })
      ctx.slots.conversationTabs.register({ id: 'tab', label: 'Tab', render: () => null })
      ctx.slots.newThreadPanels.register({ id: 'launcher', render: () => null })
      ctx.slots.quickActions.register({ id: 'ship', label: 'Ship', run: () => undefined })
    })
    const bad = plugin('plugin-b', () => { throw new Error('boom') })
    const host = new PluginHost([good, bad], { storage: () => storage })

    await host.syncInstances([
      instance(),
      instance({ instanceId: 'instance-2', pluginId: 'plugin-b' }),
    ])

    expect(host.status('instance-1').phase).toBe('active')
    expect(host.status('instance-2')).toEqual({ phase: 'failed', error: 'boom' })
    expect(host.resolvedTabs({ threadId: null, workspaceRoot: null })).toHaveLength(1)
    expect(host.resolvedNewThreadPanels({ threadId: null, workspaceRoot: null })).toHaveLength(1)
    expect(host.resolvedQuickActions({ threadId: null, workspaceRoot: null })).toHaveLength(1)

    await host.syncInstances([])
    expect(calls).toEqual(['second', 'first'])
    expect(host.resolvedTabs({ threadId: null, workspaceRoot: null })).toHaveLength(0)
    expect(host.resolvedNewThreadPanels({ threadId: null, workspaceRoot: null })).toHaveLength(0)
    expect(host.resolvedQuickActions({ threadId: null, workspaceRoot: null })).toHaveLength(0)
  })

  it('reactivates an instance when its config changes', async () => {
    let activations = 0
    const host = new PluginHost([plugin('plugin-a', () => { activations += 1 })], { storage: () => storage })
    await host.syncInstances([instance()])
    await host.syncInstances([instance()])
    await host.syncInstances([instance({ config: { refresh: 30 }, updatedAt: 2 })])

    expect(activations).toBe(2)
  })

  it('does not activate a consumer when its required plugin failed', async () => {
    let consumerActivated = false
    const host = new PluginHost([
      plugin('provider', () => { throw new Error('provider failed') }),
      plugin('consumer', () => { consumerActivated = true }, ['provider']),
    ], { storage: () => storage })

    await host.syncInstances([
      instance({ instanceId: 'provider', pluginId: 'provider' }),
      instance({ instanceId: 'consumer', pluginId: 'consumer' }),
    ])

    expect(consumerActivated).toBe(false)
    expect(host.status('consumer')).toEqual({ phase: 'failed', error: '缺少依赖插件：provider' })
  })

  it('continues releasing earlier effects after a disposer fails', async () => {
    const calls: string[] = []
    const host = new PluginHost([plugin('plugin-a', (ctx) => {
      ctx.effect(() => { calls.push('first') })
      ctx.effect(() => {
        calls.push('second')
        throw new Error('cleanup failed')
      })
    })], { storage: () => storage })

    await host.syncInstances([instance()])
    await expect(host.syncInstances([])).rejects.toThrow('cleanup failed')

    expect(calls).toEqual(['second', 'first'])
    expect(host.status('instance-1')).toEqual({ phase: 'failed', error: '插件资源清理失败：cleanup failed' })
  })
})
