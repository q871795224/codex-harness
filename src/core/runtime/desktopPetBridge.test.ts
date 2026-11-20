import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { expect, it, vi } from 'vitest'
import { runtime } from './bridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

it('imports only paths selected from the appropriate native picker', async () => {
  vi.mocked(open).mockResolvedValueOnce(null).mockResolvedValueOnce('/pet-package').mockResolvedValueOnce(['/frames/01.png', '/frames/02.webp'])
  await expect(runtime.desktopPetImport('folder')).resolves.toBeNull()
  expect(invoke).not.toHaveBeenCalled()
  await runtime.desktopPetImport('folder')
  await runtime.desktopPetImport('frames')
  expect(invoke).toHaveBeenNthCalledWith(1, 'desktop_pet_import', { folder: '/pet-package', frames: null })
  expect(invoke).toHaveBeenNthCalledWith(2, 'desktop_pet_import', { folder: null, frames: ['/frames/01.png', '/frames/02.webp'] })
})

it('loads pet assets through the native command using only an asset key', async () => {
  vi.mocked(invoke).mockResolvedValueOnce([0x89, 0x50])
  const key = { source: 'codex' as const, directory: 'example' }
  const result = await runtime.desktopPetAsset(key)
  expect([...new Uint8Array(result)]).toEqual([0x89, 0x50])
  expect(invoke).toHaveBeenLastCalledWith('desktop_pet_asset', { key })
})

it('requests an idle animation by its index in the selected pet package', async () => {
  vi.mocked(invoke).mockResolvedValueOnce([0x52, 0x49])
  const key = { source: 'harness' as const, directory: 'example' }
  expect([...new Uint8Array(await runtime.desktopPetAsset(key, 0))]).toEqual([0x52, 0x49])
  expect(invoke).toHaveBeenLastCalledWith('desktop_pet_asset', { key, animation: 0 })
})

it('publishes the same normalized bounds used by the character button, including empty frames', async () => {
  const bounds = { x: .3, y: .25, width: .4, height: .6 }
  await runtime.desktopPetSetHitBounds(bounds)
  expect(invoke).toHaveBeenLastCalledWith('desktop_pet_set_hit_bounds', { bounds })
  await runtime.desktopPetSetHitBounds(null)
  expect(invoke).toHaveBeenLastCalledWith('desktop_pet_set_hit_bounds', { bounds: null })
})

it('selects the fixed Dafeiyu native window profile', async () => {
  await runtime.desktopPetSetLayout('dafeiyu-video')
  expect(invoke).toHaveBeenLastCalledWith('desktop_pet_set_layout', { layout: 'dafeiyu-video' })
})
