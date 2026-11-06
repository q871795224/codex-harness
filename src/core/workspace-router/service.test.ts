import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppServerEvent, Workspace } from '../domain/codex'
import { textInput } from '../domain/codex'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import { DEFAULT_ROUTER_SETTINGS, ROUTER_SETTINGS_KEY, saveRouterSettings } from './settings'
import { completeRouteFeedback, parseRouteChoice, readRouteRecord, recordRouteFeedback, relatedWorkspaceInput, routeWorkspace, updateRouteRecord } from './service'
vi.mock('../runtime/appServerClient', () => ({ appServer: { readConfig: vi.fn(), startThread: vi.fn(), startTurn: vi.fn(), interruptTurn: vi.fn(), unsubscribeThread: vi.fn() } }))
vi.mock('../runtime/bridge', () => ({ diagnosticErrorCode: () => 'request_failed', runtime: { routerSummaries: vi.fn(), routerCorrections: vi.fn(), buildRouterPrompt: vi.fn(), getAppState: vi.fn(), setAppState: vi.fn(), recordClientDiagnostic: vi.fn(), listenEvents: vi.fn() } }))
const storage = new Map<string, string>()
const workspaces = ['/a', '/b'].map((root) => ({ root, checkoutRoot: `${root}/checkout`, name: root.slice(1), branch: 'main', sha: null, createdAt: 1, lastOpenedAt: 1 })) satisfies Workspace[]
let handle: (event: AppServerEvent) => void
const unlisten = vi.fn()
function output(text: string) {
  vi.mocked(appServer.startTurn).mockImplementation(async () => {
    handle({ method: 'item/completed', params: { threadId: 'router', item: { type: 'agentMessage', text } } })
    handle({ method: 'turn/completed', params: { threadId: 'router', turn: { id: 'choice', status: 'completed', items: [] } } })
    return { turn: { id: 'choice', status: 'completed', items: [{ type: 'agentMessage', text }] } } as never
  })
}
beforeEach(() => {
  vi.resetAllMocks(); storage.clear()
  vi.mocked(runtime.getAppState).mockImplementation(async (key) => storage.get(key) ?? null)
  vi.mocked(runtime.setAppState).mockImplementation(async (key, value) => { storage.set(key, value) })
  vi.mocked(runtime.recordClientDiagnostic).mockResolvedValue(undefined)
  vi.mocked(runtime.routerSummaries).mockResolvedValue([])
  vi.mocked(runtime.routerCorrections).mockResolvedValue([])
  vi.mocked(runtime.buildRouterPrompt).mockImplementation(async input => ({ context: JSON.stringify({ workspaces: input.candidates, corrections: input.examples }), textTokens: 100, examplesUsed: input.examples.length }))
  vi.mocked(runtime.listenEvents).mockImplementation(async (handler) => { handle = handler; return unlisten })
  vi.mocked(appServer.readConfig).mockResolvedValue({ config: { mcp_servers: { company: {} } } } as never)
  vi.mocked(appServer.startThread).mockResolvedValue({ thread: { id: 'router' } } as never)
  vi.mocked(appServer.unsubscribeThread).mockResolvedValue(undefined)
  vi.mocked(appServer.interruptTurn).mockResolvedValue(undefined)
  output('{"primary":"/b","related":["/a"]}')
})
afterEach(() => vi.useRealTimers())
it('routes with saved settings in a tool-free ephemeral thread and keeps only routing metadata', async () => {
  await saveRouterSettings({ model: 'custom', effort: 'high', descriptions: { '/b': 'Client application' } })
  const record = await routeWorkspace('source', '/neutral', [textInput('private request')], workspaces)
  expect(appServer.startThread).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true, model: 'custom', sandbox: 'read-only', config: expect.objectContaining({ 'features.shell_tool': false, 'mcp_servers.company.enabled': false, project_doc_max_bytes: 0 }) }))
  expect(appServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high', turnTrigger: 'workspace-router', input: expect.arrayContaining([textInput('private request')]) }))
  expect(record.choice).toEqual({ primary: '/b', related: ['/a'] })
  expect(record.candidates[1].description).toBe('Client application')
  expect(await readRouteRecord('source')).toEqual(record)
  expect([...storage.values()].join('\n')).not.toContain('private request')
  expect(unlisten).toHaveBeenCalledOnce()
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('router')
})
it('defaults to terra medium and preserves related workspace paths separately from the request', async () => {
  const record = await routeWorkspace('source', '/neutral', [textInput('do work')], workspaces)
  expect(record.model).toBe(DEFAULT_ROUTER_SETTINGS.model)
  expect(record.effort).toBe('medium')
  expect(relatedWorkspaceInput(record.choice!, record.candidates)).toEqual([textInput('本次工作以当前会话工作区为主，还可能涉及以下工作区，请按任务需要核查：\na: /a/checkout')])
})
it('records explicit corrections after implicit acceptance without changing any execution settings', async () => {
  const selected = await routeWorkspace('source', '/neutral', [textInput('do work')], workspaces)
  // Selection alone is not a successful first submission.
  expect((await recordRouteFeedback(selected, 'implicit-accurate')).feedback).toBe('pending')
  const started = await updateRouteRecord(selected.id, (record) => ({ ...record, status: 'started', sourceMessageId: 'first', sourceTurnId: 'turn' }))
  const implicit = await recordRouteFeedback(started, 'implicit-accurate', null, 'follow-up')
  expect(implicit.history).toEqual([{ at: expect.any(Number), feedback: 'implicit-accurate', actualWorkspace: null, messageId: 'follow-up' }])
  const corrected = await recordRouteFeedback(implicit, 'inaccurate', '/a')
  expect(corrected.choice).toEqual(selected.choice)
  expect(corrected.actualWorkspace).toBe('/a')
  expect(corrected.history).toHaveLength(2)
  expect((await recordRouteFeedback(corrected, 'implicit-accurate')).feedback).toBe('inaccurate')
  expect(appServer.startTurn).toHaveBeenCalledOnce()
  expect(appServer.interruptTurn).not.toHaveBeenCalled()
})
it('rejects unknown workspaces and records failure without retaining arbitrary response text', async () => {
  output('{"primary":"/invented","related":[]}')
  await expect(routeWorkspace('source', '/neutral', [textInput('secret')], workspaces)).rejects.toThrow('未知的工作区')
  expect(await readRouteRecord('source')).toMatchObject({ status: 'failed', errorCode: 'request_failed', choice: null })
  expect([...storage.values()].join('\n')).not.toContain('/invented')
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('router')
})
it('times out and cleans up the router without starting a task', async () => {
  vi.useFakeTimers()
  vi.mocked(appServer.startTurn).mockResolvedValue({ turn: { id: 'slow', status: 'inProgress', items: [] } } as never)
  const promise = routeWorkspace('source', '/neutral', [textInput('do work')], workspaces)
  const rejected = expect(promise).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(60_001)
  await rejected
  expect(appServer.interruptTurn).toHaveBeenCalledWith('router', 'slow')
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('router')
})
it('uses a general session for an empty catalog and does not invoke a model', async () => {
  const record = await routeWorkspace('source', '/neutral', [textInput('hello')], [])
  expect(record.choice).toEqual({ primary: null, related: [] })
  expect(appServer.startThread).not.toHaveBeenCalled()
})
describe('choice validation', () => {
  const candidates = workspaces.map((workspace) => ({ ...workspace, description: '' }))
  it.each(['{}', '{"primary":"/a","related":["/bad"]}', '{"primary":null,"related":["/a"]}', '[]'])('rejects malformed choice %s', (text) => {
    expect(() => parseRouteChoice(text, candidates)).toThrow()
  })
  it('deduplicates related roots and removes the primary', () => {
    expect(parseRouteChoice('{"primary":"/a","related":["/a","/b","/b"]}', candidates)).toEqual({ primary: '/a', related: ['/b'] })
  })
})
it('rejects broken persisted settings rather than silently changing models', async () => {
  storage.set(ROUTER_SETTINGS_KEY, '{broken')
  await expect(routeWorkspace('source', '/neutral', [textInput('do work')], workspaces)).rejects.toThrow()
  expect(appServer.startThread).not.toHaveBeenCalled()
})

