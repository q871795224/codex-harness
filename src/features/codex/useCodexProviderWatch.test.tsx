// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appServer } from '../../core/runtime/appServerClient'
import { createNotificationStore } from '../../core/notifications/store'
import { createCodexProviderWatch, PROVIDER_CHECK_INTERVAL, useCodexProviderWatch } from './useCodexProviderWatch'

vi.mock('../../core/runtime/appServerClient', () => ({ appServer: { readConfig: vi.fn(), writeConfigValue: vi.fn() } }))
vi.mock('../../core/notifications/service', async () => {
  const { createNotificationStore } = await import('../../core/notifications/store')
  return { notifications: createNotificationStore({ load: async () => null, save: async () => undefined }) }
})
const config = (provider?: string) => ({ config: { model_provider: provider, model: 'fixture', model_reasoning_effort: null, approval_policy: null } })
const store = () => createNotificationStore({ load: async () => null, save: async () => undefined })
beforeEach(() => { vi.resetAllMocks(); vi.mocked(appServer.readConfig).mockResolvedValue(config('openai')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('checks on readiness and every five minutes, stops when unmounted', async () => {
  vi.useFakeTimers()
  const hook = renderHook(({ ready }) => useCodexProviderWatch(ready), { initialProps: { ready: false } })
  expect(appServer.readConfig).not.toHaveBeenCalled()
  await act(async () => { hook.rerender({ ready: true }) })
  expect(appServer.readConfig).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(PROVIDER_CHECK_INTERVAL * 2) })
  expect(appServer.readConfig).toHaveBeenCalledTimes(3)
  hook.unmount()
  await vi.advanceTimersByTimeAsync(PROVIDER_CHECK_INTERVAL)
  expect(appServer.readConfig).toHaveBeenCalledTimes(3)
  expect(appServer.writeConfigValue).not.toHaveBeenCalled()
})

it.each([undefined, 'openai', 'azure'])('leaves %s and all unrelated configuration untouched', async (provider) => {
  const notices = store()
  vi.mocked(appServer.readConfig).mockResolvedValue(config(provider))
  await createCodexProviderWatch(appServer, notices).check()
  expect(notices.snapshot().records).toHaveLength(0)
  expect(appServer.writeConfigValue).not.toHaveBeenCalled()
})

it('warns once per custom episode, offers recovery, and alerts again after reverting to custom', async () => {
  const notices = store()
  const watch = createCodexProviderWatch(appServer, notices)
  vi.mocked(appServer.readConfig).mockResolvedValue(config('custom'))
  await watch.check()
  const initial = notices.snapshot().records[0]
  expect(initial).toMatchObject({ level: 'warning', state: 'pending', actions: [{ kind: 'codex-provider-restore', target: 'openai', label: '改回 OpenAI' }] })
  notices.dismiss(initial.id)
  await watch.check()
  expect(notices.snapshot().records[0]).toBe(initial)
  expect(notices.snapshot().floating).toHaveLength(0)
  expect(appServer.writeConfigValue).not.toHaveBeenCalled()
  vi.mocked(appServer.readConfig).mockResolvedValue(config('openai'))
  await watch.check()
  expect(notices.snapshot().records[0].resolved).toBe(true)
  vi.mocked(appServer.readConfig).mockResolvedValue(config('custom'))
  await watch.check()
  expect(notices.snapshot().records[0].resolved).not.toBe(true)
  expect(notices.snapshot().floating).toHaveLength(1)
})

it('writes only model_provider on recovery, then verifies the effective config', async () => {
  const notices = store()
  const watch = createCodexProviderWatch(appServer, notices)
  vi.mocked(appServer.readConfig).mockResolvedValueOnce(config('custom')).mockResolvedValue(config('openai'))
  await watch.restore()
  expect(appServer.writeConfigValue).toHaveBeenCalledExactlyOnceWith('model_provider', 'openai')
  expect(appServer.readConfig).toHaveBeenCalledTimes(2)
  expect(notices.snapshot().records.some((n) => n.id === 'codex-provider:restored')).toBe(true)
})

it.each([undefined, 'openai', 'azure'])('rechecks before acting on a stale alert for %s', async (provider) => {
  const notices = store()
  vi.mocked(appServer.readConfig).mockResolvedValue(config(provider))
  await createCodexProviderWatch(appServer, notices).restore()
  expect(appServer.writeConfigValue).not.toHaveBeenCalled()
  expect(notices.snapshot().records[0].level).toBe(provider === 'azure' ? 'error' : 'info')
})

it('does not report success when write verification fails', async () => {
  const notices = store()
  vi.mocked(appServer.readConfig).mockResolvedValue(config('custom'))
  await createCodexProviderWatch(appServer, notices).restore()
  expect(notices.snapshot().records[0]).toMatchObject({ id: 'codex-provider:restore-error', level: 'error' })
})

it('retries read failures without writing or treating failure as healthy', async () => {
  const notices = store()
  const watch = createCodexProviderWatch(appServer, notices)
  vi.mocked(appServer.readConfig).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(config('custom'))
  await watch.check()
  expect(notices.snapshot().records[0].id).toBe('codex-provider:check-error')
  await watch.check()
  expect(notices.snapshot().records.find((n) => n.id === 'codex-provider:check-error')?.resolved).toBe(true)
  expect(notices.snapshot().records.find((n) => n.id === 'codex-provider:custom')?.state).toBe('pending')
  expect(appServer.writeConfigValue).not.toHaveBeenCalled()
})

it('shares recovery across repeated clicks and prevents polling during the write', async () => {
  let complete!: () => void
  vi.mocked(appServer.writeConfigValue).mockImplementation(() => new Promise((resolve) => { complete = resolve }))
  vi.mocked(appServer.readConfig).mockResolvedValueOnce(config('custom')).mockResolvedValue(config('openai'))
  const watch = createCodexProviderWatch(appServer, store())
  const first = watch.restore()
  expect(watch.restore()).toBe(first)
  expect(watch.check()).toBe(first)
  await vi.waitFor(() => expect(appServer.writeConfigValue).toHaveBeenCalledTimes(1))
  complete()
  await first
  expect(appServer.readConfig).toHaveBeenCalledTimes(2)
})

it('retains the recovery action after a failed write', async () => {
  const notices = store()
  vi.mocked(appServer.readConfig).mockResolvedValue(config('custom'))
  vi.mocked(appServer.writeConfigValue).mockRejectedValue(new Error('disk full'))
  await createCodexProviderWatch(appServer, notices).restore()
  expect(notices.snapshot().records[0]).toMatchObject({ level: 'error', actions: [{ kind: 'codex-provider-restore', target: 'openai', label: '改回 OpenAI' }] })
  expect(notices.snapshot().records.some((n) => n.id === 'codex-provider:restored')).toBe(false)
})
