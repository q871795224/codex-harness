import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
it('obtains the neutral router directory through the native bridge', async () => {
  vi.mocked(invoke).mockResolvedValue('/data/workspaces/general')
  expect(await runtime.routerWorkspaceDirectory()).toBe('/data/workspaces/general')
  expect(invoke).toHaveBeenCalledWith('workspace_router_directory')
})
