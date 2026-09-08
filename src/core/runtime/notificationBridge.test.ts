import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

it('opens the historical release log requested by a notification and preserves native failures', async () => {
  await runtime.openReleaseLog('/repo', '123-456')
  expect(invoke).toHaveBeenLastCalledWith('open_release_log', { workspaceRoot: '/repo', runId: '123-456' })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('日志不存在'))
  await expect(runtime.openReleaseLog('/repo', '123-456')).rejects.toThrow('日志不存在')
})
