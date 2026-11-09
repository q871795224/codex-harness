import { beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../runtime/bridge'
vi.mock('../runtime/bridge', () => ({ runtime: { getAppState: vi.fn(), setAppState: vi.fn() } }))
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.mocked(runtime.getAppState).mockResolvedValue(null); vi.mocked(runtime.setAppState).mockResolvedValue(undefined) })
it('persists keyword feedback and replaces an existing source rule', async () => {
  const { addReplacement, CORRECTION_KEY } = await import('./settings')
  await addReplacement('绘画 → 会话')
  await addReplacement('绘画 -> 对话')
  const saved = JSON.parse(vi.mocked(runtime.setAppState).mock.calls.at(-1)![1])
  expect(saved.rules).toEqual([{ from: '绘画', to: '对话' }])
  expect(runtime.setAppState).toHaveBeenCalledWith(CORRECTION_KEY, expect.any(String))
})
it('restores disabled options and never writes when storage failed to load', async () => {
  vi.mocked(runtime.getAppState).mockRejectedValueOnce(new Error('read failed'))
  const { addReplacement } = await import('./settings')
  await expect(addReplacement('绘画 → 会话')).rejects.toThrow('read failed')
  expect(runtime.setAppState).not.toHaveBeenCalled()
  vi.mocked(runtime.getAppState).mockResolvedValue(JSON.stringify({ enabled: false, quotes: false, rules: [] }))
  await addReplacement('绘画 → 会话')
  expect(JSON.parse(vi.mocked(runtime.setAppState).mock.calls[0][1])).toEqual({ enabled: false, quotes: false, rules: [{ from: '绘画', to: '会话' }] })
})
it('rejects duplicate source mappings without writing', async () => {
  const { saveCorrectionSettings } = await import('./settings')
  await expect(saveCorrectionSettings({ enabled: true, quotes: true, rules: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] })).rejects.toThrow('只能有一条')
  expect(runtime.setAppState).not.toHaveBeenCalled()
})
