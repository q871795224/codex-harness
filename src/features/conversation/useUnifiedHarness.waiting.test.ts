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
    superbotRequest: vi.fn().mockResolvedValue([]),
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
    startClaudeTurn: vi.fn().mockResolvedValue(undefined),
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
  vi.mocked(runtime.superbotRequest).mockResolvedValue([])
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
  it('opens and creates cloud sessions without routing them into Codex or Claude', async () => {
    const remote = { id: 'remote', title: 'Superbot', status: 'active', read_only: false, run_config: {}, runtime_id: 'cloud', created_at: '2026-11-17T08:00:00Z', updated_at: '2026-11-17T08:00:00Z' }
    vi.mocked(runtime.superbotRequest).mockImplementation(async request => {
      if (request.type === 'list') return [remote]
      if (request.type === 'create') return { ...remote, id: 'new' }
      if (request.type === 'read') return { session: remote, page: { messages: [], has_more: false, next_cursor: null }, pending: {}, events: [] }
      return {}
    })
    const { result } = await ready()
    await waitFor(() => expect(result.current.superbot.loaded).toBe(true))
    vi.mocked(appServer.resumeThread).mockClear()
    await act(async () => { await result.current.selectThread('superbot:remote') })
    expect(result.current.selectedProvider).toBe('superbot')
    expect(result.current.currentThread?.cwd).toBe('')
    expect(appServer.resumeThread).not.toHaveBeenCalled()
    await expect(result.current.sendMessage([{ type: 'text', text: 'must not leak', text_elements: [] }], 'queue')).rejects.toThrow('Superbot')
    await expect(result.current.changeThreadWorkspace('superbot:remote', '/repo')).rejects.toThrow('云端')
    expect(appServer.startTurn).not.toHaveBeenCalled()
    expect(runtime.startClaudeTurn).not.toHaveBeenCalled()
    await act(async () => { await result.current.createThread('superbot') })
    expect(result.current.selectedThreadId).toBe('superbot:new')
    expect(runtime.superbotRequest).toHaveBeenCalledWith({ type: 'create' })
  })

  it('dispatches delayed messages to their original provider after switching conversations', async () => {
    const { result } = await ready()
    const input = [{ type: 'text' as const, text: 'later', text_elements: [] }]
    vi.mocked(appServer.startTurn).mockResolvedValueOnce({ turn: {
      id: 'delayed', status: 'inProgress', items: [], error: null,
      startedAt: null, completedAt: null, durationMs: null,
    } })
    await act(async () => { await result.current.selectThread('claude:active') })
    await act(async () => { await result.current.sendMessage(input, 'queue', [], undefined, 'active') })
    expect(appServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'active', input }))
    expect(runtime.startClaudeTurn).not.toHaveBeenCalled()
    expect(result.current.selectedThreadId).toBe('claude:active')
    await act(async () => { await result.current.selectThread('active') })
    await act(async () => { await result.current.sendMessage(input, 'queue', [], undefined, 'claude:active') })
    expect(runtime.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'claude:active', input }))
    expect(appServer.startTurn).toHaveBeenCalledTimes(1)
    expect(result.current.selectedThreadId).toBe('active')
  })

  it('emits message submission only when sending, not when switching conversations', async () => {
    const { result } = await ready()
    const activity = vi.fn()
    const unsubscribe = result.current.onMessageSubmitted(activity)
    await act(async () => { await result.current.selectThread('active') })
    expect(activity).not.toHaveBeenCalled()
    vi.mocked(appServer.startTurn).mockResolvedValueOnce({ turn: {
      id: 'new-turn', status: 'inProgress', items: [], error: null,
      startedAt: null, completedAt: null, durationMs: null,
    } })
    await act(async () => { await result.current.sendMessage([{ type: 'text', text: 'hello', text_elements: [] }], 'interject') })
    expect(activity).toHaveBeenCalledWith('active')
    await act(async () => { await result.current.selectThread('claude:active') })
    expect(activity).toHaveBeenCalledTimes(1)
    expect(activity).toHaveBeenLastCalledWith('active')
    unsubscribe()
  })

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

it('emits accepted user messages after send succeeds, keeping failed sends and agent replies separate', async () => {
  const {result}=await ready()
  const accepted=vi.fn()
  const stop=result.current.onMessageAccepted(accepted)
  await act(async () => { await result.current.selectThread('active') })
  const event=vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
  act(() => event({method:'item/completed',params:{threadId:'active',turnId:'old',item:{type:'agentMessage',id:'old',text:'Agent 回复'}}}))
  expect(accepted).not.toHaveBeenCalled()
  vi.mocked(appServer.startTurn).mockRejectedValueOnce(new Error('send failed'))
  await act(async () => {
    await expect(result.current.sendMessage([{type:'text',text:'hello',text_elements:[]}],'interject')).rejects.toThrow('send failed')
  })
  expect(accepted).not.toHaveBeenCalled()
  vi.mocked(appServer.startTurn).mockResolvedValueOnce({turn:{id:'new-turn',status:'inProgress',items:[],error:null,startedAt:null,completedAt:null,durationMs:null}})
  await act(async () => { await result.current.sendMessage([{type:'text',text:'hello',text_elements:[]}],'interject') })
  expect(accepted).toHaveBeenCalledExactlyOnceWith('active')
  await act(async () => { await result.current.selectThread('claude:active') })
  act(() => vi.mocked(runtime.listenClaudeEvents).mock.calls.at(-1)![0]({method:'turn/started',params:{sessionId:'claude:active',turnId:'turn-c'}}))
  await act(async () => { await result.current.sendMessage([{type:'text',text:'queued',text_elements:[]}],'queue') })
  expect(accepted.mock.calls.map(([id])=>id)).toEqual(['active','claude:active'])
  stop()
})
