// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { appServer } from '../../core/runtime/appServerClient'
import { useUnifiedHarness } from './useUnifiedHarness'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ listen: vi.fn().mockResolvedValue(() => {}) }),
}))

vi.mock('../../core/runtime/bridge', () => ({
  diagnosticErrorCode: vi.fn(), recordWorkspaceContextDiagnostic: vi.fn(),
  runtime: {
    recordClientDiagnostic: vi.fn().mockResolvedValue(undefined),
    listenClaudeEvents: vi.fn().mockResolvedValue(() => {}),
    listenClaudeTransport: vi.fn().mockResolvedValue(() => {}),
    claudeRuntimeStatus: vi.fn().mockResolvedValue({ available: false }),
    listClaudeSessions: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listThreadStates: vi.fn().mockResolvedValue([]),
    getAppState: vi.fn().mockResolvedValue(null),
    setAppState: vi.fn().mockResolvedValue(undefined),
    setThreadState: vi.fn().mockResolvedValue(undefined),
    mapThreadWorkspaces: vi.fn().mockResolvedValue({}),
    listenEvents: vi.fn().mockResolvedValue(() => {}),
    listenTransport: vi.fn().mockResolvedValue(() => {}),
    stopClaudeSession: vi.fn().mockResolvedValue(undefined),
    readClaudeContext: vi.fn().mockResolvedValue(null),
  },
}))
vi.mock('../../core/runtime/appServerClient', () => ({
  appServer: {
    listThreads: vi.fn(), archiveThread: vi.fn().mockResolvedValue(undefined),
    startTurn: vi.fn(), addQueue: vi.fn().mockResolvedValue(undefined), steerTurn: vi.fn().mockResolvedValue(undefined), updateThreadSettings: vi.fn().mockResolvedValue(undefined),
    updateThreadMetadata: vi.fn().mockResolvedValue(undefined),
    startThread: vi.fn(), deleteThread: vi.fn().mockResolvedValue(undefined),
    resumeThread: vi.fn(), listQueue: vi.fn().mockResolvedValue({ data: [] }),
    readThread: vi.fn(), listTurns: vi.fn(), unarchiveThread: vi.fn().mockResolvedValue(undefined),
  },
}))

const thread = (id: string): Thread => ({
  id, cwd: '/repo', name: id, preview: '', ephemeral: false,
  createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: 'idle' }, canAcceptDirectInput: true,
})
const resumeResponse = (id: string) => ({
  thread: thread(id), approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const,
  model: 'test', reasoningEffort: null, serviceTier: null,
  sandbox: { type: 'dangerFullAccess' as const }, runtimeWorkspaceRoots: [], activePermissionProfile: null,
})
const page = (id: string) => ({ data: [thread(id)], nextCursor: null })
async function ready() {
  const hook = renderHook(() => useUnifiedHarness())
  await waitFor(() => expect(hook.result.current.phase).toBe('ready'))
  await waitFor(() => expect(hook.result.current.threads.some((thread) => thread.id === 'claude:active')).toBe(true))
  return hook
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(appServer.unarchiveThread).mockResolvedValue(undefined)
  vi.mocked(runtime.listClaudeSessions).mockImplementation(async (archived = false) => [{
    id: archived ? 'claude:archived' : 'claude:active', archived,
    providerSessionId: null, title: 'test', cwd: '/repo', createdAt: 1, updatedAt: 1,
  }])
  vi.mocked(appServer.listThreads).mockReset()
  vi.mocked(appServer.startTurn).mockReset()
  vi.mocked(appServer.listThreads).mockImplementation(async (params) => page(params.archived ? 'archived' : 'active'))
})
afterEach(cleanup)

