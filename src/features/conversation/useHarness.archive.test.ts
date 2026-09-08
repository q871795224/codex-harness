import { notifications } from '../../core/notifications/service'
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
    resumeThread: vi.fn(), listQueue: vi.fn().mockResolvedValue({ data: [] }),
  },
}))

const thread = (id: string): Thread => ({
  id, cwd: '/repo', name: id, preview: '', ephemeral: false,
  createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: 'idle' }, canAcceptDirectInput: true,
})
const page = (id: string) => ({ data: [thread(id)], nextCursor: null })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function ready() {
  const hook = renderHook(() => useHarness())
  await waitFor(() => expect(hook.result.current.phase).toBe('ready'))
  return hook
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(appServer.listThreads).mockReset()
  vi.mocked(appServer.startTurn).mockReset()
  vi.mocked(appServer.listThreads).mockImplementation(async (params) => page(params.archived ? 'archived' : 'active'))
})
afterEach(cleanup)

describe('archive view navigation', () => {
  it.each([true, false])('keeps a new local draft when thread/started arrives before start response: %s', async (notificationFirst) => {
    vi.mocked(runtime.listWorkspaces).mockResolvedValueOnce([{ root: '/repo', checkoutRoot: '/repo', name: 'repo', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 }])
    vi.mocked(appServer.startThread).mockResolvedValue({
      thread: thread('draft'), approvalPolicy: 'never', approvalsReviewer: 'user',
      model: 'test', reasoningEffort: null, serviceTier: null,
      sandbox: { type: 'dangerFullAccess' }, runtimeWorkspaceRoots: ['/repo'], activePermissionProfile: null,
    })
    const { result } = await ready()
    const pending = deferred<ReturnType<typeof page>>()
    vi.mocked(appServer.listThreads).mockReturnValueOnce(pending.promise)
    const listener = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
    await act(async () => {
      if (notificationFirst) listener({ method: 'thread/started', params: { thread: thread('draft') } } as AppServerEvent)
      await result.current.createThread()
      if (!notificationFirst) listener({ method: 'thread/started', params: { thread: thread('draft') } } as AppServerEvent)
    })
    await act(async () => { pending.resolve(page('active')) })
    expect(result.current.selectedThreadId).toBe('draft')
    expect(result.current.currentThread?.id).toBe('draft')
    expect(result.current.threads.map((item) => item.id)).toEqual(['draft', 'active'])
    expect(result.current.details.draft.thread.id).toBe('draft')
    expect(appServer.resumeThread).not.toHaveBeenCalled()
    await act(async () => { await result.current.setViewMode('archived') })
    expect(result.current.threads.map((item) => item.id)).toEqual(['archived'])
    await act(async () => { await result.current.setViewMode('active') })
    expect(result.current.threads.map((item) => item.id)).toEqual(['draft', 'active'])
    vi.mocked(appServer.listThreads).mockResolvedValueOnce({ data: [thread('draft'), thread('active')], nextCursor: null })
    await act(async () => { await result.current.searchThreads('') })
    expect(result.current.threads.filter((item) => item.id === 'draft')).toHaveLength(1)
    await act(async () => {
      listener({ method: 'thread/deleted', params: { threadId: 'draft' } } as AppServerEvent)
      await result.current.searchThreads('')
    })
    expect(result.current.threads.map((item) => item.id)).toEqual(['active'])
  })
  it('switches both ways without restarting bootstrap or subscriptions', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.setViewMode('archived') })
    expect(result.current.viewMode).toBe('archived')
    expect(result.current.threads.map((item) => item.id)).toEqual(['archived'])
    await act(async () => { await result.current.setViewMode('active') })
    expect(result.current.threads.map((item) => item.id)).toEqual(['active'])
    expect(runtime.listWorkspaces).toHaveBeenCalledTimes(1)
    expect(runtime.listenEvents).toHaveBeenCalledTimes(1)
    expect(appServer.listThreads).toHaveBeenCalledTimes(3)
  })

  it('discards a late archive response after returning to active conversations', async () => {
    const { result } = await ready()
    const pending = deferred<ReturnType<typeof page>>()
    vi.mocked(appServer.listThreads).mockImplementation(async (params) => params.archived ? pending.promise : page('active'))
    let entering!: Promise<void>
    act(() => { entering = result.current.setViewMode('archived') })
    expect(result.current.threads).toEqual([])
    await act(async () => { await result.current.setViewMode('active') })
    await act(async () => { pending.resolve(page('archived')); await entering })
    expect(result.current.viewMode).toBe('active')
    expect(result.current.threads.map((item) => item.id)).toEqual(['active'])
  })

  it('does not show active conversations when the archive request fails', async () => {
    const { result } = await ready()
    vi.mocked(appServer.listThreads).mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await result.current.setViewMode('archived') })
    expect(result.current.viewMode).toBe('archived')
    expect(result.current.threads).toEqual([])
    expect(notifications.snapshot().records[0]?.details).toContain('offline')
  })

  it('keeps the latest search when responses arrive out of order', async () => {
    const { result } = await ready()
    const pending = deferred<ReturnType<typeof page>>()
    vi.mocked(appServer.listThreads).mockImplementation(async (params) => params.searchTerm === 'old' ? pending.promise : page('new'))
    let searching!: Promise<void>
    act(() => { searching = result.current.searchThreads('old') })
    await act(async () => { await result.current.searchThreads('new') })
    await act(async () => { pending.resolve(page('old')); await searching })
    expect(result.current.threads.map((item) => item.id)).toEqual(['new'])
  })

  it('does not insert a newly started active thread into the archive view', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.setViewMode('archived') })
    const listener = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
    await act(async () => { listener({ method: 'thread/started', params: { thread: thread('new') } } as AppServerEvent) })
    expect(result.current.threads.map((item) => item.id)).toEqual(['archived'])
  })

  it('does not reinsert an archived conversation when its history loads after returning', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.setViewMode('archived') })
    const pending = deferred<Awaited<ReturnType<typeof appServer.resumeThread>>>()
    vi.mocked(appServer.resumeThread).mockReturnValue(pending.promise)
    let selecting!: Promise<void>
    act(() => { selecting = result.current.selectThread('archived') })
    await act(async () => { await result.current.setViewMode('active') })
    await act(async () => {
      pending.resolve({
        thread: thread('archived'), approvalPolicy: 'never', approvalsReviewer: 'user',
        model: 'test', reasoningEffort: null, serviceTier: null,
        sandbox: { type: 'dangerFullAccess' }, runtimeWorkspaceRoots: [], activePermissionProfile: null,
      })
      await selecting
    })
    expect(result.current.details.archived.thread.id).toBe('archived')
    expect(result.current.threads.map((item) => item.id)).toEqual(['active'])
  })

  it('preserves the search filter when switching views and refreshing', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.searchThreads('delivery') })
    await act(async () => { await result.current.setViewMode('archived') })
    await act(async () => { await result.current.refresh() })
    expect(appServer.listThreads).toHaveBeenLastCalledWith(expect.objectContaining({ archived: true, searchTerm: 'delivery' }))
  })
})


