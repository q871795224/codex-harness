// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import type { SuperbotRequest, SuperbotSnapshot } from '../../core/superbot/types'
import { useSuperbotHarness } from './useSuperbotHarness'

vi.mock('../../core/runtime/bridge', () => ({ runtime: { superbotRequest: vi.fn() } }))
const session = { id: 'a', title: 'remote', status: 'active', read_only: false, run_config: {}, runtime_id: 'cloud', created_at: '2026-11-17T08:00:00Z', updated_at: '2026-11-17T09:00:00Z' }
const message = (id: string) => ({ id, role: 'user', content: 'repeat', created_at: `2026-11-17T0${id === 'old' ? 7 : 8}:00:00Z` })
const snapshot = (messages = [message('new')]): SuperbotSnapshot => ({ session, page: { messages, has_more: true, next_cursor: { id: 'cursor', created_at: 'at' } }, pending: {}, events: [] })
const call = vi.mocked(runtime.superbotRequest)
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
beforeEach(() => {
  call.mockReset()
  call.mockImplementation(async (r: SuperbotRequest) => r.type === 'list' ? [session] : snapshot())
})
afterEach(cleanup)

describe('Superbot session lifecycle', () => {
  it('refreshes archive views and drops a late response from the old view', async () => {
    const old = deferred<unknown>()
    call.mockImplementation(r => r.type === 'list' ? r.archived ? Promise.resolve([{ ...session, id: 'archived', status: 'archived' }]) : old.promise : Promise.resolve(snapshot()))
    const { result, rerender } = renderHook(({ archived }) => useSuperbotHarness(archived), { initialProps: { archived: false } })
    rerender({ archived: true })
    await waitFor(() => expect(result.current.sessions[0]?.id).toBe('archived'))
    await act(async () => old.resolve([session]))
    expect(result.current.sessions[0].id).toBe('archived')
  })
  it('keeps a newly created session when an older list response arrives late', async () => {
    const old = deferred<unknown>()
    call.mockImplementation(request => request.type === 'list' ? old.promise : Promise.resolve(session))
    const { result } = renderHook(() => useSuperbotHarness(false))
    await act(async () => { await result.current.create() })
    await act(async () => old.resolve([]))
    expect(result.current.threads.map(t => t.id)).toEqual(['superbot:a'])
  })
  it('retains older messages and pagination position while refreshing the newest page', async () => {
    const { result } = renderHook(() => useSuperbotHarness(false))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => { await result.current.read('superbot:a') })
    call.mockResolvedValueOnce({ ...snapshot([message('old')]), page: { messages: [message('old')], has_more: false, next_cursor: null } })
    await act(async () => { await result.current.read('superbot:a', { id: 'cursor', created_at: 'at' }) })
    await act(async () => { await result.current.read('superbot:a') })
    expect(result.current.snapshots['superbot:a'].page).toMatchObject({ has_more: false, next_cursor: null })
    expect(result.current.snapshots['superbot:a'].page.messages.map(m => m.id)).toEqual(['old', 'new'])
  })
  it('does not reject an accepted message when the follow-up refresh fails', async () => {
    const { result } = renderHook(() => useSuperbotHarness(false))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => { await result.current.read('superbot:a') })
    call.mockImplementation(async r => {
      if (r.type === 'send') return { task_id: 'task' }
      throw new Error('refresh failed')
    })
    await act(async () => { await expect(result.current.send('superbot:a', 'hello', { model: 'opus', thinking_level: 'high' })).resolves.toBeUndefined() })
    expect(call.mock.calls.filter(([r]) => r.type === 'send')).toHaveLength(1)
    expect(call).toHaveBeenCalledWith({ type: 'send', id: 'a', content: 'hello', run_config: { model: 'opus', thinking_level: 'high' } })
    expect(result.current.activeTurnIds['superbot:a']).toBe('task')
  })
  it('does not clear an accepted active turn with a response started before the send', async () => {
    const { result } = renderHook(() => useSuperbotHarness(false))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    await act(async () => { await result.current.read('superbot:a') })
    const stale = deferred<SuperbotSnapshot>(); const latest = deferred<SuperbotSnapshot>()
    let reads = 0
    call.mockImplementation(async r => r.type === 'send' ? { task_id: 'task' } : ++reads === 1 ? stale.promise : latest.promise)
    let reading!: Promise<SuperbotSnapshot>
    act(() => { reading = result.current.read('superbot:a') })
    await act(async () => { await result.current.send('superbot:a', 'hello', {}) })
    await act(async () => { stale.resolve(snapshot()); await reading })
    expect(result.current.activeTurnIds['superbot:a']).toBe('task')
    await act(async () => latest.resolve({ ...snapshot(), pending: { task_id: 'task' } }))
  })
})
