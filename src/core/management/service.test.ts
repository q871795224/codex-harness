import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createManagementHandler, type ManagementContext } from './service'
import { PluginHost } from '../plugins/runtime'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'
import { runtime } from '../runtime/bridge'
import { appServer } from '../runtime/appServerClient'

vi.mock('../runtime/bridge', () => ({ runtime: { listWorkspaces: vi.fn(), mapThreadWorkspaces: vi.fn(), getRuntimeVersions: vi.fn(), claudeRequest: vi.fn() } }))
vi.mock('../runtime/appServerClient', () => ({ appServer: { readConfig: vi.fn(), writeConfigValue: vi.fn(), reloadMcpServers: vi.fn(),
  listMcpServers: vi.fn(), listSkills: vi.fn(), setSkillEnabled: vi.fn() } }))

function fixture() {
  const workspaces = Array.from({ length: 17 }, (_, index) => ({ root: `/workspace/${index}`, checkoutRoot: `/workspace/${index}`, name: String(index) }))
  const context = { flavor: 'dev', harness: { phase: 'ready', workspaces, allWorkspaces: workspaces,
    selectedProvider: 'codex', selectedThreadId: null, selectedWorkspaceRoot: '/workspace/0',
    currentThread: null, activeTurnIds: {}, threads: [], viewMode: 'active' },
    codex: { reload: vi.fn() }, plugins: { loading: false } } as unknown as ManagementContext
  return { context, call: (method: string, params: Record<string, unknown> = {}) =>
    createManagementHandler(() => context)({ requestId: 'fixture', method, params }) }
}

beforeEach(() => vi.clearAllMocks())

describe('management uses effective application state', () => {
  it('returns all 17 runtime workspaces even when only 7 are explicitly registered', async () => {
    const { context, call } = fixture()
    vi.mocked(runtime.listWorkspaces).mockResolvedValue(context.harness.allWorkspaces.slice(0, 7))
    const result = await call('workspaces.list') as { count: number; data: Array<{ registered: boolean }> }
    expect(result.count).toBe(17)
    expect(result.data.filter((workspace) => workspace.registered)).toHaveLength(7)
    expect(result.data.filter((workspace) => !workspace.registered)).toHaveLength(10)
  })

  it('reports hidden entries separately without dropping them from the catalog', async () => {
    const { context, call } = fixture()
    context.harness.workspaces = context.harness.workspaces.slice(1)
    vi.mocked(runtime.listWorkspaces).mockResolvedValue([])
    const result = await call('workspaces.list') as { count: number; catalogCount: number; data: Array<{ visible: boolean }> }
    expect(result.count).toBe(16)
    expect(result.catalogCount).toBe(17)
    expect(result.data[0].visible).toBe(false)
  })

  it('fails explicitly before the UI is ready and rejects arbitrary RPC names', async () => {
    const { context, call } = fixture()
    context.harness.phase = 'loading'
    await expect(call('workspaces.list')).rejects.toThrow('尚未加载')
    await expect(call('turn/start')).rejects.toThrow('不支持')
    expect(runtime.listWorkspaces).not.toHaveBeenCalled()
  })

  it('does not expose messages or credentials in routine listings', async () => {
    const { context, call } = fixture()
    context.harness.threads = [{ id: 'one', name: 'Name', cwd: '/repo', preview: 'private prompt', turns: ['private response'] }] as never
    expect(JSON.stringify(await call('sessions.list'))).not.toContain('private')
    vi.mocked(appServer.readConfig).mockResolvedValue({ config: { model: 'model', mcp_servers: { secret: 'credential' } } } as never)
    expect(await call('config.read')).toEqual({ model: 'model', model_reasoning_effort: null, service_tier: null, approval_policy: null })
    await expect(call('config.set', { key: 'mcp_servers', value: 'overwrite' })).rejects.toThrow('仅支持')
    expect(appServer.writeConfigValue).not.toHaveBeenCalled()
  })

  it('checks out a target session cwd and passes it without changing selection first', async () => {
    const { context, call } = fixture()
    vi.mocked(runtime.mapThreadWorkspaces).mockResolvedValue({ '/requested': { checkoutRoot: '/actual' } } as never)
    context.harness.createThread = vi.fn(async (provider, cwd) => {
      context.harness.threads = [{ id: 'new', cwd }] as never
      expect(provider).toBe('claude')
      return 'new'
    })
    expect(await call('sessions.create', { cwd: '/requested', provider: 'claude' })).toEqual({ id: 'new', cwd: '/actual', provider: 'claude' })
    expect(context.harness.createThread).toHaveBeenCalledWith('claude', '/actual')
  })
})

