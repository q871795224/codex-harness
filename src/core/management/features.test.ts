import { beforeEach, expect, it, vi } from 'vitest'
import { createManagementHandler, type ManagementContext } from './service'
import { runtime } from '../runtime/bridge'
import { refreshRouterSummaries } from '../workspace-router/summaries'
import { DEFAULT_ROUTER_SETTINGS, ROUTER_SETTINGS_KEY } from '../workspace-router/settings'
import { writeRouteRecord, recordRouteFeedback, type RouteRecord } from '../workspace-router/service'
import { readCorrectionSettings } from '../input-correction/settings'
import { defaultAppearancePreferences, defaultKeyboardPreferences } from '../../features/conversation/harnessBootstrap'

vi.mock('../runtime/bridge', () => ({ runtime: {
  getAppState: vi.fn(), setAppState: vi.fn(), routerSummaries: vi.fn(), routerFeedback: vi.fn(),
  recordClientDiagnostic: vi.fn(), routerWorkspaceDirectory: vi.fn(), seatalkRemoteCall: vi.fn(), projectDocGet: vi.fn(), projectDocWorkspaces: vi.fn(), projectDocSetShortName: vi.fn(), projectDocRename: vi.fn(),
} }))
vi.mock('../workspace-router/summaries', () => ({ refreshRouterSummaries: vi.fn() }))
const store = new Map<string, string>()
function fixture() {
  const context = { flavor: 'dev', harness: { phase: 'ready', threads: [], workspaces: [{ root: '/a', checkoutRoot: '/a/checkout', name: 'A' }], allWorkspaces: [{ root: '/a', name: 'A' }, { root: '/hidden' }],
    appearance: structuredClone(defaultAppearancePreferences), keyboard: structuredClone(defaultKeyboardPreferences), notify: vi.fn(),
  }, plugins: { loading: false }, codex: {} } as unknown as ManagementContext
  return { context, call: (method: string, params: Record<string, unknown> = {}) => createManagementHandler(() => context)({ method, params, requestId: 'test' }) }
}
beforeEach(() => {
  vi.clearAllMocks(); store.clear()
  vi.mocked(runtime.recordClientDiagnostic).mockResolvedValue(undefined)
  vi.mocked(runtime.getAppState).mockImplementation(async key => store.get(key) ?? null)
  vi.mocked(runtime.setAppState).mockImplementation(async (key, value) => { store.set(key, value) })
})
it('updates Router through shared validation, preserves other descriptions and checks expected state', async () => {
  const { call } = fixture()
  store.set(ROUTER_SETTINGS_KEY, JSON.stringify({ ...DEFAULT_ROUTER_SETTINGS, descriptions: { '/a': 'old', '/hidden': 'keep' } }))
  const before = (await call('settings.read', { group: 'router' }) as { settings: unknown }).settings
  const result = await call('settings.update', { group: 'router', expected: before, patch: { backend: 'codex', descriptions: { '/a': 'new' }, feedbackCount: 5 } })
  expect(result).toMatchObject({ settings: { backend: 'codex', descriptions: { '/a': 'new', '/hidden': 'keep' }, feedbackCount: 5 } })
  await expect(call('settings.update', { group: 'router', expected: before, patch: { backend: 'decision2' } })).rejects.toThrow('已变化')
  await expect(call('settings.update', { group: 'router', patch: { feedbackCount: 99 } })).rejects.toThrow('0–10')
  await expect(call('settings.update', { group: 'router', patch: { descriptions: { '/invented': 'bad' } } })).rejects.toThrow('已知工作区')
  expect(JSON.parse(store.get(ROUTER_SETTINGS_KEY)!)).toMatchObject({ backend: 'codex', feedbackCount: 5 })
  expect(await call('settings.update', { group: 'router', patch: { descriptions: { '/a': null } } })).toMatchObject({ settings: { descriptions: { '/hidden': 'keep' } } })
})
it('rejects arbitrary settings groups and keys before any write', async () => {
  const { call } = fixture()
  await expect(call('settings.read', { group: 'secrets' })).rejects.toThrow('未知设置组')
  await expect(call('settings.update', { group: 'memory', patch: { secret: 'value' } })).rejects.toThrow('不支持的配置字段')
  await expect(call('settings.update', { group: 'history', patch: { maxResponseMiB: 2 } })).rejects.toThrow('16–1024')
  await expect(call('projectDocBeginCompaction')).rejects.toThrow('不支持')
  expect(runtime.setAppState).not.toHaveBeenCalled()
})
it('applies app settings through the live UI setter and validates the entire patch first', async () => {
  const { context, call } = fixture()
  context.harness.setTheme = vi.fn(value => {
    context.harness.appearance = { ...context.harness.appearance, theme: value }
    store.set('appearancePreferences', JSON.stringify(context.harness.appearance))
  })
  await expect(call('settings.update', { group: 'appearance', patch: { theme: 'dark', fontSizes: { conversation: 999 } } })).rejects.toThrow('13–19')
  expect(context.harness.setTheme).not.toHaveBeenCalled()
  expect(await call('settings.update', { group: 'appearance', patch: { theme: 'dark' } })).toMatchObject({ settings: { theme: 'dark' }, changed: true })
  expect(context.harness.setTheme).toHaveBeenCalledExactlyOnceWith('dark')
})
it('saves input correction through its shared live store without replacing unrelated rules', async () => {
  const { call } = fixture()
  expect(await call('settings.update', { group: 'inputCorrection', patch: { enabled: false, rules: [{ from: 'jev', to: 'Decision' }] } })).toMatchObject({ settings: { enabled: false } })
  expect(readCorrectionSettings()).toMatchObject({ enabled: false, rules: [{ from: 'jev', to: 'Decision' }] })
  await expect(call('settings.update', { group: 'inputCorrection', patch: { quotes: 'false' } })).rejects.toThrow('布尔')
})
it('accepts a Router refresh without waiting for generation and only uses visible checkouts', async () => {
  const { context, call } = fixture()
  vi.mocked(refreshRouterSummaries).mockReturnValue(new Promise(() => {}))
  expect(await call('router.refresh', { root: '/a' })).toMatchObject({ accepted: true, roots: ['/a'] })
  expect(refreshRouterSummaries).toHaveBeenCalledWith(context.harness.workspaces, expect.any(Function), true)
  await expect(call('router.refresh', { root: '/hidden' })).rejects.toThrow('可见工作区')
  expect(refreshRouterSummaries).toHaveBeenCalledTimes(1)
})
it('keeps SeaTalk diagnostics read-only and exposes only known scalar metadata', async () => {
  const { call } = fixture()
  vi.mocked(runtime.seatalkRemoteCall).mockResolvedValueOnce({ connected: true, reachable: true, accountId: 'account', ownerId: 'owner', state: 'connected', interactiveCards: true, token: 'private' })
    .mockResolvedValueOnce({ bindings: [{ threadId: 't', rootId: 'r', createdAt: 1, text: 'private' }] })
  expect(await call('seatalk.status')).toEqual({ connected: true, reachable: true, accountId: 'account', ownerId: 'owner', state: 'connected', interactiveCards: true })
  expect(await call('seatalk.bindings')).toEqual({ data: [{ threadId: 't', rootId: 'r', createdAt: 1 }] })
  expect(runtime.seatalkRemoteCall).toHaveBeenCalledTimes(2)
})
it('reads only documented plugin configuration and rejects non-loopback Bridge changes', async () => {
  const { context, call } = fixture()
  context.plugins.instances = [{ instanceId: 'p', pluginId: 'builtin.question-notifications', config: { baseUrl: 'http://user:password@127.0.0.1:8787?token=private', account: 'notify', token: 'private' }, enabled: true }] as never
  context.plugins.status = vi.fn(() => ({ phase: 'active' as const }))
  const read = await call('plugins.read', { instanceId: 'p' })
  expect(JSON.stringify(read)).not.toMatch(/password|private/)
  expect(read).toMatchObject({ settings: { account: 'notify', baseUrl: 'http://127.0.0.1:8787' }, hiddenConfigKeys: ['token'] })
  await expect(call('plugins.configure', { instanceId: 'p', patch: { baseUrl: 'https://outside.example' } })).rejects.toThrow('本机')
})
it('validates project metadata before mutation and does not expose the document in request status', async () => {
  const { context, call } = fixture()
  vi.mocked(runtime.projectDocGet).mockResolvedValue({ id: 'project', name: 'Name', shortName: null } as never)
  await expect(call('projects.update', { projectId: 'project', patch: { name: 'Renamed', shortName: '[invalid]' } })).rejects.toThrow('方括号')
  expect(runtime.projectDocRename).not.toHaveBeenCalled()
  context.onboarding = { snapshot: () => new Map([['thread', { id: 'request', source: { threadId: 'thread' }, phase: 'running', detail: 'private body', error: 'private body' }]]) } as never
  expect(JSON.stringify(await call('projects.onboardingStatus', { threadId: 'thread' }))).not.toContain('private body')
})
it('marks a notification read without resolving a source-owned pending question', async () => {
  const { call } = fixture()
  store.set('notifications.history', JSON.stringify([{ id: 'notice', source: 'test', title: 'Question', details: 'private error', read: false, state: 'pending', createdAt: 1, updatedAt: 1 }]))
  const read = await call('notifications.list')
  expect(JSON.stringify(read)).not.toContain('private error')
  expect(await call('notifications.markRead', { id: 'notice' })).toMatchObject({ read: true, sourceActionsResolved: false })
  expect(JSON.parse(store.get('notifications.history')!)[0]).toMatchObject({ read: true, state: 'pending' })
})

