// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import type { ClaudeProviderSnapshot, ClaudeSessionRecord } from '../../core/claude/types'
import { useClaudeHarness } from './useClaudeHarness'

vi.mock('../../core/runtime/bridge', () => ({ runtime: {
  getAppState: vi.fn().mockResolvedValue(null),
  listenClaudeEvents: vi.fn().mockResolvedValue(() => {}),
  listenClaudeTransport: vi.fn().mockResolvedValue(() => {}),
  claudeRuntimeStatus: vi.fn().mockResolvedValue({ available: true }),
  claudeRequest: vi.fn(),
  listClaudeModels: vi.fn().mockResolvedValue({ models: [] }),
  listClaudeSessions: vi.fn(),
  stopClaudeSession: vi.fn().mockResolvedValue(undefined),
} }))

const session: ClaudeSessionRecord = {
  id: 'claude:fixture', providerSessionId: null, archived: false,
  title: 'fixture', cwd: '/fixture', createdAt: 1, updatedAt: 1,
}
const snapshot = (backgroundTaskCount = 0): ClaudeProviderSnapshot => ({
  daemonPid: 1, daemonInstanceId: 'daemon', latestEventSeq: 10, snapshotSeq: 10,
  activeTurns: [], pendingApprovals: [],
  sessionActivities: [{ sessionId: session.id, state: 'idle', backgroundTaskCount }],
})
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runtime.listClaudeSessions).mockResolvedValue([session])
  vi.mocked(runtime.claudeRequest).mockResolvedValue(snapshot(1))
})
afterEach(cleanup)

it('restores background-only activity on mount without reopening a completed turn', async () => {
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  expect(result.current.activeTurnIds).toEqual({})
  expect(result.current.threads[0].status.type).toBe('active')
  await act(async () => { await result.current.stopTurn(session.id) })
  expect(runtime.stopClaudeSession).toHaveBeenCalledExactlyOnceWith(session.id)
  expect(result.current.threads[0].status.type).toBe('active')
  const event = vi.mocked(runtime.listenClaudeEvents).mock.calls.at(-1)![0]
  act(() => event({ method: 'session/activity', seq: 11, params: { sessionId: session.id, state: 'idle', backgroundTaskCount: 0 } }))
  expect(result.current.threads[0].status.type).toBe('idle')
})

it.each([0, 2])('preserves a live activity update newer than the in-flight snapshot (tasks=%s)', async count => {
  let resolve!: (value: ClaudeProviderSnapshot) => void
  vi.mocked(runtime.claudeRequest).mockReturnValueOnce(new Promise(done => { resolve = done }))
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(runtime.claudeRequest).toHaveBeenCalled())
  const event = vi.mocked(runtime.listenClaudeEvents).mock.calls.at(-1)![0]
  act(() => event({ method: 'session/activity', seq: 12, params: { sessionId: session.id, state: 'idle', backgroundTaskCount: count } }))
  await act(async () => { resolve(snapshot(1)) })
  expect(result.current.sessionActivities[session.id].backgroundTaskCount).toBe(count)
  expect(result.current.threads[0].status.type).toBe(count ? 'active' : 'idle')
})

it('ignores historical activity replay and delayed events older than the snapshot', async () => {
  const empty = snapshot()
  empty.sessionActivities = []
  vi.mocked(runtime.claudeRequest).mockResolvedValue(empty)
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  const event = vi.mocked(runtime.listenClaudeEvents).mock.calls.at(-1)![0]
  act(() => {
    event({ method: 'session/activity', seq: 8, params: { sessionId: session.id, state: 'running', backgroundTaskCount: 1 } })
    event({ method: 'session/activity', seq: 11, replayed: true, params: { sessionId: session.id, state: 'running', backgroundTaskCount: 1 } })
  })
  expect(result.current.threads[0].status.type).toBe('idle')
})

it('clears activity on disconnect and restores it from the reconnected daemon', async () => {
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  const transport = vi.mocked(runtime.listenClaudeTransport).mock.calls.at(-1)![0]
  act(() => transport({ kind: 'disconnected' }))
  expect(result.current.threads[0].status.type).toBe('idle')
  await waitFor(() => expect(result.current.threads[0].status.type).toBe('active'))
})
