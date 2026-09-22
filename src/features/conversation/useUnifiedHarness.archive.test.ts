// @vitest-environment jsdom
import { notifications } from '../../core/notifications/service'
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
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
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

describe('unified archive view', () => {
  it('switches both providers when manually entering and leaving archives', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.setViewMode('archived') })
    expect(result.current.threads.map((thread) => thread.id)).toEqual(['claude:archived', 'archived'])
    await act(async () => { await result.current.setViewMode('active') })
    expect(result.current.threads.map((thread) => thread.id)).toEqual(['claude:active', 'active'])
  })

  it('clears stale Claude sessions and reports a failed view refresh', async () => {
    const publish = vi.spyOn(notifications, 'publish')
    const { result } = await ready()
    vi.mocked(runtime.listClaudeSessions).mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await result.current.setViewMode('archived') })
    expect(result.current.threads.map((thread) => thread.id)).toEqual(['archived'])
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ title: '无法读取 Claude 会话', level: 'error' }))
    publish.mockRestore()
  })

  it('reloads active Claude sessions when restoring Codex switches back to active', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.setViewMode('archived') })
    expect(result.current.threads.map((thread) => thread.id)).toEqual(['claude:archived', 'archived'])
    vi.mocked(appServer.listThreads).mockImplementation(async (params) => params.archived ? { data: [], nextCursor: null } : page('archived'))
    vi.mocked(appServer.resumeThread).mockResolvedValue(resumeResponse('archived'))

    await act(async () => { await result.current.unarchiveThread('archived') })

    expect(result.current.viewMode).toBe('active')
    expect(result.current.threads.map((thread) => thread.id)).toEqual(['claude:active', 'archived'])
    expect(runtime.listClaudeSessions).toHaveBeenLastCalledWith(false)
  })

  it('keeps both archive lists when restoring Codex fails', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.setViewMode('archived') })
    vi.mocked(appServer.unarchiveThread).mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await result.current.unarchiveThread('archived') })
    expect(result.current.viewMode).toBe('archived')
    expect(result.current.threads.map((thread) => thread.id)).toEqual(['claude:archived', 'archived'])
  })

  it('discards a late Claude archive response after restoring Codex', async () => {
    const { result } = await ready()
    const pending = deferred<Awaited<ReturnType<typeof runtime.listClaudeSessions>>>()
    vi.mocked(runtime.listClaudeSessions).mockImplementationOnce(() => pending.promise)
    let entering!: Promise<void>
    act(() => { entering = result.current.setViewMode('archived') })
    await waitFor(() => expect(runtime.listClaudeSessions).toHaveBeenLastCalledWith(true))
    vi.mocked(appServer.listThreads).mockImplementation(async (params) => params.archived ? { data: [], nextCursor: null } : page('archived'))
    vi.mocked(appServer.resumeThread).mockResolvedValue(resumeResponse('archived'))
    await act(async () => { await result.current.unarchiveThread('archived') })
    await act(async () => {
      pending.resolve([{ id: 'claude:archived', archived: true, providerSessionId: null, title: 'test', cwd: '/repo', createdAt: 1, updatedAt: 1 }])
      await entering
    })
    expect(result.current.viewMode).toBe('active')
    expect(result.current.threads.map((thread) => thread.id)).toEqual(['claude:active', 'archived'])
  })
})
