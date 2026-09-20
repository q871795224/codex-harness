// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { appServer } from '../../core/runtime/appServerClient'
import { useHarness } from './useHarness'
import { NAVIGATION_PREFERENCES_KEY } from './harnessBootstrap'

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ listen: vi.fn().mockResolvedValue(() => {}) }),
}))

vi.mock('../../core/runtime/bridge', () => ({
  diagnosticErrorCode: vi.fn(), recordWorkspaceContextDiagnostic: vi.fn(),
  runtime: {
    recordClientDiagnostic: vi.fn().mockResolvedValue(undefined),
    chooseWorkspace: vi.fn(),
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
  vi.mocked(runtime.getAppState).mockResolvedValue(null)
  vi.mocked(runtime.mapThreadWorkspaces).mockResolvedValue({})
  vi.mocked(appServer.listThreads).mockImplementation(async (params) => page(params.archived ? 'archived' : 'active'))
  vi.mocked(appServer.resumeThread).mockImplementation(async (params) => resumeResponse(String(params.threadId)))
})
afterEach(cleanup)


const workspace = { root: '/repo', checkoutRoot: '/repo', name: 'repo', branch: null, sha: null, createdAt: 1, lastOpenedAt: 1 }

describe('workspace settings', () => {
  it('keeps a removed workspace hidden after rediscovery and restart, and restores it on explicit add', async () => {
    vi.mocked(runtime.listWorkspaces).mockResolvedValue([workspace])
    vi.mocked(runtime.mapThreadWorkspaces).mockResolvedValue({ '/repo': workspace })
    const first = await ready()
    await act(async () => { first.result.current.removeWorkspace('/repo') })
    expect(first.result.current.workspaces).toEqual([])
    expect(first.result.current.selectedWorkspaceRoot).toBeNull()
    expect(first.result.current.threads.map((thread) => thread.id)).toContain('active')
    const saved = vi.mocked(runtime.setAppState).mock.calls.filter(([key]) => key === NAVIGATION_PREFERENCES_KEY).at(-1)![1]
    expect(JSON.parse(saved).hiddenWorkspaceRoots).toEqual(['/repo'])
    await act(async () => { await first.result.current.refresh() })
    expect(first.result.current.workspaces).toEqual([])
    first.unmount()

    vi.mocked(runtime.getAppState).mockImplementation(async (key) => key === NAVIGATION_PREFERENCES_KEY ? saved : null)
    const second = await ready()
    expect(second.result.current.workspaces).toEqual([])
    expect(second.result.current.selectedWorkspaceRoot).toBeNull()
    vi.mocked(runtime.chooseWorkspace).mockResolvedValue(workspace)
    await act(async () => { await second.result.current.chooseWorkspace() })
    expect(second.result.current.workspaces.map((workspace) => workspace.root)).toEqual(['/repo'])
    expect(second.result.current.navigation.hiddenWorkspaceRoots).toEqual([])
    expect(second.result.current.selectedWorkspaceRoot).toBe('/repo')
    await act(async () => { await second.result.current.chooseWorkspace() })
    expect(second.result.current.workspaces).toHaveLength(1)
  })

  it('moves the next conversation to a remaining workspace and clears stale pins', async () => {
    const other = { ...workspace, root: '/other', checkoutRoot: '/other', name: 'other' }
    vi.mocked(runtime.listWorkspaces).mockResolvedValue([workspace, other])
    vi.mocked(runtime.chooseWorkspace).mockResolvedValue(workspace)
    const { result } = await ready()
    await act(async () => { await result.current.chooseWorkspace() })
    act(() => { result.current.toggleWorkspacePinned('/repo') })
    act(() => { result.current.removeWorkspace('/repo') })
    expect(result.current.selectedWorkspaceRoot).toBe('/other')
    expect(result.current.nextThreadCwd).toBe('/other')
    expect(result.current.navigation.pinnedWorkspaceRoots).toEqual([])
    act(() => { result.current.removeWorkspace('/other') })
    expect(result.current.workspaces).toEqual([])
    expect(result.current.nextThreadCwd).toBeNull()
  })

  it('does not change the list when the directory picker is cancelled', async () => {
    vi.mocked(runtime.listWorkspaces).mockResolvedValue([workspace])
    vi.mocked(runtime.chooseWorkspace).mockResolvedValue(null)
    const { result } = await ready()
    await act(async () => { await result.current.chooseWorkspace() })
    expect(result.current.workspaces).toEqual([workspace])
  })
})
