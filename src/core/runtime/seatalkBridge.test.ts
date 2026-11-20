import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
it('uses the fixed native SeaTalk channel and propagates errors without exposing a generic HTTP proxy', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ claimed: true, threadId: 'two' })
  expect(await runtime.seatalkRemoteCall('claim', { messageId: 'mobile' })).toEqual({ claimed: true, threadId: 'two' })
  expect(invoke).toHaveBeenCalledWith('seatalk_remote_call', { action: 'claim', input: { messageId: 'mobile' } })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('offline'))
  await expect(runtime.seatalkRemoteCall('status')).rejects.toThrow('offline')
})

it('reads title context through a dedicated read-only native command', async () => {
  vi.mocked(invoke).mockResolvedValueOnce('选中消息：DNS 工单失败')
  expect(await runtime.seatalkTitleContext('seatalk://conversation?v=1')).toBe('选中消息：DNS 工单失败')
  expect(invoke).toHaveBeenLastCalledWith('seatalk_title_context', { reference: 'seatalk://conversation?v=1' })
})