it('rejects keyboard conflicts before setters and normalizes valid shortcut spelling', async () => {
  const { context, call } = fixture()
  context.harness.setActionShortcut = vi.fn((id, value) => {
    context.harness.keyboard = { ...context.harness.keyboard, actionShortcuts: { ...context.harness.keyboard.actionShortcuts, [id]: value } }
    store.set('keyboardPreferences', JSON.stringify(context.harness.keyboard))
  })
  await expect(call('settings.update', { group: 'keyboard', patch: { actionShortcuts: { 'thread.new': 'mod+b' } } })).rejects.toThrow('快捷键冲突')
  expect(context.harness.setActionShortcut).not.toHaveBeenCalled()
  expect(await call('settings.update', { group: 'keyboard', patch: { actionShortcuts: { 'thread.new': 'mod+shift+t' } } })).toMatchObject({ settings: { actionShortcuts: { 'thread.new': 'Mod+Shift+T' } } })
})
it('keeps feedback separate from changing cwd, then confirms the actual corrected workspace', async () => {
  const { context, call } = fixture()
  context.harness.threads = [{ id: 'thread', cwd: '/old' }] as never
  const record = { id: 'attempt', threadId: 'thread', status: 'started', feedback: 'pending', actualWorkspace: null,
    candidates: [{ root: '/a', checkoutRoot: '/a/checkout' }], history: [] } as unknown as RouteRecord
  await writeRouteRecord(record)
  context.harness.giveRouteFeedback = vi.fn(async (_id, accurate, actual) => { await recordRouteFeedback(record, accurate ? 'accurate' : 'inaccurate', actual) })
  context.harness.correctRouteWorkspace = vi.fn(async () => {
    await recordRouteFeedback(record, 'inaccurate', '/a')
    context.harness.threads = [{ id: 'thread', cwd: '/a/checkout' }] as never
  })
  expect(await call('router.setFeedback', { threadId: 'thread', accurate: false, actualWorkspace: '/a' })).toMatchObject({ workspaceChanged: false, cwd: '/old', taskReplayed: false })
  expect(context.harness.correctRouteWorkspace).not.toHaveBeenCalled()
  await expect(call('router.setFeedback', { threadId: 'thread', accurate: false })).rejects.toThrow('明确actualWorkspace')
  expect(await call('router.correct', { threadId: 'thread', actualWorkspace: '/a' })).toMatchObject({ workspaceChanged: true, cwd: '/a/checkout', taskReplayed: false })
  expect(context.harness.correctRouteWorkspace).toHaveBeenCalledExactlyOnceWith('thread', '/a')
})
it('creates an automatic Codex blank session through the core without invoking a model', async () => {
  const { context, call } = fixture()
  context.harness.createThread = vi.fn(async () => { context.harness.threads = [{ id: 'new-thread', cwd: '/general' }] as never; return 'new-thread' })
  expect(await call('sessions.create')).toEqual({ id: 'new-thread', cwd: '/general', provider: 'codex', automaticWorkspace: true })
  expect(context.harness.createThread).toHaveBeenCalledExactlyOnceWith('codex')
})
it('guards concurrent project changes and reads renamed metadata back from the native service', async () => {
  const { call } = fixture()
  const metadata = { id: 'project', name: 'Old', shortName: null as string | null }
  vi.mocked(runtime.projectDocGet).mockImplementation(async () => ({ ...metadata }) as never)
  vi.mocked(runtime.projectDocRename).mockImplementation(async (_id, name) => { metadata.name = name; return metadata as never })
  vi.mocked(runtime.projectDocSetShortName).mockImplementation(async (_id, shortName) => { metadata.shortName = shortName; return metadata as never })
  await expect(call('projects.update', { projectId: 'project', expected: { name: 'Stale', shortName: null }, patch: { name: 'New' } })).rejects.toThrow('已变化')
  expect(runtime.projectDocRename).not.toHaveBeenCalled()
  expect(await call('projects.update', { projectId: 'project', expected: { name: 'Old', shortName: null }, patch: { name: 'New', shortName: 'Harness' } })).toMatchObject({ name: 'New', shortName: 'Harness' })
})
