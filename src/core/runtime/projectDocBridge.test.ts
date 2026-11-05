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

it('passes typed thread binding operations through the registered IPC commands', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ projectId: 'demo', phase: 'pending' })
  expect(await runtime.projectDocThreadBinding('t')).toEqual({ projectId: 'demo', phase: 'pending' })
  expect(invoke).toHaveBeenLastCalledWith('project_doc_thread_binding', { threadId: 't' })
  await runtime.projectDocBindThread('t', 'demo')
  expect(invoke).toHaveBeenLastCalledWith('project_doc_bind_thread', { threadId: 't', projectId: 'demo' })
  await runtime.projectDocLockThreadBinding('t')
  expect(invoke).toHaveBeenLastCalledWith('project_doc_lock_thread_binding', { threadId: 't' })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('项目绑定已锁定'))
  await expect(runtime.projectDocUnbindThread('t')).rejects.toThrow('已锁定')
  expect(invoke).toHaveBeenLastCalledWith('project_doc_unbind_thread', { threadId: 't' })
})

it('passes alias writes and atomic fill semantics through IPC', async () => {
  vi.mocked(invoke).mockResolvedValueOnce('DNS限速')
  expect(await runtime.projectDocSetShortName('demo', 'DNS', true)).toBe('DNS限速')
  expect(invoke).toHaveBeenLastCalledWith('project_doc_set_short_name', { projectId: 'demo', shortName: 'DNS', onlyIfEmpty: true })
  await runtime.projectDocSetShortName('demo', '', false)
  expect(invoke).toHaveBeenLastCalledWith('project_doc_set_short_name', { projectId: 'demo', shortName: '', onlyIfEmpty: false })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('项目不存在'))
  await expect(runtime.projectDocSetShortName('missing', 'DNS', true)).rejects.toThrow('项目不存在')
})

it('uses native entry mutations and a deterministic context threshold', async () => {
  const mutation = { action: 'delete' as const, id: 'D-test', revision: 2, reason: '保留失败经验' }
  await runtime.projectDocMutateEntry('demo', mutation)
  expect(invoke).toHaveBeenLastCalledWith('project_doc_mutate_entry', { projectId: 'demo', mutation })
  await runtime.projectDocContext('demo', 10000)
  expect(invoke).toHaveBeenLastCalledWith('project_doc_context', { projectId: 'demo', threshold: 10000 })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('条目修订冲突'))
  await expect(runtime.projectDocMutateEntry('demo', mutation)).rejects.toThrow('冲突')
})
