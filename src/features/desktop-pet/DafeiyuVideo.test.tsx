// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import movies from '../../../src-tauri/pets/dafeiyu/movies.json'
import { DafeiyuVideo } from './DafeiyuVideo'

vi.mock('../../core/runtime/bridge', () => ({ runtime: { desktopPetMovie: vi.fn() } }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(runtime.desktopPetMovie).mockResolvedValue(new ArrayBuffer(8))
  vi.spyOn(Math, 'random').mockReturnValue(0)
  let serial = 0
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => `blob:movie-${++serial}`)
    static revokeObjectURL = vi.fn()
  })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })
const flush = () => act(async () => {})
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

it('alternates completed actions and random idle bridges without a 60-second timer or repeat', async () => {
  const { container } = render(<DafeiyuVideo status="idle" idleCount={89} />)
  const video = () => container.querySelector<HTMLVideoElement>('video:last-child')!
  const finish = async () => { fireEvent.loadedData(video()); fireEvent.ended(video()); await flush() }
  await flush()
  expect(runtime.desktopPetMovie).toHaveBeenCalledExactlyOnceWith('idle', null)
  expect(video().loop).toBe(false)
  expect(video().playbackRate).toBe(1)
  // Only media completion advances playback; elapsed time must not cut a long action short.
  await advance(60_000)
  expect(runtime.desktopPetMovie).toHaveBeenCalledTimes(1)
  await finish()
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('idle', 0)
  await finish()
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('idle', movies.idle.indexOf('哈欠连天.mov'))
  await finish()
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('idle', 1)
  await finish()
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('idle', null)
})

it('holds the last rendered frame until the next movie is decoded and releases old URLs', async () => {
  const { container, unmount } = render(<DafeiyuVideo status="idle" idleCount={1} />)
  await flush()
  const first = container.querySelector<HTMLVideoElement>('video')!
  fireEvent.loadedData(first)
  fireEvent.ended(first)
  await flush()
  expect(container.querySelectorAll('video')).toHaveLength(2)
  expect(first.dataset.ready).toBe('true')
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:movie-1')
  const second = container.querySelector<HTMLVideoElement>('video:last-child')!
  expect(second.dataset.ready).toBe('false')
  fireEvent.loadedData(second)
  expect(container.querySelectorAll('video')).toHaveLength(1)
  expect(second.dataset.ready).toBe('true')
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:movie-1')
  unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:movie-2')
})

it('immediately yields to activity, loops that state, and resumes breathing after becoming idle', async () => {
  const { container, rerender, unmount } = render(<DafeiyuVideo status="idle" idleCount={1} />)
  await flush()
  fireEvent.loadedData(container.querySelector<HTMLVideoElement>('video')!)
  fireEvent.ended(container.querySelector<HTMLVideoElement>('video')!)
  await flush()
  rerender(<DafeiyuVideo status="waiting" idleCount={1} />)
  expect(container.querySelector<HTMLVideoElement>('video')).toBeNull()
  await flush()
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('waiting', null)
  expect(container.querySelector<HTMLVideoElement>('video')?.loop).toBe(true)
  const count = vi.mocked(runtime.desktopPetMovie).mock.calls.length
  fireEvent.ended(container.querySelector<HTMLVideoElement>('video')!)
  await advance(60_000)
  expect(runtime.desktopPetMovie).toHaveBeenCalledTimes(count)
  rerender(<DafeiyuVideo status="idle" idleCount={1} />)
  await flush()
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('idle', null)
  expect(container.querySelector<HTMLVideoElement>('video')?.loop).toBe(false)
  unmount()
  await advance(60_000)
  expect(runtime.desktopPetMovie).toHaveBeenCalledTimes(count + 1)
})

it('skips unreadable clips after a bounded delay and cancels retry when activity changes', async () => {
  vi.mocked(runtime.desktopPetMovie).mockResolvedValueOnce(new ArrayBuffer(8)).mockRejectedValueOnce(new Error('missing'))
  const { container, rerender } = render(<DafeiyuVideo status="idle" idleCount={89} />)
  await flush()
  fireEvent.loadedData(container.querySelector<HTMLVideoElement>('video')!)
  fireEvent.ended(container.querySelector<HTMLVideoElement>('video')!)
  await flush()
  const failed = vi.mocked(runtime.desktopPetMovie).mock.calls.length
  await advance(1999)
  expect(runtime.desktopPetMovie).toHaveBeenCalledTimes(failed)
  await advance(1)
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('idle', movies.idle.indexOf('哈欠连天.mov'))
  fireEvent.error(container.querySelector<HTMLVideoElement>('video:last-child')!)
  rerender(<DafeiyuVideo status="running" idleCount={89} />)
  await flush()
  const interrupted = vi.mocked(runtime.desktopPetMovie).mock.calls.length
  await advance(5000)
  expect(runtime.desktopPetMovie).toHaveBeenCalledTimes(interrupted)
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('running', null)
})

it('discards a late idle response after a status switch', async () => {
  let resolve!: (bytes: ArrayBuffer) => void
  vi.mocked(runtime.desktopPetMovie).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const { container, rerender } = render(<DafeiyuVideo status="idle" idleCount={89} />)
  rerender(<DafeiyuVideo status="failed" idleCount={89} />)
  await flush()
  await act(async () => { resolve(new ArrayBuffer(8)) })
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  expect(container.querySelectorAll('video')).toHaveLength(1)
  expect(runtime.desktopPetMovie).toHaveBeenLastCalledWith('failed', null)
})
