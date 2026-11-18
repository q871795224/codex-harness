import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

it('only requests credential presence, model settings, and the fixed connection test over IPC', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(true).mockResolvedValueOnce('test-model')
  expect(await runtime.compassHasKey()).toBe(true)
  expect(await runtime.saveCompassModel('test-model')).toBe('test-model')
  await runtime.probeCompass()
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['compass_has_key'],
    ['compass_save_model', { model: 'test-model' }],
    ['compass_probe'],
  ])
})
