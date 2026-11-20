// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Thread, Turn } from '../../core/domain/codex'
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
    renameThread: vi.fn().mockResolvedValue(undefined),
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

const reference = 'seatalk://conversation?v=1&owner_id=11&target_type=group&target_id=123&message_id=0000000000000001'
const mainTurn = (status: Turn['status'] = 'completed'): Turn => ({
  id: 'main-turn', status, error: null, startedAt: 1, completedAt: 2, durationMs: 1,
  items: [
    { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '我先读取消息上下文。' },
    { id: 'command', type: 'commandExecution', aggregatedOutput: 'unrelated raw tool output' },
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'CMDB service 已删除，导致 DNS 删除工单校验失败。' },
  ],
})

async function untitledConversation() {
  vi.mocked(appServer.listThreads).mockImplementation(async () => ({ data: [{ ...thread('active'), name: null }], nextCursor: null }))
  vi.mocked(appServer.resumeThread).mockResolvedValue({ ...resumeResponse('active'), thread: { ...thread('active'), name: null } })
  vi.mocked(appServer.startThread).mockResolvedValue(resumeResponse('generator'))
  vi.mocked(appServer.startTurn).mockResolvedValue({ turn: { ...mainTurn('inProgress'), items: [] } })
  const hook = await ready()
  await act(async () => { await hook.result.current.selectThread('active') })
  const emit = vi.mocked(runtime.listenEvents).mock.calls.at(-1)![0]
  return { ...hook, emit }
}

it('waits for resolved SeaTalk content and titles the specific problem once', async () => {
  const { result, emit } = await untitledConversation()
  await act(async () => { await result.current.sendMessage([{ type: 'text', text: `${reference}\n帮忙看一下是什么问题`, text_elements: [] }], 'interject') })
  expect(appServer.startThread).not.toHaveBeenCalled()
  await act(async () => { emit({ method: 'turn/completed', params: { threadId: 'active', turn: { ...mainTurn(), id: 'unrelated-turn' } } }) })
  expect(appServer.startThread).not.toHaveBeenCalled()
  await act(async () => { emit({ method: 'turn/completed', params: { threadId: 'active', turn: mainTurn() } }) })
  await waitFor(() => expect(appServer.startThread).toHaveBeenCalledTimes(1))
  const request = vi.mocked(appServer.startTurn).mock.calls.find(([params]) => params.turnTrigger === 'thread-title')?.[0]
  expect(JSON.stringify(request?.input)).toContain('CMDB service 已删除')
  expect(JSON.stringify(request?.input)).toContain('帮忙看一下是什么问题')
  expect(JSON.stringify(request?.input)).not.toContain('我先读取消息上下文')
  expect(JSON.stringify(request?.input)).not.toContain('unrelated raw tool output')
  await act(async () => { emit({ method: 'turn/completed', params: { threadId: 'active', turn: mainTurn() } }) })
  expect(appServer.startThread).toHaveBeenCalledTimes(1)
})

it('handles the main answer arriving before send acceptance returns', async () => {
  const { result, emit } = await untitledConversation()
  vi.mocked(appServer.startTurn).mockImplementationOnce(async () => {
    emit({ method: 'turn/completed', params: { threadId: 'active', turn: mainTurn() } })
    return { turn: { ...mainTurn('inProgress'), items: [] } }
  })
  await act(async () => { await result.current.sendMessage([{ type: 'text', text: reference, text_elements: [] }], 'interject') })
  await waitFor(() => expect(appServer.startThread).toHaveBeenCalledTimes(1))
  const request = vi.mocked(appServer.startTurn).mock.calls.find(([params]) => params.turnTrigger === 'thread-title')?.[0]
  expect(JSON.stringify(request?.input)).toContain('CMDB service 已删除')
})

it('keeps ordinary task naming immediate', async () => {
  const { result } = await untitledConversation()
  await act(async () => { await result.current.sendMessage([{ type: 'text', text: '修复 DNS 工单校验', text_elements: [] }], 'interject') })
  await waitFor(() => expect(appServer.startThread).toHaveBeenCalledTimes(1))
})

it('uses streamed answer items when turn completion omits the items', async () => {
  const { result, emit } = await untitledConversation()
  await act(async () => { await result.current.sendMessage([{ type: 'text', text: reference, text_elements: [] }], 'interject') })
  await act(async () => { emit({ method: 'item/completed', params: { threadId: 'active', turnId: 'main-turn', item: mainTurn().items[2] } }) })
  expect(appServer.startThread).not.toHaveBeenCalled()
  await act(async () => { emit({ method: 'turn/completed', params: { threadId: 'active', turn: { ...mainTurn(), items: [] } } }) })
  await waitFor(() => expect(appServer.startThread).toHaveBeenCalledTimes(1))
  const request = vi.mocked(appServer.startTurn).mock.calls.find(([params]) => params.turnTrigger === 'thread-title')?.[0]
  expect(JSON.stringify(request?.input)).toContain('CMDB service 已删除')
})

it.each(['interrupted', 'failed'] as const)('does not title an unresolved %s reference read', async status => {
  const { result, emit } = await untitledConversation()
  await act(async () => { await result.current.sendMessage([{ type: 'text', text: reference, text_elements: [] }], 'interject') })
  await act(async () => { emit({ method: 'turn/completed', params: { threadId: 'active', turn: mainTurn(status) } }) })
  expect(appServer.startThread).not.toHaveBeenCalled()
})

it('preserves a manual name set while the referenced conversation is being read', async () => {
  const { result, emit } = await untitledConversation()
  await act(async () => { await result.current.sendMessage([{ type: 'text', text: reference, text_elements: [] }], 'interject') })
  await act(async () => { emit({ method: 'thread/name/updated', params: { threadId: 'active', threadName: '用户手工标题' } }) })
  await act(async () => { emit({ method: 'turn/completed', params: { threadId: 'active', turn: mainTurn() } }) })
  expect(appServer.startThread).not.toHaveBeenCalled()
  expect(result.current.threads.find(candidate => candidate.id === 'active')?.name).toBe('用户手工标题')
})



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
