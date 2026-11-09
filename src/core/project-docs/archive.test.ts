import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppServerEvent, Turn } from '../domain/codex'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import { createProjectDocService } from './service'

vi.mock('../runtime/appServerClient', () => ({ appServer: {
  startThread: vi.fn(), startTurn: vi.fn(), interruptTurn: vi.fn(), unsubscribeThread: vi.fn(),
} }))
vi.mock('../runtime/bridge', () => ({ runtime: { listenEvents: vi.fn() } }))

let handle: (event: AppServerEvent) => void
const unlisten = vi.fn()
const input = { workspaceRoot: '/repo', prompt: '整理给定的对话', model: 'test-model', effort: 'low' }
const turn = (status: Turn['status'], items: Turn['items'] = []): Turn => ({ id: 'turn', status, items } as Turn)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(appServer.startThread).mockResolvedValue({ thread: { id: 'temporary' } } as never)
  vi.mocked(runtime.listenEvents).mockImplementation(async (listener) => { handle = listener; return unlisten })
  vi.mocked(appServer.unsubscribeThread).mockResolvedValue(undefined)
  vi.mocked(appServer.interruptTurn).mockResolvedValue(undefined)
})
afterEach(() => vi.useRealTimers())

it('uses an ephemeral thread and returns only its final draft from live events', async () => {
  vi.mocked(appServer.startTurn).mockImplementation(async () => {
    handle({ method: 'item/completed', params: { threadId: 'temporary', item: { type: 'agentMessage', text: '归档草稿', phase: 'final_answer' } } })
    handle({ method: 'item/completed', params: { threadId: 'temporary', item: { type: 'agentMessage', text: '旁白', phase: 'commentary' } } })
    handle({ method: 'item/completed', params: { threadId: 'other', item: { type: 'agentMessage', text: '其他会话' } } })
    handle({ method: 'turn/completed', params: { threadId: 'temporary', turn: turn('completed') } })
    return { turn: turn('inProgress') }
  })
  expect(await createProjectDocService().generateArchive(input)).toBe('归档草稿')
  expect(appServer.startThread).toHaveBeenCalledWith(expect.objectContaining({
    ephemeral: true, model: 'test-model', sandbox: 'read-only',
    config: expect.objectContaining({ 'features.memories': false, project_doc_max_bytes: 0 }),
  }))
  expect(appServer.startTurn).toHaveBeenCalledWith(expect.objectContaining({ effort: 'low', input: [expect.objectContaining({ text: input.prompt })] }))
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('temporary')
  expect(unlisten).toHaveBeenCalledOnce()
  expect(appServer.interruptTurn).not.toHaveBeenCalled()
})

it('accepts an already completed start response', async () => {
  vi.mocked(appServer.startTurn).mockResolvedValue({ turn: turn('completed', [{ type: 'agentMessage', text: '快速完成' }]) })
  expect(await createProjectDocService().generateArchive(input)).toBe('快速完成')
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('temporary')
})

it.each(['failed', 'interrupted'] as const)('reports %s turns and releases the temporary thread', async (status) => {
  vi.mocked(appServer.startTurn).mockResolvedValue({ turn: turn(status) })
  await expect(createProjectDocService().generateArchive(input)).rejects.toThrow('项目归档未完成')
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('temporary')
  expect(unlisten).toHaveBeenCalledOnce()
})

it('interrupts timed-out generation and releases its listener and temporary thread', async () => {
  vi.useFakeTimers()
  vi.mocked(appServer.startTurn).mockResolvedValue({ turn: turn('inProgress') })
  const result = expect(createProjectDocService().generateArchive(input)).rejects.toThrow('超时')
  await vi.advanceTimersByTimeAsync(300001)
  await result
  expect(appServer.interruptTurn).toHaveBeenCalledWith('temporary', 'turn')
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('temporary')
  expect(unlisten).toHaveBeenCalledOnce()
})

it('releases the temporary thread when starting the turn fails', async () => {
  vi.mocked(appServer.startTurn).mockRejectedValue(new Error('启动失败'))
  await expect(createProjectDocService().generateArchive(input)).rejects.toThrow('启动失败')
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('temporary')
  expect(unlisten).toHaveBeenCalledOnce()
})
