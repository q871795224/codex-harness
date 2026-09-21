import { beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../runtime/bridge'
import { DEFAULT_MEMORY_SETTINGS, MEMORY_SETTINGS_KEY, loadMemorySettings, saveMemorySettings, validateMemorySettings } from './settings'
vi.mock('../runtime/bridge', () => ({ runtime: { getAppState: vi.fn(), setAppState: vi.fn() } }))
beforeEach(() => vi.resetAllMocks())
it('uses current behavior for missing settings and restores saved values', async () => {
  vi.mocked(runtime.getAppState).mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify({ model: 'custom', maxTurns: 4 }))
  expect(await loadMemorySettings()).toEqual(DEFAULT_MEMORY_SETTINGS)
  expect(await loadMemorySettings()).toMatchObject({ model: 'custom', maxTurns: 4, budgetPercent: 70 })
})
it('rejects invalid user input before persistence', async () => {
  for (const change of [{ maxTurns: -1 }, { maxTurns: 1.5 }, { budgetPercent: 0 }, { budgetPercent: 101 }, { budgetPercent: NaN }, { prompt: '  ' }, { contextWindowTokens: 1 }]) {
    expect(() => validateMemorySettings({ ...DEFAULT_MEMORY_SETTINGS, ...change })).toThrow()
  }
  await expect(saveMemorySettings({ ...DEFAULT_MEMORY_SETTINGS, maxTurns: -1 })).rejects.toThrow()
  expect(runtime.setAppState).not.toHaveBeenCalled()
})
it('persists settings and reports storage failures', async () => {
  await saveMemorySettings({ ...DEFAULT_MEMORY_SETTINGS, model: 'custom', effort: 'high' })
  expect(runtime.setAppState).toHaveBeenCalledWith(MEMORY_SETTINGS_KEY, expect.stringContaining('"model":"custom"'))
  vi.mocked(runtime.setAppState).mockRejectedValueOnce(new Error('写入失败'))
  await expect(saveMemorySettings(DEFAULT_MEMORY_SETTINGS)).rejects.toThrow('写入失败')
})
it('does not silently replace corrupt saved settings', async () => {
  vi.mocked(runtime.getAppState).mockResolvedValue('not json')
  await expect(loadMemorySettings()).rejects.toThrow('格式无效')
})
