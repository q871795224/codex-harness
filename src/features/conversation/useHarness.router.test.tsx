// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppServerEvent, Thread, Workspace } from '../../core/domain/codex'
import { textInput } from '../../core/domain/codex'
import { appServer } from '../../core/runtime/appServerClient'
import { runtime } from '../../core/runtime/bridge'
import { readRouteRecord } from '../../core/workspace-router/service'
import { useHarness } from './useHarness'
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ listen: vi.fn().mockResolvedValue(() => {}) }) }))
vi.mock('../../core/runtime/bridge', () => ({ diagnosticErrorCode: () => 'request_failed', recordWorkspaceContextDiagnostic: vi.fn(), runtime: { routerSummaries: vi.fn(), routerCorrections: vi.fn(), buildRouterPrompt: vi.fn(),
  projectDocThreadBinding: vi.fn(), projectDocBindThread: vi.fn(), projectDocLockThreadBinding: vi.fn(), routerWorkspaceDirectory: vi.fn(), recordClientDiagnostic: vi.fn(), listWorkspaces: vi.fn(), listThreadStates: vi.fn(), getAppState: vi.fn(), setAppState: vi.fn(), setThreadState: vi.fn(),
  mapThreadWorkspaces: vi.fn(), listenEvents: vi.fn(), listenTransport: vi.fn(),
} }))
vi.mock('../../core/runtime/appServerClient', () => ({ appServer: {
  listThreads: vi.fn(), startThread: vi.fn(), startTurn: vi.fn(), resumeThread: vi.fn(), deleteThread: vi.fn(), unsubscribeThread: vi.fn(), interruptTurn: vi.fn(),
  readConfig: vi.fn(), updateThreadSettings: vi.fn(), updateThreadMetadata: vi.fn(), listQueue: vi.fn(), addQueue: vi.fn(), steerTurn: vi.fn(),
} }))
const storage = new Map<string, string>()
let listeners: Array<(event: AppServerEvent) => void> = []
const workspaces = ['/a', '/b'].map((root) => ({ root, checkoutRoot: root, name: root.slice(1), branch: 'main', sha: null, createdAt: 1, lastOpenedAt: 1 })) satisfies Workspace[]
const thread = (id: string, cwd = '/neutral'): Thread => ({ id, cwd, name: 'Task', preview: '', ephemeral: false, createdAt: 1, updatedAt: 1, recencyAt: 1, canAcceptDirectInput: true, status: { type: 'idle' } })
const response = (id: string, cwd: string) => ({ thread: thread(id, cwd), approvalPolicy: 'never', approvalsReviewer: 'user', model: 'execution-model', reasoningEffort: 'high', serviceTier: null, sandbox: { type: 'dangerFullAccess' }, runtimeWorkspaceRoots: [cwd], activePermissionProfile: null })
const accepted = { turn: { id: 'execution-turn', status: 'inProgress', items: [] } }
let routeChoice: string
beforeEach(() => {
  vi.resetAllMocks(); storage.clear(); listeners = []; routeChoice = '{"primary":"/b","related":["/a"]}'
  vi.mocked(runtime.getAppState).mockImplementation(async (key) => storage.get(key) ?? null)
  vi.mocked(runtime.setAppState).mockImplementation(async (key, value) => { storage.set(key, value) })
  vi.mocked(runtime.recordClientDiagnostic).mockResolvedValue(undefined)
  vi.mocked(runtime.routerSummaries).mockResolvedValue([])
  vi.mocked(runtime.routerCorrections).mockResolvedValue([])
  vi.mocked(runtime.buildRouterPrompt).mockImplementation(async input => ({ context: JSON.stringify({ workspaces: input.candidates, corrections: input.examples }), textTokens: 100, examplesUsed: input.examples.length }))
  vi.mocked(runtime.projectDocThreadBinding).mockResolvedValue(null)
  vi.mocked(runtime.projectDocBindThread).mockResolvedValue(undefined)
  vi.mocked(runtime.projectDocLockThreadBinding).mockResolvedValue(undefined)
  vi.mocked(runtime.routerWorkspaceDirectory).mockResolvedValue('/neutral')
  vi.mocked(runtime.listWorkspaces).mockResolvedValue(workspaces)
  vi.mocked(runtime.listThreadStates).mockResolvedValue([])
  vi.mocked(runtime.setThreadState).mockResolvedValue(undefined)
  vi.mocked(runtime.mapThreadWorkspaces).mockImplementation(async (paths) => Object.fromEntries(paths.map((path) => [path, workspaces.find((workspace) => workspace.root === path) ?? null])))
  vi.mocked(runtime.listenEvents).mockImplementation(async (handle) => { listeners.push(handle); return () => { listeners = listeners.filter((listener) => listener !== handle) } })
  vi.mocked(runtime.listenTransport).mockResolvedValue(() => {})
  vi.mocked(appServer.listThreads).mockResolvedValue({ data: [thread('other', '/a')], nextCursor: null })
  vi.mocked(appServer.startThread).mockImplementation(async (params) => {
    if (params.ephemeral) return { ...response('router', String(params.cwd)), thread: { ...thread('router'), ephemeral: true } } as never
    return response(params.cwd === '/neutral' ? 'draft' : 'routed', params.cwd ? String(params.cwd) : '/neutral') as never
  })
  vi.mocked(appServer.startTurn).mockImplementation(async (params) => {
    if (params.threadId === 'router') return { turn: { id: 'routing-turn', status: 'completed', items: [{ type: 'agentMessage', text: routeChoice }] } } as never
    return accepted as never
  })
  vi.mocked(appServer.readConfig).mockResolvedValue({ config: {} } as never)
  vi.mocked(appServer.deleteThread).mockResolvedValue(undefined)
  vi.mocked(appServer.unsubscribeThread).mockResolvedValue(undefined)
  vi.mocked(appServer.interruptTurn).mockResolvedValue(undefined)
  vi.mocked(appServer.updateThreadSettings).mockResolvedValue(undefined)
  vi.mocked(appServer.updateThreadMetadata).mockResolvedValue(undefined)
  vi.mocked(appServer.listQueue).mockResolvedValue({ data: [] })
  vi.mocked(appServer.addQueue).mockResolvedValue(undefined)
  vi.mocked(appServer.steerTurn).mockResolvedValue(undefined)
  vi.mocked(appServer.resumeThread).mockResolvedValue(response('other', '/a') as never)
})
afterEach(cleanup)
async function ready() {
  const hook = renderHook(() => useHarness())
  await waitFor(() => expect(hook.result.current.phase).toBe('ready'))
  return hook
}
it('starts unselected, routes the original message, creates the durable thread in the selected workspace and records acceptance', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread() })
  expect(result.current.automaticWorkspace).toBe(true)
  expect(appServer.startThread).toHaveBeenNthCalledWith(1, expect.objectContaining({ cwd: '/neutral' }))
  const input = [textInput('change service and client')]
  await act(async () => { await result.current.sendMessage(input, 'queue') })
  expect(result.current.currentThread).toMatchObject({ id: 'routed', cwd: '/b' })
  expect(appServer.startThread).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/b', model: 'execution-model' }))
  expect(appServer.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'routed', cwd: '/b', input: [...input, textInput('本次工作以当前会话工作区为主，还可能涉及以下工作区，请按任务需要核查：\na: /a')] }))
  expect(appServer.deleteThread).toHaveBeenCalledWith('draft')
  expect(await readRouteRecord('routed')).toMatchObject({ status: 'started', sourceMessageId: expect.any(String), sourceTurnId: 'execution-turn', feedback: 'pending' })
  expect(result.current.automaticWorkspace).toBe(false)
  expect(result.current.currentRoute?.feedback).toBe('pending')
  await act(async () => { await result.current.sendMessage([textInput('continue')], 'interject') })
  expect(result.current.currentRoute?.feedback).toBe('implicit-accurate')
  const calls = vi.mocked(appServer.startTurn).mock.calls.length
  await act(async () => { await result.current.giveRouteFeedback('routed', false, '/a') })
  expect(result.current.currentRoute?.actualWorkspace).toBe('/a')
  expect(result.current.currentThread?.cwd).toBe('/b')
  expect(appServer.startTurn).toHaveBeenCalledTimes(calls)
  expect(appServer.interruptTurn).not.toHaveBeenCalled()
})
it('bypasses routing after manually selecting even the same working directory', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread('/a') })
  expect(result.current.automaticWorkspace).toBe(false)
  await act(async () => { await result.current.sendMessage([textInput('work')], 'queue') })
  expect(appServer.readConfig).not.toHaveBeenCalled()
  expect(result.current.currentRoute).toBeNull()
  expect(appServer.startTurn).toHaveBeenCalledOnce()
})
it('does not execute the user task on invalid routing and keeps the draft available for retry', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread() })
  routeChoice = '{"primary":"/unknown","related":[]}'
  await act(async () => { await expect(result.current.sendMessage([textInput('work')], 'queue')).rejects.toThrow('未知的工作区') })
  expect(appServer.startTurn).toHaveBeenCalledOnce()
  expect(result.current.currentThread?.id).toBe('draft')
  expect(result.current.automaticWorkspace).toBe(true)
  routeChoice = '{"primary":"/b","related":[]}'
  await act(async () => { await result.current.sendMessage([textInput('work')], 'queue') })
  expect(result.current.currentThread?.cwd).toBe('/b')
})
it('does not steal selection or discard the draft when the user switches away during routing', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread() })
  let finish!: (response: unknown) => void
  vi.mocked(appServer.startTurn).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve as never }))
  let sending!: Promise<void>
  await act(async () => { sending = result.current.sendMessage([textInput('work')], 'queue') })
  await waitFor(() => expect(finish).toBeDefined())
  await act(async () => { await result.current.selectThread('other') })
  expect(appServer.deleteThread).not.toHaveBeenCalled()
  await act(async () => {
    finish({ turn: { id: 'routing-turn', status: 'completed', items: [{ type: 'agentMessage', text: '{"primary":"/b","related":[]}' }] } })
    await sending
  })
  expect(result.current.selectedThreadId).toBe('other')
  expect(appServer.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'routed', cwd: '/b' }))
})
it('failed follow-up sends do not imply accurate feedback', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread() })
  await act(async () => { await result.current.sendMessage([textInput('work')], 'queue') })
  vi.mocked(appServer.steerTurn).mockRejectedValueOnce(new Error('offline'))
  await act(async () => { await expect(result.current.sendMessage([textInput('continue')], 'interject')).rejects.toThrow('offline') })
  expect((await readRouteRecord('routed'))?.feedback).toBe('pending')
  expect((await readRouteRecord('routed'))?.feedbackDismissedAt).toBeUndefined()
})
it('preserves project bindings and retargets their marker before sending in the routed workspace', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread() })
  vi.mocked(runtime.projectDocThreadBinding).mockResolvedValue({ projectId: 'project', phase: 'pending' })
  await act(async () => { await result.current.sendMessage([textInput('<!-- project-doc: project_id=project thread_id=draft -->\nDo work')], 'queue') })
  expect(runtime.projectDocBindThread).toHaveBeenCalledWith('routed', 'project')
  expect(appServer.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: 'routed', input: expect.arrayContaining([textInput('<!-- project-doc: project_id=project thread_id=routed -->\nDo work')]) }))
  expect(runtime.projectDocLockThreadBinding).toHaveBeenCalledWith('routed')
})
it('notifies the UI of draft migration before changing selection, and keeps that identity on a first-send failure', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread() })
  const replaced = vi.fn(() => expect(result.current.selectedThreadId).toBe('draft'))
  result.current.onDraftThreadReplaced(replaced)
  const successfulRouter = vi.mocked(appServer.startTurn).getMockImplementation()!
  vi.mocked(appServer.startTurn).mockImplementation(async (params) => {
    if (params.threadId === 'router') return successfulRouter(params)
    throw new Error('execution offline')
  })
  await act(async () => { await expect(result.current.sendMessage([textInput('unsent work')], 'queue')).rejects.toThrow('execution offline') })
  expect(replaced).toHaveBeenCalledWith('draft', 'routed')
  expect(result.current.draftOrigins.routed).toBe('draft')
  expect((await readRouteRecord('routed'))?.feedback).toBe('pending')
  vi.mocked(appServer.startTurn).mockResolvedValue(accepted as never)
  await act(async () => { await result.current.sendMessage([textInput('unsent work')], 'queue') })
  expect((await readRouteRecord('routed'))?.status).toBe('started')
  expect((await readRouteRecord('routed'))?.feedback).toBe('pending')
})
it('restores the route and its feedback when a session is reopened in another runtime instance', async () => {
  const first = await ready()
  await act(async () => { await first.result.current.createThread() })
  await act(async () => { await first.result.current.sendMessage([textInput('work')], 'queue') })
  await act(async () => { await first.result.current.giveRouteFeedback('routed', false, '/a') })
  first.unmount()
  vi.mocked(appServer.listThreads).mockResolvedValue({ data: [thread('routed', '/b')], nextCursor: null })
  vi.mocked(appServer.resumeThread).mockResolvedValue(response('routed', '/b') as never)
  const second = await ready()
  await act(async () => { await second.result.current.selectThread('routed') })
  await waitFor(() => expect(second.result.current.currentRoute?.feedback).toBe('inaccurate'))
  expect(second.result.current.currentRoute?.actualWorkspace).toBe('/a')
  expect(second.result.current.currentThread?.cwd).toBe('/b')
})
it('does not treat a system continuation as an implicit user acceptance', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread() })
  await act(async () => { await result.current.sendMessage([textInput('work')], 'queue') })
  act(() => { for (const handle of listeners) handle({ method: 'turn/completed', params: { threadId: 'routed', turn: { id: 'execution-turn', status: 'failed', items: [], error: { message: 'offline' }, startedAt: 1, completedAt: 2, durationMs: 1 } } }) })
  await act(async () => { await result.current.continueAfterFailure() })
  expect(appServer.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ turnTrigger: 'continue-after-failure' }))
  expect((await readRouteRecord('routed'))?.feedback).toBe('pending')
})
it('returns a general request to the neutral directory after switching a manually selected draft back to automatic', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread('/a') })
  await act(async () => { await result.current.changeThreadWorkspace('routed', '') })
  routeChoice = '{"primary":null,"related":[]}'
  await act(async () => { await result.current.sendMessage([textInput('a general question')], 'queue') })
  expect(result.current.currentThread?.cwd).toBe('/neutral')
  expect(result.current.currentRoute?.choice?.primary).toBeNull()
  expect(appServer.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/neutral', input: [textInput('a general question')] }))
})

