// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppServerEvent, Thread } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { appServer } from '../../core/runtime/appServerClient'
import { useHarness } from './useHarness'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ listen: vi.fn().mockResolvedValue(() => {}) }),
}))

vi.mock('../../core/runtime/bridge', () => ({
  diagnosticErrorCode: vi.fn(), recordWorkspaceContextDiagnostic: vi.fn(),
  runtime: {
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
    startTurn: vi.fn(), updateThreadSettings: vi.fn().mockResolvedValue(undefined),
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

describe('fork catalog retention', () => {
  it('keeps the forked thread in the list until the catalog acknowledges it', async () => {
    vi.mocked(runtime.listWorkspaces).mockResolvedValueOnce([{ root: '/repo', checkoutRoot: '/repo', name: 'repo', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 }])
    vi.mocked(appServer.listThreads).mockResolvedValueOnce(page('source'))
    const { result } = await ready()
    await act(async () => { await result.current.selectThread('source') })
    const listener = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]

    vi.mocked(appServer.forkThread).mockResolvedValueOnce({
      thread: thread('forked'),
      approvalPolicy: 'never', approvalsReviewer: 'user', model: 'test', reasoningEffort: null,
      serviceTier: null, sandbox: { type: 'dangerFullAccess' },
    })
    // The fork's own thread/started notification refreshes the catalog, and the
    // forked thread is excluded from thread/list until its first turn.
    vi.mocked(appServer.listThreads).mockImplementation(async (params) => page(params.archived ? 'archived' : 'source'))
    await act(async () => {
      const forking = result.current.forkThreadAtTurn('turn-1')
      listener({ method: 'thread/started', params: { thread: thread('forked') } } as AppServerEvent)
      await forking
    })
    expect(result.current.selectedThreadId).toBe('forked')
    expect(result.current.threads.map((item) => item.id)).toEqual(['forked', 'source'])

    // Later refreshes keep the fork locally until thread/list includes it.
    await act(async () => { await result.current.refresh() })
    expect(result.current.threads.map((item) => item.id)).toEqual(['forked', 'source'])

    // Once the catalog acknowledges the fork, normal filtering takes over.
    vi.mocked(appServer.listThreads).mockResolvedValueOnce({ data: [thread('source'), thread('forked')], nextCursor: null })
    await act(async () => { await result.current.refresh() })
    expect(result.current.threads.map((item) => item.id)).toEqual(['source', 'forked'])
  })
})
