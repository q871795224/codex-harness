// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
    projectDocThreadBinding: vi.fn(async () => ({ projectId: 'memory', phase: 'locked' as const })),
    projectDocGet: vi.fn(async () => ({ projectId: 'memory', name: 'Harness 记忆系统', shortName: null, currentSeq: 1, createdAt: 1, updatedAt: 1 })),
    projectDocSetShortName: vi.fn(async () => 'Harness记忆'),
    chooseWorkspace: vi.fn(),
    registerWorkspace: vi.fn(),
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


it.each(['codex-thread', 'claude:session'])('generates a project title through the shared background service for %s', async (targetId) => {
  const { result } = await ready()
  vi.mocked(appServer.startThread).mockResolvedValue(resumeResponse('generator'))
  vi.mocked(appServer.startTurn).mockResolvedValue({ turn: {
    id: 'title-turn', status: 'inProgress', items: [], error: null, startedAt: null, completedAt: null, durationMs: null,
  } })
  let pending!: Promise<string | null>
  await act(async () => { pending = result.current.generateConversationTitle(targetId, '/repo', '设计显式记忆') })
  await waitFor(() => expect(appServer.startTurn).toHaveBeenCalled())
  expect(runtime.projectDocThreadBinding).toHaveBeenCalledWith(targetId)
  expect(appServer.startThread).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true, sandbox: 'read-only' }))
  expect(appServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({
    turnTrigger: 'thread-title', input: [{ type: 'text', text: expect.stringContaining('User: 设计显式记忆'), text_elements: [] }],
  }))
  const listener = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
  await act(async () => { listener({ method: 'turn/completed', params: { threadId: 'generator', turn: {
    id: 'title-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: '{"title":"设计显式记忆","shortName":"记忆系统"}' }],
    error: null, startedAt: 1, completedAt: 2, durationMs: 1,
  } } }) })
  await expect(pending).resolves.toBe('[Harness记忆] 设计显式记忆')
  expect(runtime.projectDocSetShortName).toHaveBeenCalledWith('memory', '记忆系统', true)
})
