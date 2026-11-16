// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDelayedSend, type DelayedMessage } from './useDelayedSend'

const message = (): DelayedMessage => ({
  input: [{ type: 'text', text: '稍后检查', text_elements: [] }, { type: 'localImage', path: '/tmp/test.png' }],
  mode: 'queue', references: [], titleSource: '稍后检查',
  draft: { text: '稍后检查', attachments: [{ kind: 'image', path: '/tmp/test.png', name: 'test.png' }], collapsedPastes: [] },
})
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T10:00:00Z')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

it.each([1, 5, 10] as const)('sends exactly once after %s minutes with the original content and destination', async minutes => {
  const send = vi.fn().mockResolvedValue(undefined)
  const { result, rerender } = renderHook(({ selected }) => ({ selected, ...useDelayedSend(send, vi.fn()) }), { initialProps: { selected: 'source' } })
  const payload = message()
  const expected = structuredClone(payload)
  act(() => result.current.schedule('source', minutes, payload))
  payload.input[0] = { type: 'text', text: '后来的内容', text_elements: [] }
  rerender({ selected: 'another' })
  await act(async () => { await vi.advanceTimersByTimeAsync(minutes * 60_000 - 1) })
  expect(send).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(send).toHaveBeenCalledExactlyOnceWith('source', expected)
  expect(result.current.pending).toEqual({})
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000) })
  expect(send).toHaveBeenCalledTimes(1)
})

it('cancels one conversation without affecting another and accepts a new timer after cancellation', async () => {
  const send = vi.fn().mockResolvedValue(undefined)
  const { result } = renderHook(() => useDelayedSend(send, vi.fn()))
  act(() => {
    result.current.schedule('one', 1, message())
    result.current.schedule('two', 5, message())
    result.current.cancel('one')
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(send).not.toHaveBeenCalled()
  act(() => result.current.schedule('one', 1, message()))
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(send).toHaveBeenCalledExactlyOnceWith('one', message())
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
  expect(send).toHaveBeenLastCalledWith('two', message())
  expect(send).toHaveBeenCalledTimes(2)
})

it('keeps an in-flight send locked and uses the latest sender without retrying on failure', async () => {
  const failed = new Error('offline')
  let reject!: (error: Error) => void
  const first = vi.fn()
  const latest = vi.fn(() => new Promise<void>((_, fail) => { reject = fail }))
  const onError = vi.fn()
  const { result, rerender } = renderHook(({ send }) => useDelayedSend(send, onError), { initialProps: { send: first } })
  act(() => result.current.schedule('source', 1, message()))
  rerender({ send: latest })
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(first).not.toHaveBeenCalled()
  expect(result.current.pending.source.sending).toBe(true)
  act(() => {
    result.current.cancel('source')
    result.current.schedule('source', 1, message())
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(latest).toHaveBeenCalledTimes(1)
  await act(async () => { reject(failed) })
  expect(onError).toHaveBeenCalledExactlyOnceWith('source', failed)
  expect(result.current.pending).toEqual({})
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000) })
  expect(latest).toHaveBeenCalledTimes(1)
})

it('cancels timers when the application unmounts', async () => {
  const send = vi.fn()
  const { result, unmount } = renderHook(() => useDelayedSend(send, vi.fn()))
  act(() => result.current.schedule('source', 1, message()))
  unmount()
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000) })
  expect(send).not.toHaveBeenCalled()
})
