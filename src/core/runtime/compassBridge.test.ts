import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

it('writes credentials without returning them and uses a dedicated connection test', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(true).mockResolvedValueOnce('test-model')
  expect(await runtime.compassHasKey()).toBe(true)
  expect(await runtime.saveCompassModel('test-model')).toBe('test-model')
  await runtime.saveCompassKey('fake-key')
  await runtime.probeCompass()
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['compass_has_key'],
    ['compass_save_model', { model: 'test-model' }],
    ['compass_save_key', { apiKey: 'fake-key' }],
    ['compass_probe'],
  ])
})
