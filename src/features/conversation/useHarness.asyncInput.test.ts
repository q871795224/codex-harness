// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppServerEvent, Thread } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { appServer } from '../../core/runtime/appServerClient'
import { useHarness } from './useHarness'
import { asyncUserInputRequest } from './asyncUserInput'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ listen: vi.fn().mockResolvedValue(() => {}) }),
}))

vi.mock('../../core/runtime/bridge', () => ({
  diagnosticErrorCode: vi.fn(), recordWorkspaceContextDiagnostic: vi.fn(),
  runtime: {
    respond: vi.fn().mockResolvedValue(undefined),
    recordClientDiagnostic: vi.fn().mockResolvedValue(undefined),
    listWorkspaces: vi.fn().mockResolvedValue([]),
    listThreadStates: vi.fn().mockResolvedValue([]),
    getAppState: vi.fn().mockResolvedValue(null),
    setAppState: vi.fn().mockResolvedValue(undefined),
    setThreadState: vi.fn().mockResolvedValue(undefined),
    mapThreadWorkspaces: vi.fn().mockResolvedValue({}),
    listenEvents: vi.fn().mockResolvedValue(() => {}),
    listenTransport: vi.fn().mockResolvedValue(() => {}),
  },
}))
vi.mock('../../core/runtime/appServerClient', () => ({
  appServer: {
    listThreads: vi.fn(), archiveThread: vi.fn().mockResolvedValue(undefined),
    steerTurn: vi.fn().mockResolvedValue(undefined), startTurn: vi.fn(), updateThreadSettings: vi.fn().mockResolvedValue(undefined),
    updateThreadMetadata: vi.fn().mockResolvedValue(undefined),
    startThread: vi.fn(), deleteThread: vi.fn().mockResolvedValue(undefined),
    resumeThread: vi.fn(), forkThread: vi.fn(), listQueue: vi.fn().mockResolvedValue({ data: [] }),
  },
}))

const thread = (id: string): Thread => ({
  id, cwd: '/repo', name: id, preview: '', ephemeral: false,
  createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: 'idle' }, canAcceptDirectInput: true,
})
const page = (id: string) => ({ data: [thread(id)], nextCursor: null })
const resumeResponse = (id: string) => ({
  thread: thread(id), runtimeWorkspaceRoots: ['/repo'], initialTurnsPage: null,
  sandbox: { type: 'dangerFullAccess' as const }, activePermissionProfile: null,
  model: 'test', approvalPolicy: 'never' as const, approvalsReviewer: 'user' as const,
  reasoningEffort: null, serviceTier: null,
})
async function ready() {
  const hook = renderHook(() => useHarness())
  await waitFor(() => expect(hook.result.current.phase).toBe('ready'))
  return hook
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(appServer.listThreads).mockImplementation(async (params) => page(params.archived ? 'archived' : 'active'))
  vi.mocked(appServer.resumeThread).mockImplementation(async (params) => resumeResponse(String(params.threadId)))
})
afterEach(cleanup)

const request = asyncUserInputRequest('active', {
  type: 'agentMessage', id: 'question-1', delivery: 'async',
  questions: [{ title: '如何分发？', options: ['安装包'] }],
})!
const response = { answers: { 'question-0': { answers: ['安装包'] } } }

describe('async question submission', () => {
  it.each(['completed', 'interrupted', 'failed'])('clears synchronous questions for a %s turn without a resolved notification', async (status) => {
    const { result } = await ready()
    const listener = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
    await act(async () => {
      listener({ id: 'old', method: 'item/tool/requestUserInput', params: { threadId: 'active', turnId: 'old-turn' } })
      listener({ id: 'new', method: 'item/tool/requestUserInput', params: { threadId: 'active', turnId: 'new-turn' } })
      listener({ id: 'other', method: 'item/tool/requestUserInput', params: { threadId: 'other', turnId: 'old-turn' } })
    })
    expect(result.current.approvals.active).toHaveLength(2)
    await act(async () => {
      listener({ method: 'turn/completed', params: { threadId: 'active', turn: {
        id: 'old-turn', status, items: [], error: null,
      } } })
    })
    expect(result.current.approvals.active.map((request) => request.id)).toEqual(['new'])
    expect(result.current.approvals.other.map((request) => request.id)).toEqual(['other'])
  })

  it('starts a turn in the originating thread even after selection changes', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.selectThread('active') })
    await act(async () => { await result.current.selectThread('other') })
    vi.mocked(appServer.startTurn).mockResolvedValueOnce({ turn: { id: 'answer-turn', status: 'inProgress', items: [], error: null, startedAt: null, completedAt: null, durationMs: null } })
    await act(async () => { await result.current.answerApproval(request, response) })
    expect(appServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'active', input: [expect.objectContaining({ type: 'text', text: '问题：如何分发？\n回答：安装包' })],
    }))
    expect(runtime.respond).not.toHaveBeenCalled()
  })

  it('steers an owned active turn without starting another turn or responding to an RPC', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.selectThread('active') })
    vi.mocked(appServer.startTurn).mockResolvedValueOnce({ turn: { id: 'working-turn', status: 'inProgress', items: [], error: null, startedAt: null, completedAt: null, durationMs: null } })
    await act(async () => { await result.current.startTurnInThread('active', '检查依赖') })
    await act(async () => { await result.current.answerApproval(request, response) })
    expect(appServer.steerTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'active', expectedTurnId: 'working-turn',
      input: [expect.objectContaining({ text: '问题：如何分发？\n回答：安装包' })],
    }))
    expect(appServer.startTurn).toHaveBeenCalledTimes(1)
    expect(runtime.respond).not.toHaveBeenCalled()
  })

  it('propagates send failures so the card can remain open for retry', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.selectThread('active') })
    vi.mocked(appServer.startTurn).mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await expect(result.current.answerApproval(request, response)).rejects.toThrow('offline') })
    expect(runtime.respond).not.toHaveBeenCalled()
  })

  it('refuses to steer a turn owned by another client', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.selectThread('active') })
    const listener = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
    await act(async () => { listener({ method: 'turn/started', params: {
      threadId: 'active', turn: { id: 'foreign-turn', status: 'inProgress', items: [], error: null },
    } } as AppServerEvent) })
    await act(async () => { await expect(result.current.answerApproval(request, response)).rejects.toThrow('其他客户端') })
    expect(appServer.steerTurn).not.toHaveBeenCalled()
    expect(appServer.startTurn).not.toHaveBeenCalled()
  })

  it('preserves the synchronous server-request response path', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.answerApproval({ ...request, method: 'item/tool/requestUserInput' }, response) })
    expect(runtime.respond).toHaveBeenCalledWith(request.id, response)
    expect(appServer.startTurn).not.toHaveBeenCalled()
  })
})