describe('waiting indicators', () => {
  it('keeps Claude sidebar and stop controls active after the foreground turn ends', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.selectThread('claude:active') })
    const listener = vi.mocked(runtime.listenClaudeEvents).mock.calls.at(-1)![0]
    await act(async () => {
      listener({ method: 'turn/started', params: { sessionId: 'claude:active', turnId: 'first' } })
      listener({ method: 'session/activity', seq: 10, params: { sessionId: 'claude:active', state: 'idle', backgroundTaskCount: 2 } })
      listener({ method: 'turn/completed', params: { sessionId: 'claude:active', turnId: 'first' } })
    })
    expect(result.current.activeTurnId).toBeNull()
    expect(result.current.currentDetail?.turns[0].status).toBe('completed')
    expect(result.current.workingThreadIds['claude:active']).toBe(true)
    expect(result.current.isCurrentWorking).toBe(true)
    expect(result.current.isCurrentBackgroundWorking).toBe(true)
    await act(async () => { await result.current.stopTurn() })
    expect(runtime.stopClaudeSession).toHaveBeenCalledExactlyOnceWith('claude:active')
    expect(result.current.isCurrentWorking).toBe(true) // A control ACK is not a stop confirmation.
    await act(async () => {
      listener({ method: 'session/activity', seq: 11, params: { sessionId: 'claude:active', state: 'idle', backgroundTaskCount: 0 } })
    })
    expect(result.current.workingThreadIds['claude:active']).toBeUndefined()
    expect(result.current.isCurrentWorking).toBe(false)
  })

  it('tracks SDK work and action requests that resume without a new user turn', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.selectThread('claude:active') })
    const listener = vi.mocked(runtime.listenClaudeEvents).mock.calls.at(-1)![0]
    await act(async () => {
      listener({ method: 'session/activity', seq: 10, params: { sessionId: 'claude:active', state: 'running', backgroundTaskCount: 0 } })
    })
    expect(result.current.activeTurnId).toBeNull()
    expect(result.current.isCurrentWorking).toBe(true)
    await act(async () => {
      listener({ method: 'session/activity', seq: 11, params: { sessionId: 'claude:active', state: 'requires_action', backgroundTaskCount: 0 } })
    })
    expect(result.current.waitingThreadIds['claude:active']).toBe(true)
    await act(async () => {
      listener({ method: 'session/activity', seq: 12, params: { sessionId: 'claude:active', state: 'idle', backgroundTaskCount: 0 } })
    })
    expect(result.current.isCurrentWorking).toBe(false)
    expect(result.current.waitingThreadIds['claude:active']).toBeUndefined()
  })

  it.each(['item/commandExecution/requestApproval', 'item/tool/requestUserInput'])('tracks %s independently of thread selection until resolved', async (method) => {
    const { result } = await ready()
    const listener = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
    await act(async () => { listener({ id: 'request', method, params: { threadId: 'active', turnId: 'turn-1' } }) })
    expect(result.current.waitingThreadIds.active).toBe(true)
    await act(async () => { listener({ method: 'serverRequest/resolved', params: { threadId: 'active', requestId: 'request' } }) })
    expect(result.current.waitingThreadIds.active).toBeUndefined()
  })

  it('tracks an async question while a different conversation is selected and clears it after an answer', async () => {
    const { result } = await ready()
    vi.mocked(appServer.resumeThread).mockResolvedValue(resumeResponse('active'))
    await act(async () => { await result.current.selectThread('active') })
    const listener = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
    await act(async () => {
      listener({ method: 'turn/started', params: { threadId: 'active', turn: { id: 'turn-1', status: 'inProgress', items: [], error: null } } })
      listener({ method: 'item/completed', params: { threadId: 'active', turnId: 'turn-1', item: {
        type: 'agentMessage', id: 'question', delivery: 'async', questions: [{ title: '名称？' }],
      } } })
    })
    await act(async () => { await result.current.selectThread('claude:active') })
    expect(result.current.waitingThreadIds.active).toBe(true)
    await act(async () => { listener({ method: 'item/completed', params: { threadId: 'active', turnId: 'turn-1', item: {
      type: 'userMessage', id: 'answer', content: [{ type: 'text', text: '问题：名称？\n回答：测试名称', text_elements: [] }],
    } } }) })
    expect(result.current.waitingThreadIds.active).toBeUndefined()
  })
})
