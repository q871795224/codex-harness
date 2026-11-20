// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { runtime } from '../../core/runtime/bridge'
import { PetSettings } from './PetSettings'

vi.mock('../../core/runtime/bridge', () => ({
  runtime: {
    desktopPetCatalog: vi.fn(),
    desktopPetAsset: vi.fn().mockResolvedValue(new ArrayBuffer(2)),
    desktopPetVisibility: vi.fn().mockResolvedValue(true),
    desktopPetImport: vi.fn(),
    desktopPetDownloadHd: vi.fn().mockResolvedValue(undefined),
    desktopPetSetScale: vi.fn().mockResolvedValue(undefined),
    listenDesktopPetVisibility: vi.fn().mockResolvedValue(() => {}),
  },
}))

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('shows the built-in pet without requiring an import', async () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })))
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => 'blob:dafeiyu')
    static revokeObjectURL = vi.fn()
  })

  const key = { source: 'builtin' as const, directory: 'dafeiyu' }
  const pet = { key, name: '大肥鱼', description: '', version: 1 as const, idleFrames: 6, idleAnimationDurations: [1000] }
  const catalog = { supported: true, visible: false, selected: key, pets: [pet], hdReady: false, scalePercent: 100 }
  vi.mocked(runtime.desktopPetCatalog).mockResolvedValueOnce(catalog).mockResolvedValueOnce({ ...catalog, visible: true })

  render(<PetSettings />)
  const option = await screen.findByRole('option', { name: '大肥鱼 · 内置' }) as HTMLOptionElement
  expect(option.selected).toBe(true)
  await waitFor(() => expect(runtime.desktopPetAsset).toHaveBeenCalledExactlyOnceWith(key))
  fireEvent.click(screen.getByRole('button', { name: '显示桌面宠物' }))
  await screen.findByRole('button', { name: '隐藏桌面宠物' })
  expect(runtime.desktopPetVisibility).toHaveBeenCalledExactlyOnceWith(true)
  expect(runtime.desktopPetImport).not.toHaveBeenCalled()

  vi.mocked(runtime.desktopPetCatalog).mockResolvedValue({ ...catalog, visible: true, hdReady: true })
  fireEvent.click(screen.getByRole('button', { name: /下载大肥鱼原画/ }))
  await screen.findByText('大肥鱼原画素材已下载')
  expect(runtime.desktopPetDownloadHd).toHaveBeenCalledOnce()

  const scale = screen.getByRole('slider', { name: '桌面宠物大小' })
  expect(scale.getAttribute('min')).toBe('20')
  expect(scale.getAttribute('max')).toBe('200')
  vi.mocked(runtime.desktopPetCatalog).mockResolvedValue({ ...catalog, visible: true, hdReady: true, scalePercent: 200 })
  fireEvent.change(scale, { target: { value: '200' } })
  fireEvent.click(screen.getByRole('button', { name: '应用大小' }))
  await screen.findByText('200%')
  expect(runtime.desktopPetSetScale).toHaveBeenCalledExactlyOnceWith(200)
})