describe('first-turn catalog refresh', () => {
  async function draft() {
    vi.mocked(runtime.listWorkspaces).mockResolvedValueOnce([{ root: '/repo', checkoutRoot: '/repo', name: 'repo', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 }])
    vi.mocked(appServer.startThread).mockImplementation(async (params) => ({
      thread: { ...thread(params.cwd === '/other' ? 'replacement' : 'draft'), cwd: String(params.cwd) },
      approvalPolicy: 'never', approvalsReviewer: 'user', model: 'test', reasoningEffort: null,
      serviceTier: null, sandbox: { type: 'dangerFullAccess' }, runtimeWorkspaceRoots: [String(params.cwd)],
      activePermissionProfile: null,
    }))
    const hook = await ready()
    await act(async () => { await hook.result.current.createThread() })
    return hook
  }
  const accepted = { turn: { id: 'turn-1', status: 'inProgress' as const, items: [], error: null, startedAt: 1, completedAt: null, durationMs: null } }
  const input = [{ type: 'text' as const, text: 'usage analysis', text_elements: [] }]

  it.each([false, true])('keeps the first turn visible through stale lists and then loads server data (changed cwd: %s)', async (changeCwd) => {
    const { result } = await draft()
    if (changeCwd) {
      vi.mocked(runtime.mapThreadWorkspaces).mockResolvedValueOnce({
        '/other': { root: '/other', checkoutRoot: '/other', name: 'other', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 },
      })
      await act(async () => { await result.current.changeThreadWorkspace('draft', '/other') })
    }
    const id = changeCwd ? 'replacement' : 'draft'
    const oldList = deferred<ReturnType<typeof page>>()
    vi.mocked(appServer.listThreads).mockReturnValueOnce(oldList.promise)
    let oldRefresh!: Promise<void>
    act(() => { oldRefresh = result.current.refresh() })
    const turn = deferred<typeof accepted>()
    vi.mocked(appServer.startTurn).mockReturnValueOnce(turn.promise)
    let sending!: Promise<void>
    await act(async () => { sending = result.current.sendMessage(input, 'queue') })
    expect(appServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({ threadId: id }))
    // This request starts while turn/start is still pending and legitimately
    // omits the new thread. Neither it nor the earlier request may hide it.
    await act(async () => { await result.current.refresh() })
    expect(result.current.currentThread?.id).toBe(id)
    expect(result.current.threads.some((item) => item.id === id)).toBe(true)

    const freshList = deferred<ReturnType<typeof page>>()
    vi.mocked(appServer.listThreads).mockReturnValueOnce(freshList.promise)
    const callsBeforeAcceptance = vi.mocked(appServer.listThreads).mock.calls.length
    await act(async () => { turn.resolve(accepted); await sending })
    expect(appServer.listThreads).toHaveBeenCalledTimes(callsBeforeAcceptance + 1)
    expect(result.current.currentThread?.id).toBe(id)
    const persisted = { ...thread(id), name: 'server title', cwd: changeCwd ? '/other' : '/repo' }
    await act(async () => { freshList.resolve({ data: [persisted], nextCursor: null }) })
    await act(async () => { oldList.resolve(page('active')); await oldRefresh })
    expect(result.current.currentThread).toMatchObject(persisted)
    expect(result.current.threads.map((item) => item.id)).toEqual([id])
    if (changeCwd) expect(appServer.deleteThread).toHaveBeenCalledWith('draft')
    expect(appServer.deleteThread).not.toHaveBeenCalledWith(id)

    // Once the server has acknowledged it, normal catalog filtering takes over.
    await act(async () => { await result.current.searchThreads('different title') })
    expect(result.current.threads.map((item) => item.id)).toEqual(['active'])
  })

  it('does not report a sent message as failed when the follow-up list query fails', async () => {
    const { result } = await draft()
    vi.mocked(appServer.startTurn).mockResolvedValueOnce(accepted)
    vi.mocked(appServer.listThreads).mockRejectedValueOnce(new Error('list offline'))
    await act(async () => { await result.current.sendMessage(input, 'queue') })
    expect(result.current.activeTurnId).toBe('turn-1')
    expect(result.current.currentThread?.id).toBe('draft')
    expect(notifications.snapshot().records[0]?.details).toContain('list offline')
    expect(notifications.snapshot().records[0]).toMatchObject({ level: 'warning', title: '消息已发送，但会话列表暂未更新。' })
    await act(async () => { await result.current.refresh() })
    expect(result.current.currentThread?.id).toBe('draft')
    const listener = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
    await act(async () => {
      listener({ method: 'thread/archived', params: { threadId: 'draft' } } as AppServerEvent)
      await result.current.refresh()
    })
    expect(result.current.threads.map((item) => item.id)).toEqual(['active'])
  })

  it('keeps a failed first submission available for retry after a list refresh', async () => {
    const { result } = await draft()
    vi.mocked(appServer.startTurn).mockRejectedValueOnce(new Error('send offline'))
    await act(async () => {
      await expect(result.current.sendMessage(input, 'queue')).rejects.toThrow('send offline')
    })
    await act(async () => { await result.current.refresh() })
    expect(result.current.currentThread?.id).toBe('draft')
    vi.mocked(appServer.startTurn).mockResolvedValueOnce(accepted)
    vi.mocked(appServer.listThreads).mockResolvedValueOnce(page('draft'))
    await act(async () => { await result.current.sendMessage(input, 'queue') })
    expect(result.current.currentThread?.id).toBe('draft')
    expect(result.current.activeTurnId).toBe('turn-1')
  })
})
