// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import type { ClaudeSessionRecord } from '../../core/claude/types'
import { useClaudeHarness } from './useClaudeHarness'

vi.mock('../../core/runtime/bridge', () => ({ runtime: {
  getAppState: vi.fn().mockResolvedValue(null),
  listenClaudeEvents: vi.fn().mockResolvedValue(() => {}),
  listenClaudeTransport: vi.fn().mockResolvedValue(() => {}),
  claudeRuntimeStatus: vi.fn().mockResolvedValue({ available: false }),
  listClaudeSessions: vi.fn(),
} }))
const session = (archived: boolean): ClaudeSessionRecord => ({
  id: archived ? 'claude:archived' : 'claude:active', archived,
  providerSessionId: null, title: 'test', cwd: '/repo', createdAt: 1, updatedAt: 1,
})
function deferred() {
  let resolve!: (value: ClaudeSessionRecord[]) => void
  const promise = new Promise<ClaudeSessionRecord[]>((done) => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runtime.listClaudeSessions).mockImplementation(async (archived = false) => [session(archived)])
})
afterEach(cleanup)

it('does not restore a late Claude archive list after returning', async () => {
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  const pending = deferred()
  vi.mocked(runtime.listClaudeSessions).mockImplementation(async (archived) => archived ? pending.promise : [session(false)])
  let entering!: Promise<ClaudeSessionRecord[]>
  act(() => { entering = result.current.refresh(true) })
  expect(result.current.threads).toEqual([])
  await act(async () => { await result.current.refresh(false) })
  await act(async () => { pending.resolve([session(true)]); await entering })
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['claude:active'])
})

it('does not let Claude startup overwrite an archive view selected while loading', async () => {
  const pending = deferred()
  vi.mocked(runtime.listClaudeSessions).mockImplementation(async (archived) => archived ? [session(true)] : pending.promise)
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(runtime.listClaudeSessions).toHaveBeenCalledWith(false))
  await act(async () => { await result.current.refresh(true) })
  await act(async () => { pending.resolve([session(false)]) })
  expect(result.current.threads.map((thread) => thread.id)).toEqual(['claude:archived'])
  await act(async () => { await result.current.refresh() })
  expect(runtime.listClaudeSessions).toHaveBeenLastCalledWith(true)
})

it('clears the previous Claude view even when loading the next view fails', async () => {
  const { result } = renderHook(() => useClaudeHarness())
  await waitFor(() => expect(result.current.loaded).toBe(true))
  vi.mocked(runtime.listClaudeSessions).mockRejectedValueOnce(new Error('offline'))
  await act(async () => { await expect(result.current.refresh(true)).rejects.toThrow('offline') })
  expect(result.current.threads).toEqual([])
})
