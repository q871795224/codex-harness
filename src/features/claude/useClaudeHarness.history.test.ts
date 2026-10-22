// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import type { ClaudeAdapterEvent, ClaudeSessionHistory, ClaudeSessionRecord } from '../../core/claude/types'
import { useClaudeHarness } from './useClaudeHarness'

vi.mock('../../core/runtime/bridge', () => ({ runtime: {
  getAppState: vi.fn().mockResolvedValue(null),
  listenClaudeEvents: vi.fn().mockResolvedValue(() => {}),
  listenClaudeTransport: vi.fn().mockResolvedValue(() => {}),
  claudeRuntimeStatus: vi.fn().mockResolvedValue({ available: false }),
  listClaudeSessions: vi.fn(),
  readClaudeHistory: vi.fn(),
  readClaudeContext: vi.fn().mockResolvedValue(null),
  startClaudeTurn: vi.fn(),
} }))

const session: ClaudeSessionRecord = {
  id: 'claude:fixture', providerSessionId: 'provider-session', archived: false,
  title: 'fixture', cwd: '/fixture', createdAt: 1, updatedAt: 1,
}
const history: ClaudeSessionHistory = { messages: [
  { type: 'user', uuid: 'provider-message', sessionId: 'provider-session', parentToolUseId: null, timestamp: null, message: { content: 'fixture prompt' } },
  { type: 'assistant', uuid: 'assistant-message', sessionId: 'provider-session', parentToolUseId: null, timestamp: null, message: { content: 'fixture answer' } },
] }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runtime.listClaudeSessions).mockResolvedValue([session])
  vi.mocked(runtime.readClaudeHistory).mockResolvedValue(history)
})
afterEach(cleanup)

it.each([false, true])('keeps one prompt and answer when revisiting a completed session (completion during load=%s)', async (duringLoad) => {
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  const handleEvent = vi.mocked(runtime.listenClaudeEvents).mock.calls.at(-1)![0]
  const emit = (method: string, params = {}) => handleEvent({ method, params: { sessionId: session.id, turnId: 'live-turn', ...params } } as ClaudeAdapterEvent)
  act(() => {
    emit('turn/started')
    emit('message/user', { itemId: 'live-turn:user', providerMessageId: 'provider-message', content: [{ type: 'text', text: 'fixture prompt' }] })
    emit('message/completed', { itemId: 'live-turn:assistant', text: 'fixture answer' })
    if (!duringLoad) emit('turn/completed')
  })

  let finishHistory!: (value: ClaudeSessionHistory) => void
  vi.mocked(runtime.readClaudeHistory).mockImplementationOnce(() => new Promise((resolve) => { finishHistory = resolve }))
  act(() => result.current.selectSession(session.id))
  await act(async () => {
    if (duringLoad) emit('turn/completed')
    finishHistory(history)
  })

  const detail = result.current.details[session.id]
  expect(detail.turns).toHaveLength(1)
  expect(detail.turns[0]).toMatchObject({ id: 'live-turn', status: 'completed' })
  expect(detail.activeTurnId).toBeNull()
  expect(detail.items.filter((entry) => entry.item.type === 'userMessage')).toHaveLength(1)
  expect(detail.items.filter((entry) => entry.item.type === 'agentMessage')).toHaveLength(1)
  expect(detail.turns[0].items).toHaveLength(2)
  expect(runtime.startClaudeTurn).not.toHaveBeenCalled()
  act(() => result.current.selectSession(session.id))
  expect(runtime.readClaudeHistory).toHaveBeenCalledTimes(1)
})
