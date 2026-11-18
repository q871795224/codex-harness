import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

it('uses dedicated native commands for Compass configuration and the fixed connection test', async () => {
  const status = { supported: true, model: 'test-model' }
  vi.mocked(invoke).mockResolvedValueOnce(status).mockResolvedValueOnce(status)
  expect(await runtime.compassStatus()).toEqual(status)
  expect(await runtime.saveCompass('test-model', null)).toEqual(status)
  await runtime.probeCompass()
  await runtime.removeCompass()
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['compass_status'],
    ['compass_save', { model: 'test-model', apiKey: null }],
    ['compass_probe'],
    ['compass_remove'],
  ])
})
