import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))

it('preserves management request correlation, explicit readiness and native errors', async () => {
  const receive = vi.fn()
  await runtime.listenManagementRequests(receive)
  const handler = vi.mocked(listen).mock.calls[0][1]
  handler({ payload: { requestId: 'one', method: 'status', params: {} } } as never)
  expect(receive).toHaveBeenCalledWith({ requestId: 'one', method: 'status', params: {} })
  await runtime.managementReady(true)
  expect(invoke).toHaveBeenLastCalledWith('management_ready', { ready: true })
  await runtime.managementRespond('one', { count: 17 })
  expect(invoke).toHaveBeenLastCalledWith('management_respond', { requestId: 'one', result: { count: 17 }, error: null })
  await runtime.managementRespond('two', undefined, 'failed')
  expect(invoke).toHaveBeenLastCalledWith('management_respond', { requestId: 'two', result: null, error: 'failed' })
  vi.mocked(invoke).mockRejectedValueOnce(new Error('请求已完成'))
  await expect(runtime.managementRespond('one', {})).rejects.toThrow('已完成')
})