it.each(['accurate', 'inaccurate'] as const)('dismisses the card after a successful follow-up and preserves a saved %s vote on reopen', async (feedback) => {
  const first = await ready()
  await act(async () => { await first.result.current.createThread() })
  await act(async () => { await first.result.current.sendMessage([textInput('work')], 'queue') })
  await act(async () => { await first.result.current.giveRouteFeedback('routed', feedback === 'accurate', '/a') })
  expect(first.result.current.currentRoute?.feedbackDismissedAt).toBeUndefined()
  await act(async () => { await first.result.current.sendMessage([textInput('continue')], 'queue') })
  expect(first.result.current.currentRoute?.feedbackDismissedAt).toEqual(expect.any(Number))
  expect(first.result.current.currentRoute?.feedback).toBe(feedback)
  first.unmount()
  vi.mocked(appServer.listThreads).mockResolvedValue({ data: [thread('routed', '/b')], nextCursor: null })
  vi.mocked(appServer.resumeThread).mockResolvedValue(response('routed', '/b') as never)
  const second = await ready()
  await act(async () => { await second.result.current.selectThread('routed') })
  await waitFor(() => expect(second.result.current.currentRoute?.feedbackDismissedAt).toEqual(expect.any(Number)))
  expect(second.result.current.currentRoute?.feedback).toBe(feedback)
})
async function finishExecution() {
  await act(async () => { for (const listener of [...listeners]) listener({ method: 'turn/completed', params: { threadId: 'routed', turn: { id: 'execution-turn', status: 'completed', items: [] } } }) })
}
it('requires an idle turn for correction, then updates cwd without replaying the original task', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread() })
  await act(async () => { await result.current.sendMessage([textInput('work')], 'queue') })
  await act(async () => { await expect(result.current.correctRouteWorkspace('routed', '/a')).rejects.toThrow('当前轮') })
  expect(appServer.updateThreadSettings).not.toHaveBeenCalledWith(expect.objectContaining({ cwd: '/a' }))
  await finishExecution()
  const calls = vi.mocked(appServer.startTurn).mock.calls.length
  await act(async () => { await result.current.correctRouteWorkspace('routed', '/a') })
  expect(appServer.updateThreadSettings).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'routed', cwd: '/a' }))
  expect(result.current.currentThread?.cwd).toBe('/a')
  expect((await readRouteRecord('routed'))?.actualWorkspace).toBe('/a')
  expect(appServer.startTurn).toHaveBeenCalledTimes(calls)
  expect(appServer.interruptTurn).not.toHaveBeenCalled()
})
it('can explicitly correct a routed task to the neutral general workspace', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread() })
  await act(async () => { await result.current.sendMessage([textInput('work')], 'queue') })
  await finishExecution()
  await act(async () => { await result.current.correctRouteWorkspace('routed', null) })
  expect(result.current.currentThread?.cwd).toBe('/neutral')
  expect((await readRouteRecord('routed'))?.actualWorkspace).toBeNull()
})
it('retains the saved feedback when applying the corrected directory fails', async () => {
  const { result } = await ready()
  await act(async () => { await result.current.createThread() })
  await act(async () => { await result.current.sendMessage([textInput('work')], 'queue') })
  await finishExecution()
  vi.mocked(appServer.updateThreadSettings).mockRejectedValueOnce(new Error('offline'))
  await act(async () => { await expect(result.current.correctRouteWorkspace('routed', '/a')).rejects.toThrow('反馈已保存') })
  expect(result.current.currentThread?.cwd).toBe('/b')
  expect((await readRouteRecord('routed'))?.actualWorkspace).toBe('/a')
})
