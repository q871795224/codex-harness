// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { textInput } from '../../core/domain/codex'
import type { ClaudeAdapterEvent, ClaudeSessionRecord } from '../../core/claude/types'
import { useClaudeHarness } from './useClaudeHarness'

vi.mock('../../core/runtime/bridge', () => ({ runtime: {
  getAppState: vi.fn().mockResolvedValue(null),
  listenClaudeEvents: vi.fn().mockResolvedValue(() => {}),
  listenClaudeTransport: vi.fn().mockResolvedValue(() => {}),
  claudeRuntimeStatus: vi.fn().mockResolvedValue({ available: false }),
  listClaudeSessions: vi.fn(),
  readClaudeHistory: vi.fn().mockResolvedValue({ messages: [] }),
  readClaudeContext: vi.fn().mockResolvedValue(null),
  startClaudeTurn: vi.fn().mockResolvedValue(undefined),
  interruptClaudeTurn: vi.fn().mockResolvedValue(undefined),
} }))
const session: ClaudeSessionRecord = {
  id: 'claude:fixture', providerSessionId: 'provider-session', archived: false,
  title: 'fixture', cwd: '/fixture', createdAt: 1, updatedAt: 1,
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runtime.listClaudeSessions).mockResolvedValue([session])
})
afterEach(cleanup)

it('sends interjected input once after the interrupted terminal event, not its control ACK', async () => {
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  const handleEvent = vi.mocked(runtime.listenClaudeEvents).mock.calls.at(-1)![0]
  const input = [textInput('change direction')]
  act(() => handleEvent({ method: 'turn/started', params: { sessionId: session.id, turnId: 'old' } }))
  await act(async () => { await result.current.sendMessage(session.id, input, 'interject') })
  expect(runtime.interruptClaudeTurn).toHaveBeenCalledExactlyOnceWith(session.id)
  expect(runtime.startClaudeTurn).not.toHaveBeenCalled()
  expect(result.current.queues[session.id]).toHaveLength(1)
  await act(async () => {
    handleEvent({ method: 'turn/interrupted', params: { sessionId: session.id, turnId: 'old' } } as ClaudeAdapterEvent)
  })
  await waitFor(() => expect(runtime.startClaudeTurn).toHaveBeenCalledTimes(1))
  expect(runtime.startClaudeTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id, input }))
  expect(result.current.queues[session.id]).toEqual([])
})

it('manual stop preserves queued input for an explicit restart', async () => {
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  const handleEvent = vi.mocked(runtime.listenClaudeEvents).mock.calls.at(-1)![0]
  act(() => handleEvent({ method: 'turn/started', params: { sessionId: session.id, turnId: 'old' } }))
  await act(async () => { await result.current.sendMessage(session.id, [textInput('later')], 'queue') })
  await act(async () => { await result.current.stopTurn(session.id) })
  await act(async () => {
    handleEvent({ method: 'turn/interrupted', params: { sessionId: session.id, turnId: 'old' } })
  })
  expect(runtime.startClaudeTurn).not.toHaveBeenCalled()
  expect(result.current.queues[session.id]).toHaveLength(1)
  await act(async () => { await result.current.startQueue(session.id) })
  expect(runtime.startClaudeTurn).toHaveBeenCalledTimes(1)
})
