import { beforeEach, expect, it, vi } from 'vitest'
import { runtime } from '../runtime/bridge'
import { createProjectDocService } from './service'

vi.mock('../runtime/bridge', () => ({ runtime: {
  projectDocThreadBinding: vi.fn(),
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
