import { notifications } from '../../core/notifications/service'
// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppServerEvent, Thread, Turn } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { appServer } from '../../core/runtime/appServerClient'
import { useHarness } from './useHarness'
import * as messageReferences from './messageReferences'

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
const turn = (id: string): Turn => ({
  id, status: 'completed', items: [{ id: `item-${id}`, type: 'agentMessage', text: id }],
  error: null, startedAt: 1, completedAt: 2, durationMs: 1,
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
  it('keeps successful archive notifications silent but reports archive failures', async () => {
    const publish = vi.spyOn(notifications, 'publish')
    const { result } = await ready()
    await act(async () => { await result.current.archiveThread('active') })
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ title: '已归档会话', silent: true, threadId: 'active' }))
    vi.mocked(appServer.archiveThread).mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await result.current.archiveThread('other') })
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ title: '无法归档会话', level: 'error', silent: undefined }))
    publish.mockRestore()
  })

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
    const pending = deferred<Awaited<ReturnType<typeof appServer.readThread>>>()
    vi.mocked(appServer.readThread).mockReturnValue(pending.promise)
    vi.mocked(appServer.listTurns).mockResolvedValue({ data: [], nextCursor: null })
    let selecting!: Promise<void>
    act(() => { selecting = result.current.selectThread('archived') })
    await act(async () => { await result.current.setViewMode('active') })
    await act(async () => {
      pending.resolve({ thread: thread('archived') })
      await selecting
    })
    expect(result.current.details.archived.thread.id).toBe('archived')
    expect(result.current.threads.map((item) => item.id)).toEqual(['active'])
  })

  it('loads an archived conversation read-only without resuming it', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.setViewMode('archived') })
    vi.mocked(appServer.readThread).mockResolvedValue({ thread: thread('archived') })
    vi.mocked(appServer.listTurns).mockResolvedValue({ data: [turn('turn-new'), turn('turn-old')], nextCursor: 'older-page' })
    await act(async () => { await result.current.selectThread('archived') })
    expect(appServer.resumeThread).not.toHaveBeenCalled()
    expect(appServer.readThread).toHaveBeenCalledWith({ threadId: 'archived', includeTurns: false })
    expect(appServer.listTurns).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'archived', limit: 5, sortDirection: 'desc' }))
    const detail = result.current.details.archived
    expect(detail.turns.map((item) => item.id)).toEqual(['turn-old', 'turn-new'])
    expect(detail.items.map((entry) => entry.item.id)).toEqual(['item-turn-old', 'item-turn-new'])
    expect(detail.nextTurnsCursor).toBe('older-page')
    expect(detail.activeTurnId).toBeNull()
    expect(detail.foreignActive).toBe(false)
  })

  it('falls back to read-only loading when resume reports the thread is archived', async () => {
    const { result } = await ready()
    vi.mocked(appServer.resumeThread).mockRejectedValueOnce(new Error('session active is archived. Run `codex unarchive active` to unarchive it first.'))
    vi.mocked(appServer.readThread).mockResolvedValue({ thread: thread('active') })
    vi.mocked(appServer.listTurns).mockResolvedValue({ data: [turn('turn-1')], nextCursor: null })
    const publish = vi.spyOn(notifications, 'publish')
    await act(async () => { await result.current.selectThread('active') })
    expect(appServer.readThread).toHaveBeenCalledWith({ threadId: 'active', includeTurns: false })
    expect(result.current.details.active.thread.id).toBe('active')
    expect(result.current.details.active.turns.map((item) => item.id)).toEqual(['turn-1'])
    expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ title: '无法恢复会话' }))
    publish.mockRestore()
  })

  it('reopens the conversation in the active view after unarchiving', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.setViewMode('archived') })
    vi.mocked(appServer.readThread).mockResolvedValue({ thread: thread('archived') })
    vi.mocked(appServer.listTurns).mockResolvedValue({ data: [], nextCursor: null })
    await act(async () => { await result.current.selectThread('archived') })
    vi.mocked(appServer.listThreads).mockImplementation(async (params) => params.archived ? { data: [], nextCursor: null } : page('archived'))
    vi.mocked(appServer.resumeThread).mockResolvedValue(resumeResponse('archived'))
    const publish = vi.spyOn(notifications, 'publish')
    await act(async () => { await result.current.unarchiveThread('archived') })
    expect(appServer.unarchiveThread).toHaveBeenCalledWith('archived')
    expect(result.current.viewMode).toBe('active')
    expect(appServer.resumeThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'archived' }))
    expect(result.current.currentThread?.id).toBe('archived')
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ title: '已恢复会话' }))
    publish.mockRestore()
  })

  it('keeps the restored conversation when a late thread/unarchived event arrives in the active view', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.setViewMode('archived') })
    vi.mocked(appServer.readThread).mockResolvedValue({ thread: thread('archived') })
    vi.mocked(appServer.listTurns).mockResolvedValue({ data: [], nextCursor: null })
    await act(async () => { await result.current.selectThread('archived') })
    vi.mocked(appServer.listThreads).mockImplementation(async (params) => params.archived ? { data: [], nextCursor: null } : page('archived'))
    vi.mocked(appServer.resumeThread).mockResolvedValue(resumeResponse('archived'))
    await act(async () => { await result.current.unarchiveThread('archived') })
    expect(result.current.viewMode).toBe('active')
    expect(result.current.threads.map((item) => item.id)).toEqual(['archived'])
    const listener = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
    await act(async () => {
      listener({ method: 'thread/unarchived', params: { threadId: 'archived' } } as AppServerEvent)
    })
    expect(result.current.threads.map((item) => item.id)).toEqual(['archived'])
    expect(result.current.currentThread?.id).toBe('archived')
  })

  it('preserves the search filter when switching views and refreshing', async () => {
    const { result } = await ready()
    await act(async () => { await result.current.searchThreads('delivery') })
    await act(async () => { await result.current.setViewMode('archived') })
    await act(async () => { await result.current.refresh() })
    expect(appServer.listThreads).toHaveBeenLastCalledWith(expect.objectContaining({ archived: true, searchTerm: 'delivery' }))
  })
})


