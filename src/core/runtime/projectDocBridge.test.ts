import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

it('passes project rename and archive arguments through IPC and preserves failures', async () => {
  await runtime.projectDocRename('demo', '新名称')
  expect(invoke).toHaveBeenCalledWith('project_doc_rename', { projectId: 'demo', name: '新名称' })
  await runtime.projectDocArchive('demo')
  expect(invoke).toHaveBeenCalledWith('project_doc_archive', { projectId: 'demo' })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('归档失败'))
  await expect(runtime.projectDocArchive('demo')).rejects.toThrow('归档失败')
})
