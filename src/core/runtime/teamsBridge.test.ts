import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
it('passes document keys, content, revisions and native conflicts through IPC', async () => {
  await runtime.teamReadDocument('state')
  expect(invoke).toHaveBeenLastCalledWith('team_read_document', { key: 'state' })
  await runtime.teamWriteDocument('memory:member@/repo', 3, '# scoped experience')
  expect(invoke).toHaveBeenLastCalledWith('team_write_document', { key: 'memory:member@/repo', expectedRevision: 3, content: '# scoped experience' })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('文档已被其他窗口修改'))
  await expect(runtime.teamWriteDocument('state', 2, '{}')).rejects.toThrow('其他窗口')
})
