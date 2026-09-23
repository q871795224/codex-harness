// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { useCodexUpdate } from './useCodexUpdate'

vi.mock('../../core/runtime/bridge', () => ({ runtime: {
  codexUpdateStatus: vi.fn(), listenCodexUpdateProgress: vi.fn(async () => () => {}),
} }))
const status = { currentVersion: '0.156.1', appServerVersion: '0.156.1', latestVersion: '0.156.1', updateAvailable: false, skipped: false, lastCheckedAt: 1, checkError: null }

beforeEach(() => { vi.mocked(runtime.codexUpdateStatus).mockReset().mockResolvedValue(status) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('update checks', () => {
  it('shares a forced check result with the existing update prompt', async () => {
    const { result } = renderHook(() => useCodexUpdate('thread', async () => {}))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(runtime.codexUpdateStatus).toHaveBeenCalledWith(false)
    vi.mocked(runtime.codexUpdateStatus).mockResolvedValue({ ...status, latestVersion: '0.157.0', updateAvailable: true })
    await act(async () => { await result.current.check(true) })
    expect(runtime.codexUpdateStatus).toHaveBeenLastCalledWith(true)
    expect(result.current.visible).toBe(true)
    expect(result.current.status?.latestVersion).toBe('0.157.0')
  })

  it('forces a network check even when an automatic check is already pending', async () => {
    let resolve!: (value: typeof status) => void
    vi.mocked(runtime.codexUpdateStatus).mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const { result } = renderHook(() => useCodexUpdate('thread', async () => {}))
    let manual!: Promise<unknown>
    act(() => { manual = result.current.check(true) })
    await act(async () => { resolve(status); await manual })
    expect(runtime.codexUpdateStatus).toHaveBeenNthCalledWith(1, false)
    expect(runtime.codexUpdateStatus).toHaveBeenNthCalledWith(2, true)
  })

  it('periodically retries and cancels its timer on unmount', async () => {
    vi.useFakeTimers()
    const { unmount } = renderHook(() => useCodexUpdate('thread', async () => {}))
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60 * 1000) })
    expect(runtime.codexUpdateStatus).toHaveBeenCalledTimes(2)
    expect(runtime.codexUpdateStatus).toHaveBeenLastCalledWith(false)
    unmount()
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(runtime.codexUpdateStatus).toHaveBeenCalledTimes(2)
  })
})
