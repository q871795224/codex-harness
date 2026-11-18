// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import PetWindow from './PetWindow'

vi.mock('../../core/runtime/bridge', () => ({
  runtime: {
    listenDesktopPetChanges: vi.fn().mockResolvedValue(() => {}),
    desktopPetSnapshot: vi.fn().mockResolvedValue({ pet: null, activity: { status: 'waiting', count: 2 } }),
    desktopPetOpen: vi.fn().mockResolvedValue(undefined),
    desktopPetVisibility: vi.fn().mockResolvedValue(false),
    startDesktopPetDragging: vi.fn().mockResolvedValue(undefined),
  },
}))
afterEach(cleanup)

it('opens the assistant and the active notification separately', async () => {
  render(<PetWindow />)
  fireEvent.click(await screen.findByRole('button', { name: '会话需要你处理，2 项' }))
  fireEvent.click(screen.getByRole('button', { name: '打开 Harness 助理' }))
  fireEvent.click(screen.getByRole('button', { name: '隐藏桌面宠物' }))
  await waitFor(() => expect(runtime.desktopPetVisibility).toHaveBeenCalledWith(false))
  expect(runtime.desktopPetOpen).toHaveBeenNthCalledWith(1, false)
  expect(runtime.desktopPetOpen).toHaveBeenNthCalledWith(2, true)
})
