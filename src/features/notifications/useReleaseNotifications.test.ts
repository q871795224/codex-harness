// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { notifications } from '../../core/notifications/service'
import { runtime } from '../../core/runtime/bridge'
import type { ReleaseRunStatus } from '../../core/release-command/types'
import { releaseNotification, useReleaseNotifications } from './useReleaseNotifications'

vi.mock('../../core/runtime/bridge', () => ({ runtime: { releaseCommandStatus: vi.fn() } }))
vi.mock('../../core/notifications/service', async () => {
  const { createNotificationStore } = await import('../../core/notifications/store')
  return { notifications: createNotificationStore({ load: async () => null, save: async () => undefined }) }
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks() })
function status(patch: Partial<ReleaseRunStatus> = {}): ReleaseRunStatus {
  return { runId: '123-456', workspaceRoot: '/repo', version: '0.9.0', status: 'running', phase: 'checking', error: null, warning: false, startedAt: 1, updatedAt: 2, completedAt: null, dismissed: false, pid: 1, ...patch }
}

it('keeps polling the originating workspace after switching away and records completion once', async () => {
  await notifications.initialize()
  vi.useFakeTimers()
  const initial = status()
  const completed = status({ status: 'succeeded', phase: 'completed', updatedAt: 3 })
  vi.mocked(runtime.releaseCommandStatus).mockResolvedValue(completed)
  const hook = renderHook(({ current }) => useReleaseNotifications(current), { initialProps: { current: initial as ReleaseRunStatus | null } })
  hook.rerender({ current: null })
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(runtime.releaseCommandStatus).toHaveBeenCalledWith('/repo')
  expect(notifications.snapshot().records.find((record) => record.id === 'release:123-456')).toMatchObject({ title: '发布 0.9.0 已完成', state: 'done', level: 'info' })
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(runtime.releaseCommandStatus).toHaveBeenCalledOnce()
  // A delayed older response must not turn completion back into running.
  act(() => { notifications.publish(releaseNotification(initial)) })
  expect(notifications.snapshot().records.find((record) => record.id === 'release:123-456')?.state).toBe('done')
})

it('maps partial success to warning and keeps raw errors and historical log target in details', () => {
  const result = releaseNotification(status({ status: 'succeeded', warning: true, error: 'RAW_VERIFY_ERROR' }))
  expect(result).toMatchObject({ level: 'warning', details: 'RAW_VERIFY_ERROR', actions: [{ kind: 'release-log', target: '/repo', runId: '123-456', label: '查看日志' }] })
  expect(result.title + result.message).not.toContain('RAW_VERIFY_ERROR')
  expect(releaseNotification(status({ status: 'failed' })).level).toBe('error')
})
