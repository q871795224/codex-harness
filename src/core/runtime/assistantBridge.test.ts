import { invoke } from '@tauri-apps/api/core'
import { expect, it, vi } from 'vitest'
import { runtime } from './bridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

it('asks the native layer for the dedicated assistant workspace', async () => {
  vi.mocked(invoke).mockResolvedValue('/data/workspaces/assistant')
  expect(await runtime.assistantWorkspaceDirectory()).toBe('/data/workspaces/assistant')
  expect(invoke).toHaveBeenCalledWith('assistant_workspace_directory')
})
