import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppServerEvent, Turn } from '../domain/codex'
import { createProjectDocService } from '../project-docs/service'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import { createProjectOnboarding } from './service'

vi.mock('../runtime/appServerClient', () => ({ appServer: {
  startThread: vi.fn(), startTurn: vi.fn(), interruptTurn: vi.fn(), unsubscribeThread: vi.fn(),
} }))
vi.mock('../runtime/bridge', () => ({ runtime: { listenEvents: vi.fn() } }))

let onEvent: (event: AppServerEvent) => void
const unlisten = vi.fn()
const plan = { status: '项目目标', log: [], decisions: [], openQuestions: [], mutations: [] }
const turn = (status: Turn['status']): Turn => ({ id: 'turn', status, items: [], error: null, startedAt: null, completedAt: null, durationMs: null })
function fixture() {
  const docs = createProjectDocService()
  vi.spyOn(docs, 'get').mockResolvedValue({ projectId: 'p', name: '项目', currentSeq: 4, createdAt: 1, updatedAt: 1 })
  const ports = {
    source: async () => ({ threadId: 'source', title: '来源会话', cwd: '/workspace' }),
    busy: () => false, history: async () => ['用户：需求', 'Agent：结论'], binding: async () => null,
    project: async () => ({ projectId: 'p', currentSeq: 4, content: '已有背景', entries: [], consistent: true, contentHash: 'h' }),
    commit: vi.fn(async () => ({ projectId: 'p', seq: 5 })), finish: vi.fn(async () => 'p'),
  }
  return { docs, ports, service: createProjectOnboarding(ports, docs) }
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(appServer.startThread).mockResolvedValue({ thread: { id: 'temporary', ephemeral: true } } as never)
  vi.mocked(appServer.startTurn).mockResolvedValue({ turn: turn('inProgress') })
  vi.mocked(appServer.interruptTurn).mockResolvedValue(undefined)
  vi.mocked(appServer.unsubscribeThread).mockResolvedValue(undefined)
  vi.mocked(runtime.listenEvents).mockImplementation(async listener => { onEvent = listener; return unlisten })
})
afterEach(() => vi.useRealTimers())

it.each(['create', 'join'] as const)('uses an anonymous thread for %s and saves its live result', async mode => {
  const f = fixture()
  vi.mocked(appServer.startTurn).mockImplementation(async () => {
    onEvent({ method: 'item/completed', params: { threadId: 'temporary', item: { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(plan) } } })
    onEvent({ method: 'turn/completed', params: { threadId: 'temporary', turn: turn('completed') } })
    return { turn: turn('inProgress') }
  })
  await f.service.request('source')
  await f.service.confirm('source', { mode, name: '项目', projectId: mode === 'join' ? 'p' : '' }, { instanceId: 'instance', model: 'test-model', effort: 'low' })
  expect(f.service.snapshot().get('source')?.phase).toBe('done')
  expect(appServer.startThread).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    ephemeral: true, cwd: '/workspace', model: 'test-model', approvalPolicy: 'never', sandbox: 'read-only',
  }))
  expect(f.ports.commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(plan))
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('temporary')
  expect(unlisten).toHaveBeenCalledOnce()
})

it('interrupts anonymous generation when the target changes and ignores late output', async () => {
  vi.useFakeTimers()
  const f = fixture()
  await f.service.request('source')
  const pending = f.service.confirm('source', { mode: 'join', name: '项目', projectId: 'p' }, { instanceId: 'instance', model: 'test-model', effort: 'low' })
  await vi.advanceTimersByTimeAsync(0)
  vi.mocked(f.docs.get).mockResolvedValue({ projectId: 'p', name: '项目', currentSeq: 5, createdAt: 1, updatedAt: 1 })
  await vi.advanceTimersByTimeAsync(1000)
  await pending
  expect(appServer.interruptTurn).toHaveBeenCalledWith('temporary', 'turn')
  expect(appServer.unsubscribeThread).toHaveBeenCalledWith('temporary')
  expect(unlisten).toHaveBeenCalledOnce()
  onEvent({ method: 'turn/completed', params: { threadId: 'temporary', turn: { ...turn('completed'), items: [{ type: 'agentMessage', text: JSON.stringify(plan) }] } } })
  expect(f.ports.commit).not.toHaveBeenCalled()
  expect(f.service.snapshot().get('source')).toMatchObject({ phase: 'error', error: expect.stringContaining('v4 → v5') })
  expect(vi.getTimerCount()).toBe(0)
})

it('uses separate anonymous threads for every history chunk and the final plan', async () => {
  const f = fixture()
  f.ports.history = async () => ['早期历史'.repeat(16_000), '最后结论']
  let count = 0
  vi.mocked(appServer.startThread).mockImplementation(async () => ({ thread: { id: `temporary-${++count}`, ephemeral: true } } as never))
  vi.mocked(appServer.startTurn).mockImplementation(async request => {
    const text = count <= 2 ? `分段摘要${count}` : JSON.stringify(plan)
    onEvent({ method: 'item/completed', params: { threadId: request.threadId, item: { type: 'agentMessage', phase: 'final_answer', text } } })
    onEvent({ method: 'turn/completed', params: { threadId: request.threadId, turn: turn('completed') } })
    return { turn: turn('inProgress') }
  })
  await f.service.request('source')
  await f.service.confirm('source', { mode: 'create', name: '项目', projectId: '' }, { instanceId: 'instance', model: 'test-model', effort: 'low' })
  expect(f.service.snapshot().get('source')?.phase).toBe('done')
  expect(appServer.startThread).toHaveBeenCalledTimes(3)
  for (const [request] of vi.mocked(appServer.startThread).mock.calls) expect(request.ephemeral).toBe(true)
  expect(appServer.unsubscribeThread).toHaveBeenCalledTimes(3)
  expect(f.ports.commit).toHaveBeenCalledOnce()
})
