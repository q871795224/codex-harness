// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ProjectDocService, ThreadProjectBinding } from '../../core/project-docs/types'
import type { ProjectMeta } from './types'
import { useProjectBinding } from './useProjectBinding'

afterEach(cleanup)

const meta: ProjectMeta = { projectId: 'demo', name: '示例项目', currentSeq: 2, createdAt: 1, updatedAt: 1 }

/** 内存版 service：用一份共享 bindings 模拟 appState，验证 hook 的读写与订阅同步。 */
function makeService(initial: Record<string, ThreadProjectBinding> = {}) {
  const bindings = { ...initial }
  const listeners = new Set<() => void>()
  const notify = () => { for (const l of [...listeners]) l() }
  const service: ProjectDocService = {
    create: vi.fn(async () => meta),
    list: vi.fn(async () => [meta]),
    get: vi.fn(async (projectId: string) => ({ ...meta, projectId })),
    rename: vi.fn(async () => undefined),
    archive: vi.fn(async () => undefined),
    bindWorkspace: vi.fn(async () => undefined),
    workspaces: vi.fn(async () => []),
    read: vi.fn(async () => ({ projectId: 'demo', currentSeq: 2, content: '', contentHash: 'h', consistent: true })),
    versions: vi.fn(async () => []),
    writeSection: vi.fn(async () => ({ kind: 'applied' as const, newSeq: 3, contentHash: 'h' })),
    listProposals: vi.fn(async () => []),
    approveProposal: vi.fn(async () => ({ kind: 'applied' as const, newSeq: 3, contentHash: 'h' })),
    rejectProposal: vi.fn(async () => undefined),
    ensureServer: vi.fn(async () => 0),
    threadProject: vi.fn(async (threadId: string) => bindings[threadId]?.projectId ?? null),
    threadBinding: vi.fn(async (threadId: string) => bindings[threadId] ?? null),
    bindThread: vi.fn(async (threadId: string, projectId: string) => {
      bindings[threadId] = { projectId, phase: 'pending' }
      notify()
    }),
    lockThreadBinding: vi.fn(async (threadId: string) => {
      if (bindings[threadId]) bindings[threadId] = { ...bindings[threadId], phase: 'locked' }
      notify()
    }),
    unbindThread: vi.fn(async (threadId: string) => {
      delete bindings[threadId]
      notify()
    }),
    subscribeBindings: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
  }
  return { service, bindings }
}

it('starts unbound, binds as pending, and exposes project meta', async () => {
  const { service } = makeService()
  const { result } = renderHook(() => useProjectBinding(service, 'thread-1', '/root'))

  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.binding).toBeNull()

  await act(async () => { await result.current.bind('demo') })
  expect(result.current.binding).toEqual({ projectId: 'demo', phase: 'pending' })
  expect(result.current.locked).toBe(false)
  expect(result.current.project?.name).toBe('示例项目')
})

it('lockOnSend transitions pending to locked', async () => {
  const { service } = makeService()
  const { result } = renderHook(() => useProjectBinding(service, 'thread-1', null))
  await waitFor(() => expect(result.current.loading).toBe(false))

  await act(async () => { await result.current.bind('demo') })
  expect(result.current.locked).toBe(false)

  await act(async () => { await result.current.lockOnSend() })
  expect(result.current.binding?.phase).toBe('locked')
  expect(result.current.locked).toBe(true)
})

it('unbind clears the binding', async () => {
  const { service } = makeService({ 'thread-1': { projectId: 'demo', phase: 'pending' } })
  const { result } = renderHook(() => useProjectBinding(service, 'thread-1', null))
  await waitFor(() => expect(result.current.binding?.projectId).toBe('demo'))

  await act(async () => { await result.current.unbind() })
  expect(result.current.binding).toBeNull()
})

it('stays in sync when bindings change outside the hook (via subscribeBindings)', async () => {
  const { service } = makeService()
  const { result } = renderHook(() => useProjectBinding(service, 'thread-1', null))
  await waitFor(() => expect(result.current.binding).toBeNull())

  // 模拟另一处（绑定面板）直接改绑定：hook 应通过订阅自动刷新，无需调用自己的 bind
  await act(async () => { await service.bindThread('thread-1', 'demo') })
  await waitFor(() => expect(result.current.binding?.projectId).toBe('demo'))

  await act(async () => { await service.lockThreadBinding('thread-1') })
  await waitFor(() => expect(result.current.binding?.phase).toBe('locked'))

  await act(async () => { await service.unbindThread('thread-1') })
  await waitFor(() => expect(result.current.binding).toBeNull())
})

it('treats no threadId as unbound and inert', async () => {
  const { service } = makeService()
  const { result } = renderHook(() => useProjectBinding(service, null, null))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.binding).toBeNull()

  await act(async () => { await result.current.bind('demo') })
  expect(result.current.binding).toBeNull()
})
