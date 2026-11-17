import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue({}) }))
describe('Superbot IPC', () => {
  it('sends only a typed request to the native Collab client', async () => {
    const request = { type: 'send' as const, id: 'remote', content: 'hello', run_config: { model: 'test', thinking_level: 'high' } }
    await runtime.superbotRequest(request)
    expect(invoke).toHaveBeenCalledWith('superbot_request', { request })
  })
})
