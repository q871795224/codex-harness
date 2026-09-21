import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
it('passes memory catalog and structured save through registered IPC', async () => {
  await runtime.memoryCatalog('/repo')
  expect(invoke).toHaveBeenLastCalledWith('memory_catalog', { cwd: '/repo' })
  const input = { threadId: 't', cwd: '/repo', sourceTurnIds: [], memories: [] }
  await runtime.memorySave(input)
  expect(invoke).toHaveBeenLastCalledWith('memory_save', { input })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('保存失败'))
  await expect(runtime.memorySave(input)).rejects.toThrow('保存失败')
})
