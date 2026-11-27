import { invoke } from '@tauri-apps/api/core'
import { expect, it, vi } from 'vitest'
import { runtime } from './bridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

it('asks the native layer for the dedicated relay workspace', async () => {
  vi.mocked(invoke).mockResolvedValue('/data/workspaces/relay')
  expect(await runtime.relayWorkspaceDirectory()).toBe('/data/workspaces/relay')
  expect(invoke).toHaveBeenCalledWith('relay_workspace_directory')
})
