import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
it('passes memory catalog and structured save through registered IPC', async () => {
  await runtime.memoryCatalog('/repo')
  expect(invoke).toHaveBeenLastCalledWith('memory_catalog', { cwd: '/repo' })
  const input = { threadId: 't', cwd: '/repo', sourceWorkspace: 'repo', sourceTurnIds: [], memories: [] }
  await runtime.memorySave(input)
  expect(invoke).toHaveBeenLastCalledWith('memory_save', { input })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('保存失败'))
  await expect(runtime.memorySave(input)).rejects.toThrow('保存失败')
})

it('passes domain management and binding deltas through IPC', async () => {
  await runtime.memoryDomainSettings()
  expect(invoke).toHaveBeenLastCalledWith('memory_domain_settings')
  await runtime.memoryCreateDomain('DNS')
  expect(invoke).toHaveBeenLastCalledWith('memory_create_domain', { name: 'DNS' })
  await runtime.memorySetDomainBinding('/repo', 'DNS', true)
  expect(invoke).toHaveBeenLastCalledWith('memory_set_domain_binding', { workspaceRoot: '/repo', domain: 'DNS', linked: true })
  await runtime.memorySetDomainBinding(null, 'DNS', false)
  expect(invoke).toHaveBeenLastCalledWith('memory_set_domain_binding', { workspaceRoot: null, domain: 'DNS', linked: false })
  await runtime.memoryDeleteDomain('DNS')
  expect(invoke).toHaveBeenLastCalledWith('memory_delete_domain', { name: 'DNS' })
})

it('passes the loaded file content to the native conflict check and preserves errors', async () => {
  const path = '/data/memory/global/MEMORY.md'
  await runtime.writeHarnessFile('/repo', path, 'edited', [], 'codex', 'loaded')
  expect(invoke).toHaveBeenLastCalledWith('write_harness_file', {
    cwd: '/repo', path, content: 'edited', fallbackFilenames: [], provider: 'codex', expectedContent: 'loaded',
  })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('记忆文件已被其他操作修改'))
  await expect(runtime.writeHarnessFile('/repo', path, 'edited', [], 'codex', 'loaded')).rejects.toThrow('其他操作修改')
})
