// @vitest-environment jsdom
import React, { useState } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAsyncWaitPrefill } from './useAsyncWaitPrefill'
import type { AsyncWaitTask } from './types'
import type { ComposerDraft } from '../../features/conversation/Composer'
import { runtime } from '../runtime/bridge'
vi.mock('../runtime/bridge', () => ({ runtime: { listAsyncWaits: vi.fn(), listenAsyncWaits: vi.fn(async () => () => {}), stageAsyncWaitDraft: vi.fn(), upsertComposerDraft: vi.fn() } }))
const task = { id: 'ci', threadId: 'background', status: 'notified', title: 'CI', lastObservation: 'CI failed', continuation: 'Review the current MR', draftStaged: false } as AsyncWaitTask
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task], schedulerError: null })
})
afterEach(cleanup)
function useFixture(initial: Record<string, ComposerDraft> = {}) {
  const [drafts, set] = useState(initial)
  const inbox = useAsyncWaitPrefill(drafts, (threadId, draft) => set(values => ({ ...values, [threadId]: draft })), true)
  return { drafts, ...inbox }
}
it('prefills a background conversation without sending and saves before acknowledging', async () => {
  let saved = false
  vi.mocked(runtime.upsertComposerDraft).mockImplementation(async () => { saved = true })
  vi.mocked(runtime.stageAsyncWaitDraft).mockImplementation(async () => { expect(saved).toBe(true); return task })
  const hook = renderHook(() => useFixture())
  await waitFor(() => expect(hook.result.current.drafts.background.text).toContain('CI failed'))
  await waitFor(() => expect(runtime.stageAsyncWaitDraft).toHaveBeenCalledWith('ci'))
  expect(runtime.upsertComposerDraft).toHaveBeenCalledTimes(1)
})
it('preserves existing text and attachments until the user inserts the result', async () => {
  const original = { text: 'My draft', attachments: [{ path: '/image.png', name: 'image', kind: 'image' as const }], collapsedPastes: [] }
  const hook = renderHook(() => useFixture({ background: original }))
  await waitFor(() => expect(hook.result.current.tasks).toHaveLength(1))
  expect(hook.result.current.drafts.background).toEqual(original)
  expect(runtime.upsertComposerDraft).not.toHaveBeenCalled()
  await act(() => hook.result.current.insert(task))
  expect(hook.result.current.drafts.background.text).toMatch(/^My draft\n\n异步任务/)
  expect(hook.result.current.drafts.background.attachments).toEqual(original.attachments)
})
it('does not replay a consumed result and deduplicates a persisted unacknowledged draft', async () => {
  vi.mocked(runtime.listAsyncWaits).mockResolvedValueOnce({ data: [{ ...task, draftStaged: true }], schedulerError: null })
  const hook = renderHook(() => useFixture())
  await waitFor(() => expect(runtime.listAsyncWaits).toHaveBeenCalled())
  expect(runtime.upsertComposerDraft).not.toHaveBeenCalled()
  hook.unmount()
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task], schedulerError: null })
  const restored = 'Existing result\n任务 ID：ci'
  const next = renderHook(() => useFixture({ background: { text: restored, attachments: [], collapsedPastes: [] } }))
  await waitFor(() => expect(runtime.stageAsyncWaitDraft).toHaveBeenCalled())
  expect(next.result.current.drafts.background.text).toBe(restored)
})
it('processes another empty conversation even if the first has a user draft', async () => {
  vi.mocked(runtime.listAsyncWaits).mockResolvedValue({ data: [task, { ...task, id: 'second', threadId: 'empty' }], schedulerError: null })
  const hook = renderHook(() => useFixture({ background: { text: 'mine', attachments: [], collapsedPastes: [] } }))
  await waitFor(() => expect(hook.result.current.drafts.empty.text).toContain('任务 ID：second'))
  expect(hook.result.current.drafts.background.text).toBe('mine')
})
