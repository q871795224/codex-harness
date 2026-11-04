import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { runtime } from './bridge'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
it('uses dedicated native commands, preserves source identity and propagates failures', async () => {
  const input = { id: 'cert-843', threadId: 'origin', title: 'Certificate ready', continuation: 'Verify then prepare next step', checkerPath: '/tmp/check.py' }
  await runtime.createAsyncWait(input)
  expect(invoke).toHaveBeenLastCalledWith('async_wait_create', { input })
  await runtime.listAsyncWaits()
  expect(invoke).toHaveBeenLastCalledWith('async_wait_list')
  vi.mocked(invoke).mockRejectedValueOnce(new Error('cannot resume uncertain delivery'))
  await expect(runtime.asyncWaitAction('cert-843', 'resume')).rejects.toThrow('uncertain')
  const handler = vi.fn()
  await runtime.listenAsyncWaitStarted(handler)
  const receive = vi.mocked(listen).mock.calls.at(-1)![1]
  receive({ payload: { threadId: 'origin', turnId: 'turn' } } as never)
  expect(handler).toHaveBeenCalledWith({ threadId: 'origin', turnId: 'turn' })
})
