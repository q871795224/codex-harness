// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import PetWindow from './PetWindow'

vi.mock('../../core/runtime/bridge', () => ({
  runtime: {
    listenDesktopPetChanges: vi.fn().mockResolvedValue(() => {}),
    desktopPetSnapshot: vi.fn().mockResolvedValue({ pet: null, activity: { status: 'waiting', count: 2 } }),
    desktopPetOpen: vi.fn().mockResolvedValue(undefined),
    desktopPetDrag: vi.fn().mockResolvedValue(undefined),
    desktopPetMenu: vi.fn().mockResolvedValue(undefined),
  },
}))
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })

it('opens the standalone conversation on click and shows the menu on right click', async () => {
  render(<PetWindow />)
  await screen.findByLabelText('会话需要你处理，2 项')
  const pet = screen.getByRole('button', { name: '打开 Harness 助理' })
  expect(screen.getAllByRole('button')).toEqual([pet])
  fireEvent.pointerDown(pet, { pointerId: 1, button: 0 })
  fireEvent.pointerUp(pet, { pointerId: 1, button: 0 })
  fireEvent.click(pet, { detail: 1 })
  fireEvent.contextMenu(pet)
  expect(runtime.desktopPetOpen).toHaveBeenCalledExactlyOnceWith()
  expect(runtime.desktopPetMenu).toHaveBeenCalledExactlyOnceWith()
})

it('starts a drag only after a long press and suppresses the trailing click', async () => {
  render(<PetWindow />)
  await screen.findByLabelText('会话需要你处理，2 项')
  vi.useFakeTimers()
  const pet = screen.getByRole('button', { name: '打开 Harness 助理' })
  fireEvent.pointerDown(pet, { pointerId: 1, button: 0, clientX: 20, clientY: 20 })
  await act(async () => { await vi.advanceTimersByTimeAsync(319) })
  expect(runtime.desktopPetDrag).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(runtime.desktopPetDrag).toHaveBeenCalledExactlyOnceWith()
  fireEvent.pointerUp(pet, { pointerId: 1 })
  fireEvent.click(pet, { detail: 1 })
  expect(runtime.desktopPetOpen).not.toHaveBeenCalled()
})
