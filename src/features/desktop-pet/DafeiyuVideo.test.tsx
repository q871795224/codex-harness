// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { DafeiyuVideo } from './DafeiyuVideo'

vi.mock('../../core/runtime/bridge', () => ({
  runtime: { desktopPetMovie: vi.fn().mockResolvedValue(new ArrayBuffer(8)) },
}))

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('loops the full idle video and returns to it only after the random clip ends', async () => {
  vi.useFakeTimers()
  let serial = 0
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => `blob:movie-${++serial}`)
    static revokeObjectURL = vi.fn()
  })
  const { container, rerender } = render(<DafeiyuVideo status="idle" idleCount={1} />)
  const video = () => container.querySelector('video')!
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  await advance(59_999)
  expect(runtime.desktopPetMovie).toHaveBeenCalledExactlyOnceWith('idle', null)
  expect(video().loop).toBe(true)
  expect(video().playbackRate).toBe(1)
  await advance(1)
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('idle', 0)
  expect(video().loop).toBe(false)
  await advance(15_000)
  expect(runtime.desktopPetMovie).toHaveBeenCalledTimes(2)
  fireEvent.ended(video())
  await advance(0)
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('idle', null)
  expect(video().loop).toBe(true)

  await advance(60_000)
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('idle', 0)
  rerender(<DafeiyuVideo status="waiting" idleCount={1} />)
  await advance(0)
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('waiting', null)
  expect(video().loop).toBe(true)
})