describe('management controls the real plugin host', () => {
  async function pluginsFixture() {
    const { context, call } = fixture()
    const plugin: HarnessPlugin = { manifest: { schemaVersion: 1, id: 'fixture', name: 'Fixture', description: 'Fixture tab', version: '1.0.0',
      engine: { codexHarness: '*' }, supportedScopes: ['global'] },
      activate: (ctx) => { ctx.slots.conversationTabs.register({ id: 'fixture-tab', label: 'Fixture', render: () => null }) } }
    const host = new PluginHost([plugin], { storage: () => ({ get: async () => null, set: async () => {} }) })
    const instance: PluginInstanceRecord = { instanceId: 'one', pluginId: 'fixture', scope: { kind: 'global' }, enabled: true,
      config: { secret: 'private-value' }, createdAt: 1, updatedAt: 1 }
    context.plugins = { loading: false, error: null, definitions: [plugin], instances: [instance],
      status: (id) => host.status(id), resolvedTabs: (view) => host.resolvedTabs(view), resolvedThreadHeaderActions: () => [],
      resolvedNewThreadPanels: () => [], resolvedComposerActions: () => [], resolvedTurnActions: () => [],
      resolvedComposerCompletions: () => [], resolvedQuickActions: () => [], resolvedQuickCommands: () => [],
      upsertInstance: async (next) => {
        const saved = { ...next, config: Object.fromEntries(Object.entries(next.config).sort(([a], [b]) => a.localeCompare(b))) }
        context.plugins.instances = [saved, ...context.plugins.instances.filter((value) => value.instanceId !== next.instanceId)]
        await host.syncInstances(context.plugins.instances)
      }, deleteInstance: async (id) => {
        context.plugins.instances = context.plugins.instances.filter((value) => value.instanceId !== id)
        await host.syncInstances(context.plugins.instances)
      } }
    await host.syncInstances([instance])
    return { context, call, host }
  }

  it('disables an instance through its lifecycle and reads back disabled state and removed contributions', async () => {
    const { call, host } = await pluginsFixture()
    expect(JSON.stringify(await call('plugins.list'))).toContain('fixture-tab')
    expect(JSON.stringify(await call('plugins.list'))).not.toContain('private-value')
    expect(await call('plugins.setEnabled', { instanceId: 'one', enabled: false })).toMatchObject({ enabled: false, status: { phase: 'disabled' } })
    expect(JSON.stringify(await call('plugins.list'))).not.toContain('fixture-tab')
    await host.dispose()
  })

  it('preserves unrelated config and rejects unsupported scopes before writing', async () => {
    const { context, call, host } = await pluginsFixture()
    await call('plugins.configure', { instanceId: 'one', patch: { label: 'new' } })
    expect(context.plugins.instances[0].config).toEqual({ secret: 'private-value', label: 'new' })
    await expect(call('plugins.create', { pluginId: 'fixture', scope: { kind: 'workspace', workspaceRoot: '/repo' } })).rejects.toThrow('不支持')
    await call('plugins.delete', { instanceId: 'one' })
    expect(context.plugins.instances).toHaveLength(0)
    await host.dispose()
  })

  it('resolves plugin context from the selected conversation rather than a stale workspace selection', async () => {
    const { context, call, host } = await pluginsFixture()
    context.harness.selectedThreadId = 'claude:one'
    context.harness.selectedWorkspaceRoot = '/workspace/9'
    context.harness.threadRoots = { 'claude:one': '/workspace/0' }
    context.harness.threads = [{ id: 'claude:one', cwd: '/workspace/0' }] as never
    expect(await call('plugins.list')).toMatchObject({ context: { provider: 'claude', threadId: 'claude:one', workspaceRoot: '/workspace/0' } })
    expect(await call('plugins.list', { workspaceRoot: '/workspace/1' })).toMatchObject({ context: { threadId: null, threadCwd: null, workspaceRoot: '/workspace/1' } })
    await host.dispose()
  })
})