describe('draft lifecycle and first-turn catalog refresh', () => {
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

  it('keeps the selected workspace after switching away and back before the first submission', async () => {
    const { result } = await draft()
    act(() => { result.current.setThreadDraftContent('draft', true) })
    vi.mocked(runtime.mapThreadWorkspaces).mockResolvedValueOnce({
      '/other': { root: '/other', checkoutRoot: '/other', name: 'other', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 },
    })
    await act(async () => { await result.current.changeThreadWorkspace('draft', '/other') })
    vi.mocked(appServer.resumeThread).mockResolvedValueOnce(resumeResponse('active'))
    await act(async () => { await result.current.selectThread('active') })
    // App Server returns the selected runtime cwd alongside the old creation cwd.
    vi.mocked(appServer.resumeThread).mockResolvedValueOnce({
      ...resumeResponse('draft'), cwd: '/other', runtimeWorkspaceRoots: ['/other'],
    })
    await act(async () => { await result.current.selectThread('draft') })
    expect(appServer.resumeThread).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/other' }))
    expect(result.current.currentThread?.cwd).toBe('/other')
    expect(result.current.details.draft.thread.cwd).toBe('/other')
    expect(runtime.mapThreadWorkspaces).toHaveBeenLastCalledWith(['/other'])

    vi.mocked(appServer.startTurn).mockResolvedValueOnce(accepted)
    await act(async () => { await result.current.sendMessage(input, 'queue') })
    expect(appServer.startThread).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: '/other' }))
    expect(appServer.deleteThread).toHaveBeenCalledWith('draft')
    expect(appServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'replacement', cwd: '/other', runtimeWorkspaceRoots: ['/other'], input,
    }))
  })

  it('keeps display metadata out of start, queue and steer RPC inputs and associates each client id', async () => {
    const save = vi.spyOn(messageReferences, 'saveMessageReferences').mockResolvedValue(undefined)
    try {
      const { result } = await draft()
      const references = [{ kind: 'file' as const, start: 0, end: 4, path: '/repo/a.ts' }]
      const selectedInput = [{ type: 'text' as const, text: 'a.ts', text_elements: [] }]
      vi.mocked(appServer.startTurn).mockResolvedValueOnce(accepted)
      await act(async () => { await result.current.sendMessage(selectedInput, 'queue', references) })
      const start = vi.mocked(appServer.startTurn).mock.calls.at(-1)![0]
      expect(save).toHaveBeenCalledWith(start.clientUserMessageId, selectedInput, references)
      expect(start.input).toEqual(selectedInput)
      expect(start).not.toHaveProperty('references')
      for (const mode of ['queue', 'interject'] as const) {
        await act(async () => { await result.current.sendMessage(selectedInput, mode, references) })
        const rpc = mode === 'queue' ? appServer.addQueue : appServer.steerTurn
        const params = vi.mocked(rpc).mock.calls.at(-1)![0]
        expect(save).toHaveBeenLastCalledWith(params.clientUserMessageId, selectedInput, references)
        expect(params.input).toEqual(selectedInput)
        expect(params).not.toHaveProperty('references')
      }
    } finally { save.mockRestore() }
  })

  it.each([false, true])('closes a known empty draft instead of archiving it (missing rollout: %s)', async (missing) => {
    const { result } = await draft()
    const publish = vi.spyOn(notifications, 'publish')
    if (missing) vi.mocked(appServer.deleteThread).mockRejectedValueOnce(new Error('no rollout found for thread id draft'))
    await act(async () => { await result.current.archiveThread('draft') })
    expect(appServer.deleteThread).toHaveBeenCalledWith('draft')
    expect(appServer.archiveThread).not.toHaveBeenCalled()
    expect(result.current.selectedThreadId).toBeNull()
    expect(result.current.details.draft).toBeUndefined()
    expect(result.current.threads.some((item) => item.id === 'draft')).toBe(false)
    await act(async () => { await result.current.refresh() })
    expect(result.current.threads.some((item) => item.id === 'draft')).toBe(false)
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ title: '已关闭空白会话', silent: true }))
    publish.mockRestore()
  })

  it('preserves a draft with unsent content when archiving or switching conversations', async () => {
    const { result } = await draft()
    const publish = vi.spyOn(notifications, 'publish')
    act(() => { result.current.setThreadDraftContent('draft', true) })
    await act(async () => { await result.current.archiveThread('draft') })
    expect(result.current.selectedThreadId).toBe('draft')
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'warning', threadId: 'draft' }))
    vi.mocked(appServer.resumeThread).mockResolvedValueOnce(resumeResponse('active'))
    await act(async () => { await result.current.selectThread('active') })
    expect(result.current.details.draft).toBeDefined()
    expect(appServer.deleteThread).not.toHaveBeenCalled()
    expect(appServer.archiveThread).not.toHaveBeenCalled()
    publish.mockRestore()
  })

  it('keeps the empty draft available and reports real delete failures', async () => {
    const { result } = await draft()
    const publish = vi.spyOn(notifications, 'publish')
    vi.mocked(appServer.deleteThread).mockRejectedValueOnce(new Error('connection offline'))
    await act(async () => { await result.current.archiveThread('draft') })
    expect(result.current.selectedThreadId).toBe('draft')
    expect(result.current.details.draft).toBeDefined()
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'error', details: expect.stringContaining('connection offline') }))
    // The failed close has not forgotten the local-draft identity.
    await act(async () => { await result.current.archiveThread('draft') })
    expect(appServer.deleteThread).toHaveBeenCalledTimes(2)
    expect(appServer.archiveThread).not.toHaveBeenCalled()
    publish.mockRestore()
  })

  it.each(['no rollout found for thread id draft', 'connection offline'])('handles automatic draft cleanup failure: %s', async (error) => {
    const { result } = await draft()
    const publish = vi.spyOn(notifications, 'publish')
    vi.mocked(appServer.deleteThread).mockRejectedValueOnce(new Error(error))
    vi.mocked(appServer.resumeThread).mockResolvedValueOnce(resumeResponse('active'))
    await act(async () => { await result.current.selectThread('active') })
    expect(appServer.deleteThread).toHaveBeenCalledWith('draft')
    if (error.startsWith('no rollout')) {
      expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ title: '无法清理空白会话' }))
    } else {
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ title: '无法清理空白会话', details: expect.stringContaining(error) }))
    }
    publish.mockRestore()
  })

  it('does not treat an unknown thread with missing rollout as an empty draft', async () => {
    const { result } = await ready()
    const publish = vi.spyOn(notifications, 'publish')
    vi.mocked(appServer.archiveThread).mockRejectedValueOnce(new Error('no rollout found for thread id active'))
    await act(async () => { await result.current.archiveThread('active') })
    expect(appServer.deleteThread).not.toHaveBeenCalled()
    expect(result.current.threads.some((item) => item.id === 'active')).toBe(true)
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ title: '无法归档会话', level: 'error' }))
    publish.mockRestore()
  })

  it('never deletes a draft that has received history from the server', async () => {
    const { result } = await draft()
    vi.mocked(appServer.resumeThread).mockResolvedValueOnce({ ...resumeResponse('draft'), initialTurnsPage: { data: [turn('history')], nextCursor: null } })
    await act(async () => { await result.current.selectThread('draft') })
    expect(result.current.details.draft.turns).toHaveLength(1)
    await act(async () => { await result.current.archiveThread('draft') })
    expect(appServer.archiveThread).toHaveBeenCalledWith('draft')
    expect(appServer.deleteThread).not.toHaveBeenCalled()
  })

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
