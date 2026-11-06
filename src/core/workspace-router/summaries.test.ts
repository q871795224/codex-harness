import { beforeEach, expect, it, vi } from 'vitest'
import type { Workspace } from '../domain/codex'
import { runtime } from '../runtime/bridge'
import { runRouterTask } from './service'
import { refreshRouterSummaries } from './summaries'
vi.mock('../runtime/bridge', () => ({ runtime: { getAppState: vi.fn(), routerWorkspaceDirectory: vi.fn(), claimRouterSummary: vi.fn(), finishRouterSummary: vi.fn(), recordClientDiagnostic: vi.fn() } }))
vi.mock('./service', () => ({ runRouterTask: vi.fn() }))
const workspaces = [{ root: '/a', checkoutRoot: '/checkout', name: 'API' }] as Workspace[]
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(runtime.getAppState).mockResolvedValue(null)
  vi.mocked(runtime.routerWorkspaceDirectory).mockResolvedValue('/neutral')
  vi.mocked(runtime.claimRouterSummary).mockResolvedValue(null)
  vi.mocked(runtime.finishRouterSummary).mockResolvedValue(undefined)
  vi.mocked(runtime.recordClientDiagnostic).mockResolvedValue(undefined)
})
it('does not call a model for unchanged, not-due or already-leased workspaces', async () => {
  await refreshRouterSummaries(workspaces)
  expect(runRouterTask).not.toHaveBeenCalled()
})
it('generates only a claimed description in the neutral workspace and commits through its lease', async () => {
  vi.mocked(runtime.claimRouterSummary).mockResolvedValue({ lease: 'lease', source: '## README\nDNS API management' })
  vi.mocked(runRouterTask).mockResolvedValue('{"description":"管理DNS资源和配置"}')
  await refreshRouterSummaries(workspaces)
  expect(runRouterTask).toHaveBeenCalledWith('/neutral', expect.any(Array), expect.any(String), expect.any(Object), expect.objectContaining({ model: 'gpt-6.1-terra', effort: 'medium' }), 'workspace-router-summary')
  expect(runtime.finishRouterSummary).toHaveBeenCalledWith('/a', 'lease', '管理DNS资源和配置')
})
it('releases a failed generation without replacing the old description or leaking model output', async () => {
  vi.mocked(runtime.claimRouterSummary).mockResolvedValue({ lease: 'lease', source: 'docs' })
  vi.mocked(runRouterTask).mockResolvedValue('private invalid output')
  await refreshRouterSummaries(workspaces)
  expect(runtime.finishRouterSummary).toHaveBeenCalledWith('/a', 'lease', null)
  expect(JSON.stringify(vi.mocked(runtime.recordClientDiagnostic).mock.calls)).not.toContain('private')
})
it('stops when its host is disposed and never claims another workspace', async () => {
  await refreshRouterSummaries(workspaces, () => true)
  expect(runtime.claimRouterSummary).not.toHaveBeenCalled()
})
it('requests an immediate hash check without forcing a model call for unchanged documents', async () => {
  const results = await refreshRouterSummaries(workspaces, () => false, true)
  expect(runtime.claimRouterSummary).toHaveBeenCalledWith('/a', '/checkout', true)
  expect(results).toEqual([{ root: '/a', failed: false }])
  expect(runRouterTask).not.toHaveBeenCalled()
})
it('runs a manual update after a running automatic workspace without dropping it or overlapping generation', async () => {
  let finish!: (result: string) => void
  vi.mocked(runtime.claimRouterSummary).mockResolvedValue({ lease: 'lease', source: 'docs' })
  vi.mocked(runRouterTask).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const automatic = refreshRouterSummaries(workspaces)
  await vi.waitFor(() => expect(finish).toBeDefined())
  const manual = refreshRouterSummaries(workspaces, () => false, true)
  expect(runRouterTask).toHaveBeenCalledTimes(1)
  vi.mocked(runtime.claimRouterSummary).mockResolvedValue(null)
  finish('{"description":"DNS API"}')
  await automatic
  expect(await manual).toEqual([{ root: '/a', failed: false }])
  expect(runtime.claimRouterSummary).toHaveBeenLastCalledWith('/a', '/checkout', true)
  expect(runRouterTask).toHaveBeenCalledTimes(1)
})
