import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

it('uses a native takeover command with the expected turn instead of sending a custom daemon method', async () => {
  const response = { harnessOwnership: { turnId: 't1', owned: true, canTakeOver: false } }
  vi.mocked(invoke).mockResolvedValueOnce(response)
  expect(await runtime.takeOverCodexThread('thread', 't1')).toBe(response)
  expect(invoke).toHaveBeenCalledWith('app_server_take_over', { threadId: 'thread', expectedTurnId: 't1' })
})

it('scopes approval responses to the original thread, turn and method', async () => {
  await runtime.respond(7, { answers: {} }, { threadId: 'thread', turnId: 'turn', method: 'item/tool/requestUserInput' })
  expect(invoke).toHaveBeenLastCalledWith('app_server_respond', {
    id: 7, result: { answers: {} }, threadId: 'thread', turnId: 'turn', method: 'item/tool/requestUserInput',
  })
})
