import { beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../runtime/bridge'
import { createProjectDocService } from './service'

vi.mock('../runtime/bridge', () => ({ runtime: {
  projectDocThreadBinding: vi.fn(),
  projectDocContext: vi.fn(),
  projectDocMutateEntry: vi.fn(),
  projectDocBindThread: vi.fn(),
  projectDocLockThreadBinding: vi.fn(),
  projectDocUnbindThread: vi.fn(),
} }))
beforeEach(() => vi.resetAllMocks())

it('reads the native binding and delegates mutations before notifying subscribers', async () => {
  const service = createProjectDocService()
  vi.mocked(runtime.projectDocThreadBinding).mockResolvedValue({ projectId: 'demo', phase: 'locked' })
  expect(await service.threadProject('t')).toBe('demo')
  expect(await service.threadBinding('t')).toEqual({ projectId: 'demo', phase: 'locked' })
  expect(runtime.projectDocThreadBinding).toHaveBeenCalledWith('t')
  const listener = vi.fn()
  service.subscribeBindings(listener)
  let complete!: () => void
  vi.mocked(runtime.projectDocBindThread).mockImplementation(() => new Promise<void>((resolve) => { complete = resolve }))
  const pending = service.bindThread('t', 'demo')
  expect(listener).not.toHaveBeenCalled()
  complete()
  await pending
  expect(runtime.projectDocBindThread).toHaveBeenCalledWith('t', 'demo')
  expect(listener).toHaveBeenCalledTimes(1)
  await service.lockThreadBinding('t')
  expect(runtime.projectDocLockThreadBinding).toHaveBeenCalledWith('t')
  await service.unbindThread('t')
  expect(runtime.projectDocUnbindThread).toHaveBeenCalledWith('t')
  expect(listener).toHaveBeenCalledTimes(3)
})

it('preserves native failures without reporting a successful binding change', async () => {
  const service = createProjectDocService()
  const listener = vi.fn()
  service.subscribeBindings(listener)
  vi.mocked(runtime.projectDocUnbindThread).mockRejectedValue(new Error('项目绑定已锁定，不能解绑'))
  await expect(service.unbindThread('t')).rejects.toThrow('已锁定')
  expect(listener).not.toHaveBeenCalled()
  vi.mocked(runtime.projectDocThreadBinding).mockRejectedValue(new Error('无法读取'))
  await expect(service.threadBinding('t')).rejects.toThrow('无法读取')
})

it('delegates entry edits and contextual reads to the native service', async () => {
  const service = createProjectDocService()
  const mutation = { action: 'close' as const, id: 'Q-one', revision: 4, reason: '验收通过' }
  vi.mocked(runtime.projectDocMutateEntry).mockResolvedValue({ kind: 'applied', newSeq: 8, contentHash: 'h' })
  expect(await service.mutateEntry('demo', mutation)).toEqual({ kind: 'applied', newSeq: 8, contentHash: 'h' })
  expect(runtime.projectDocMutateEntry).toHaveBeenCalledWith('demo', mutation)
  vi.mocked(runtime.projectDocContext).mockResolvedValue({ content: '完整正文', seq: 8, tokens: 120, omittedEntries: 0 })
  expect((await service.context('demo', 10000)).content).toBe('完整正文')
  expect(runtime.projectDocContext).toHaveBeenCalledWith('demo', 10000)
})
