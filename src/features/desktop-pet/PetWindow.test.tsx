// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DesktopPetSnapshot } from '../../core/desktop-pet/types'
import { runtime } from '../../core/runtime/bridge'
import PetWindow from './PetWindow'

vi.mock('../../core/runtime/bridge', () => ({
  runtime: {
    listenDesktopPetChanges: vi.fn().mockResolvedValue(() => {}),
    desktopPetAsset: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    desktopPetSnapshot: vi.fn().mockResolvedValue({ pet: null, activity: { status: 'waiting', count: 2 } }),
    desktopPetOpen: vi.fn().mockResolvedValue(undefined),
    desktopPetVisibility: vi.fn().mockResolvedValue(false),
    startDesktopPetDragging: vi.fn().mockResolvedValue(undefined),
  },
}))
beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })))
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('opens the assistant and the active notification separately', async () => {
  render(<PetWindow />)
  fireEvent.click(await screen.findByRole('button', { name: '会话需要你处理，2 项' }))
  fireEvent.click(screen.getByRole('button', { name: '打开 Harness 助理' }))
  fireEvent.click(screen.getByRole('button', { name: '隐藏桌面宠物' }))
  await waitFor(() => expect(runtime.desktopPetVisibility).toHaveBeenCalledWith(false))
  expect(runtime.desktopPetOpen).toHaveBeenNthCalledWith(1, false)
  expect(runtime.desktopPetOpen).toHaveBeenNthCalledWith(2, true)
})

it('plays a single random idle action each minute and yields to session activity and hiding', async () => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  const createObjectURL = vi.fn().mockReturnValueOnce('blob:idle').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = createObjectURL
    static revokeObjectURL = revokeObjectURL
  })
  const idle: DesktopPetSnapshot = {
    visible: true,
    pet: {
      key: { source: 'harness', directory: 'fish' },
      name: 'Fish', description: '', version: 2, idleFrames: 6, idleAnimationDurations: [1000, 2000],
    },
    activity: { status: 'idle', count: 0, threadId: null, notificationId: null },
  }
  const changed = async (next: DesktopPetSnapshot) => {
    vi.mocked(runtime.desktopPetSnapshot).mockResolvedValueOnce(next)
    await act(async () => { vi.mocked(runtime.listenDesktopPetChanges).mock.calls[0][0]() })
  }
  vi.mocked(runtime.desktopPetSnapshot).mockResolvedValueOnce(idle)
  const { container } = render(<PetWindow />)
  const clip = () => container.querySelector('.desktop-pet-idle-animation')
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  await advance(0)
  await advance(59_999)
  expect(clip()).toBeNull()
  expect(runtime.desktopPetAsset).toHaveBeenCalledTimes(1)
  await advance(1)
  expect(clip()?.getAttribute('src')).toBe('blob:first')
  expect(runtime.desktopPetAsset).toHaveBeenLastCalledWith(idle.pet?.key, 0)
  await advance(1000)
  expect(clip()).toBeNull()
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:first')

  await advance(60_000)
  expect(clip()?.getAttribute('src')).toBe('blob:second')
  expect(runtime.desktopPetAsset).toHaveBeenLastCalledWith(idle.pet?.key, 1)
  await changed({ ...idle, activity: { ...idle.activity, status: 'waiting', count: 1 } })
  expect(clip()).toBeNull()
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:second')
  expect(screen.getByLabelText('会话需要你处理，1 项')).toBeTruthy()
  await changed({ ...idle, visible: false })
  await advance(60_000)
  expect(runtime.desktopPetAsset).toHaveBeenCalledTimes(3)
})
