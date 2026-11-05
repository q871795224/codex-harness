// @vitest-environment jsdom
import { appServer } from '../../core/runtime/appServerClient'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNotificationStore, attentionGroups } from '../../core/notifications/store'
import { notifications } from '../../core/notifications/service'
import { runtime } from '../../core/runtime/bridge'
import type { TurnCompletedEvent } from '../../core/conversations/types'
import type { AsyncWaitTask } from '../../core/async-waits/types'
import { useReminderSources } from './useReminderSources'
import { emptyThreadDetail } from '../../core/domain/codex'
vi.mock('../../core/runtime/appServerClient', () => ({ appServer: { listTurns: vi.fn() } }))
vi.mock('../../core/runtime/bridge', () => ({ runtime: { listAsyncWaits: vi.fn(), listenAsyncWaits: vi.fn(), getAppState: vi.fn(), setAppState: vi.fn() } }))
let onTurn: (event: TurnCompletedEvent) => void
let onWaits: () => void
const save = vi.fn(async (_value: string) => undefined)
const thread = { id: 'a', name: '任务 A', cwd: '/repo', preview: '', createdAt: 1, updatedAt: 1, recencyAt: 1, ephemeral: false, status: { type: 'idle' as const }, canAcceptDirectInput: true }
const base: Parameters<typeof useReminderSources>[0] = {
  threads: [thread], waitingThreadIds: {}, approvals: {}, activeTurnIds: {}, details: {},
  onTurnCompleted: (listener) => { onTurn = listener; return () => {} },
}
const task = (patch: Partial<AsyncWaitTask> = {}): AsyncWaitTask => ({ id: 'wait', threadId: 'a', title: '等待证书', continuation: 'PRIVATE CONTINUATION', cwd: '/repo', status: 'waiting', revision: 1, createdAt: 1, updatedAt: 1, deadline: 100, nextCheckAt: 5, lastCheckedAt: null, failures: 0, summary: 'PRIVATE OBSERVATION', lastObservation: null, deliveryFailures: 0, nextDeliveryAt: 5, turnId: null, deliveryId: null, ...patch })
beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(notifications, createNotificationStore({ load: async () => null, save }))
  await notifications.initialize()
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [], nextCursor: null })
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [], schedulerError: null })
  vi.mocked(runtime.listenAsyncWaits).mockImplementation(async (listener) => { onWaits = listener; return () => {} })
})
afterEach(cleanup)
it('publishes metadata-only pending actions and resolves only after the source stops waiting', async () => {
  const props = { ...base, waitingThreadIds: { a: true }, activeTurnIds: { a: 'turn-1' }, approvals: { a: [{ id: 'request', threadId: 'a', method: 'item/tool/requestUserInput', params: { questions: 'PRIVATE MODEL QUESTION' } }] } }
  const hook = renderHook((input) => useReminderSources(input), { initialProps: props as typeof base })
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(1)
  act(() => notifications.markRead('attention:a'))
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(1)
  hook.rerender(base)
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(0)
  await notifications.flushed()
  expect(save.mock.calls.map(([value]) => value).join('\n')).not.toContain('PRIVATE MODEL QUESTION')
})
it('does not resolve a persisted request just because its session is unloaded or another turn completed', async () => {
  notifications.publish({ id: 'attention:a', source: '会话', title: '待回答', level: 'warning', state: 'pending', eventKey: 'turn-new:request', threadId: 'a' })
  renderHook(() => useReminderSources(base))
  act(() => onTurn({ threadId: 'a', turnId: 'turn-old', title: '任务', status: 'completed' }))
  expect(notifications.snapshot().records.find((record) => record.id === 'attention:a')?.resolved).not.toBe(true)
})
it('only reports successful turn results for subscribed sessions and deduplicates replay', async () => {
  renderHook(() => useReminderSources(base))
  act(() => onTurn({ threadId: 'a', turnId: 'first', title: '任务 A', status: 'completed' }))
  expect(notifications.snapshot().records).toHaveLength(0)
  act(() => notifications.watchThread({ id: 'a', title: '任务 A' }, true))
  act(() => onTurn({ threadId: 'a', turnId: 'second', title: '任务 A', status: 'completed' }))
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(1)
  act(() => notifications.markRead('watch:a'))
  act(() => onTurn({ threadId: 'a', turnId: 'second', title: '任务 A', status: 'completed' }))
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(0)
})
it('surfaces asynchronous wait exceptions without copying checker bodies and resolves them on recovery', async () => {
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task({ status: 'paused' })], schedulerError: null })
  renderHook(() => useReminderSources(base))
  await waitFor(() => expect(notifications.snapshot().records.some((record) => record.id === 'async-wait:wait')).toBe(true))
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(1)
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task({ status: 'waiting', revision: 2 })], schedulerError: null })
  await act(async () => onWaits())
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(0)
  await notifications.flushed()
  expect(save.mock.calls.map(([value]) => value).join('\n')).not.toContain('PRIVATE OBSERVATION')
  expect(save.mock.calls.map(([value]) => value).join('\n')).not.toContain('PRIVATE CONTINUATION')
})
it('waits for the resumed agent result and handles completion arriving before the delivered snapshot', async () => {
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task({ status: 'ready' })], schedulerError: null })
  renderHook(() => useReminderSources(base))
  await act(async () => {})
  expect(notifications.snapshot().records).toHaveLength(0)
  act(() => onTurn({ threadId: 'a', turnId: 'resume', title: '任务 A', status: 'completed' }))
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task({ status: 'delivered', turnId: 'resume', revision: 2 })], schedulerError: null })
  await act(async () => onWaits())
  expect(notifications.snapshot().records.find((record) => record.id === 'async-result:wait')).toMatchObject({ attention: 'result', eventKey: 'resume' })
})
it('keeps an intentional manual pause quiet', async () => {
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task({ status: 'paused', summary: '用户已暂停' })], schedulerError: null })
  renderHook(() => useReminderSources(base))
  await act(async () => {})
  expect(notifications.snapshot().records).toHaveLength(0)
})
it('recovers an offline Codex result for a persisted watch without replaying results older than the subscription', async () => {
  notifications.watchThread({ id: 'a', title: '任务 A' }, true)
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [{ id: 'offline', status: 'completed', items: [], startedAt: Date.now() / 1000, completedAt: Date.now() / 1000 + 2, error: null, durationMs: 1 }], nextCursor: null })
  renderHook(() => useReminderSources(base))
  await waitFor(() => expect(notifications.snapshot().records.find((record) => record.id === 'watch:a')?.eventKey).toBe('offline'))
  expect(appServer.listTurns).toHaveBeenCalledWith({ threadId: 'a', limit: 1, sortDirection: 'desc', itemsView: 'summary' })
})
it('does not surface historical results from before the watch began', async () => {
  notifications.watchThread({ id: 'a', title: '任务 A' }, true)
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [{ id: 'old', status: 'completed', items: [], startedAt: 1, completedAt: 2, error: null, durationMs: 1 }], nextCursor: null })
  renderHook(() => useReminderSources(base))
  await act(async () => {})
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(0)
})
it('recovers a delivered wait result after reopening without requiring a watch subscription', async () => {
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task({ status: 'delivered', turnId: 'resume' })], schedulerError: null })
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [{ id: 'resume', status: 'completed', items: [], startedAt: 1, completedAt: 2, error: null, durationMs: 1 }], nextCursor: null })
  renderHook(() => useReminderSources(base))
  await waitFor(() => expect(notifications.snapshot().records.find((record) => record.id === 'async-result:wait')?.eventKey).toBe('resume'))
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(1)
})
it('keeps a newer live failure when an older startup result arrives late', async () => {
  notifications.watchThread({ id: 'a', title: '任务 A' }, true)
  let complete!: (page: Awaited<ReturnType<typeof appServer.listTurns>>) => void
  vi.mocked(appServer.listTurns).mockReturnValue(new Promise((resolve) => { complete = resolve }))
  renderHook(() => useReminderSources(base))
  act(() => onTurn({ threadId: 'a', turnId: 'new', title: '任务 A', status: 'failed' }))
  await act(async () => complete({ data: [{ id: 'old', status: 'completed', items: [], startedAt: 1, completedAt: Date.now() / 1000 + 2, error: null, durationMs: 1 }], nextCursor: null }))
  expect(notifications.snapshot().records.find((record) => record.id === 'failure:a')?.resolved).not.toBe(true)
  expect(notifications.snapshot().records.find((record) => record.id === 'watch:a')?.eventKey).not.toBe('old')
})
it('surfaces a second asynchronous question in the same turn after the first was answered', async () => {
  const detail = (id: string) => ({ ...emptyThreadDetail(thread), activeTurnId: 'turn', items: [{ turnId: 'turn', item: { id, type: 'agentMessage', delivery: 'async' as const, questions: [{ title: 'PRIVATE QUESTION', options: [] }] } }] })
  const props = { ...base, activeTurnIds: { a: 'turn' }, waitingThreadIds: { a: true }, details: { a: detail('q1') } }
  const hook = renderHook((input) => useReminderSources(input), { initialProps: props as typeof base })
  hook.rerender({ ...props, waitingThreadIds: {} })
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(0)
  hook.rerender({ ...props, details: { a: detail('q2') } })
  expect(attentionGroups(notifications.snapshot().records)).toHaveLength(1)
  expect(notifications.snapshot().records.find((record) => record.id === 'attention:a')?.eventKey).toContain('q2')
  await notifications.flushed()
  expect(save.mock.calls.map(([value]) => value).join('\n')).not.toContain('PRIVATE QUESTION')
})
