import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
it('obtains the neutral router directory through the native bridge', async () => {
  vi.mocked(invoke).mockResolvedValue('/data/workspaces/general')
  expect(await runtime.routerWorkspaceDirectory()).toBe('/data/workspaces/general')
  expect(invoke).toHaveBeenCalledWith('workspace_router_directory')
})
it('uses typed native commands for cached summaries, corrections, and the token budget', async () => {
  vi.mocked(invoke).mockResolvedValue([])
  await runtime.routerSummaries(['/a'])
  expect(invoke).toHaveBeenLastCalledWith('workspace_router_summaries', { roots: ['/a'] })
  await runtime.claimRouterSummary('/a', '/checkout')
  expect(invoke).toHaveBeenLastCalledWith('workspace_router_summary_claim', { root: '/a', checkoutRoot: '/checkout' })
  await runtime.finishRouterSummary('/a', 'lease', '介绍')
  expect(invoke).toHaveBeenLastCalledWith('workspace_router_summary_finish', { root: '/a', lease: 'lease', description: '介绍' })
  await runtime.routerCorrections()
  expect(invoke).toHaveBeenLastCalledWith('workspace_router_corrections')
  const input = { instructions: 'choose', schema: '{}', userTexts: ['work'], candidates: [], examples: [], tokenBudget: 8192 }
  await runtime.buildRouterPrompt(input)
  expect(invoke).toHaveBeenLastCalledWith('workspace_router_build_prompt', { input })
})
it('explicitly bypasses the 24h check through the native lease-aware command', async () => {
  vi.mocked(invoke).mockResolvedValue(null)
  await runtime.claimRouterSummary('/a', '/checkout', true)
  expect(invoke).toHaveBeenLastCalledWith('workspace_router_summary_claim', { root: '/a', checkoutRoot: '/checkout', checkNow: true })
})