it('closes feedback once on a follow-up, preserves explicit corrections and persists closure', async () => {
  const selected = await routeWorkspace('source', '/neutral', [textInput('work')], workspaces)
  const started = await updateRouteRecord(selected.id, record => ({ ...record, status: 'started' }))
  const explicit = await recordRouteFeedback(started, 'inaccurate', '/a')
  const closed = await completeRouteFeedback(explicit, 'second')
  expect(closed).toMatchObject({ feedback: 'inaccurate', actualWorkspace: '/a', feedbackDismissedAt: expect.any(Number) })
  expect(closed.history).toEqual(explicit.history)
  expect(await completeRouteFeedback(closed, 'third')).toEqual(closed)
  expect(await readRouteRecord('source')).toEqual(closed)
})
it('uses cached descriptions for the prompt without copying model-derived text into SQLite records', async () => {
  vi.mocked(runtime.routerSummaries).mockResolvedValue([{ root: '/a', checkoutRoot: '/a/checkout', description: 'cached generated synopsis', checkedAt: 1, generatedAt: 1, error: false }])
  await routeWorkspace('source', '/neutral', [textInput('work')], workspaces)
  expect(runtime.buildRouterPrompt).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: 8192, candidates: expect.arrayContaining([expect.objectContaining({ root: '/a', description: 'cached generated synopsis' })]) }))
  expect([...storage.values()].join('\n')).not.toContain('cached generated synopsis')
})
it('enforces the token budget before starting the router model', async () => {
  vi.mocked(runtime.buildRouterPrompt).mockRejectedValue(new Error('超过Router文本预算'))
  await expect(routeWorkspace('source', '/neutral', [textInput('large request')], workspaces)).rejects.toThrow('文本预算')
  expect(appServer.startThread).not.toHaveBeenCalled()
})
it('previews the same prompt fields used by execution without starting a model', async () => {
  const { prepareRouterPrompt, routingCandidates } = await import('./service')
  const settings = { ...DEFAULT_ROUTER_SETTINGS, feedbackCount: 5, feedbackRule: 'recent' as const }
  const candidates = await routingCandidates(workspaces, settings)
  const prepared = await prepareRouterPrompt([textInput('private preview')], candidates, settings)
  expect(prepared.input.at(-1)).toEqual(textInput('private preview'))
  expect(prepared.developerInstructions).toContain('Choose the workspace')
  expect(runtime.buildRouterPrompt).toHaveBeenCalledWith(expect.objectContaining({ exampleLimit: 5 }))
  expect(appServer.startThread).not.toHaveBeenCalled()
  expect([...storage.values()].join('')).not.toContain('private preview')
})
