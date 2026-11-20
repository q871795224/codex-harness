// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { appServer } from '../../core/runtime/appServerClient'
import { createNotificationStore } from '../../core/notifications/store'
import { createCodexProviderRecovery, retireProviderCheckNotices, useCodexProviderRecovery } from './useCodexProviderRecovery'

vi.mock('../../core/runtime/appServerClient', () => ({ appServer: { readConfig: vi.fn(), writeConfigValue: vi.fn() } }))
vi.mock('../../core/notifications/service', async () => {
  const { createNotificationStore } = await import('../../core/notifications/store')
  return { notifications: createNotificationStore({ load: async () => null, save: async () => undefined }) }
})
const config = (provider?: string) => ({ config: { model_provider: provider, model: 'fixture', model_reasoning_effort: null, approval_policy: null } })
const store = () => createNotificationStore({ load: async () => null, save: async () => undefined })
beforeEach(() => { vi.resetAllMocks(); vi.mocked(appServer.readConfig).mockResolvedValue(config('openai')) })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('never polls or warns for custom providers, including after remount', async () => {
  vi.useFakeTimers()
  vi.mocked(appServer.readConfig).mockResolvedValue(config('custom'))
  const first = renderHook(() => useCodexProviderRecovery(true))
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
  first.unmount()
  renderHook(() => useCodexProviderRecovery(true))
  await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
  expect(appServer.readConfig).not.toHaveBeenCalled()
  expect(appServer.writeConfigValue).not.toHaveBeenCalled()
})

it('retires legacy automatic alerts while preserving other errors and pending business records', async () => {
  const notices = store()
  await notices.initialize()
  notices.publish({ id: 'codex-provider:custom', source: 'Codex 配置', title: 'custom', level: 'warning', state: 'pending' })
  notices.publish({ id: 'codex-provider:check-error', source: 'Codex 配置', title: '检查失败', level: 'warning' })
  notices.publish({ id: 'codex-provider:restore-error', source: 'Codex 配置', title: '恢复失败', level: 'error' })
  notices.publish({ id: 'attention:thread-a', source: '会话', title: '待回答', level: 'warning', state: 'pending' })
  const unaffected = notices.snapshot().records.filter(record => !['codex-provider:custom', 'codex-provider:check-error'].includes(record.id))
  await retireProviderCheckNotices(notices)
  await retireProviderCheckNotices(notices)
  for (const id of ['codex-provider:custom', 'codex-provider:check-error']) {
    expect(notices.snapshot().records.find(record => record.id === id)).toMatchObject({ resolved: true, read: true, state: 'done' })
  }
  expect(notices.snapshot().records.filter(record => !['codex-provider:custom', 'codex-provider:check-error'].includes(record.id))).toEqual(unaffected)
  expect(appServer.readConfig).not.toHaveBeenCalled()
  expect(appServer.writeConfigValue).not.toHaveBeenCalled()
})

it('writes only model_provider on recovery, then verifies the effective config', async () => {
  const notices = store()
  const restore = createCodexProviderRecovery(appServer, notices)
  vi.mocked(appServer.readConfig).mockResolvedValueOnce(config('custom')).mockResolvedValue(config('openai'))
  await restore()
  expect(appServer.writeConfigValue).toHaveBeenCalledExactlyOnceWith('model_provider', 'openai')
  expect(appServer.readConfig).toHaveBeenCalledTimes(2)
  expect(notices.snapshot().records.some((n) => n.id === 'codex-provider:restored')).toBe(true)
})

it.each([undefined, 'openai', 'azure'])('rechecks before acting on a stale alert for %s', async (provider) => {
  const notices = store()
  vi.mocked(appServer.readConfig).mockResolvedValue(config(provider))
  await createCodexProviderRecovery(appServer, notices)()
  expect(appServer.writeConfigValue).not.toHaveBeenCalled()
  expect(notices.snapshot().records[0].level).toBe(provider === 'azure' ? 'error' : 'info')
})

it('does not report success when write verification fails', async () => {
  const notices = store()
  vi.mocked(appServer.readConfig).mockResolvedValue(config('custom'))
  await createCodexProviderRecovery(appServer, notices)()
  expect(notices.snapshot().records[0]).toMatchObject({ id: 'codex-provider:restore-error', level: 'error' })
})

it('shares recovery across repeated explicit clicks', async () => {
  let complete!: () => void
  vi.mocked(appServer.writeConfigValue).mockImplementation(() => new Promise((resolve) => { complete = resolve }))
  vi.mocked(appServer.readConfig).mockResolvedValueOnce(config('custom')).mockResolvedValue(config('openai'))
  const restore = createCodexProviderRecovery(appServer, store())
  const first = restore()
  expect(restore()).toBe(first)
  await vi.waitFor(() => expect(appServer.writeConfigValue).toHaveBeenCalledTimes(1))
  complete()
  await first
  expect(appServer.readConfig).toHaveBeenCalledTimes(2)
})

it('retains the recovery action after a failed write', async () => {
  const notices = store()
  vi.mocked(appServer.readConfig).mockResolvedValue(config('custom'))
  vi.mocked(appServer.writeConfigValue).mockRejectedValue(new Error('disk full'))
  await createCodexProviderRecovery(appServer, notices)()
  expect(notices.snapshot().records[0]).toMatchObject({ level: 'error', actions: [{ kind: 'codex-provider-restore', target: 'openai', label: '改回 OpenAI' }] })
  expect(notices.snapshot().records.some((n) => n.id === 'codex-provider:restored')).toBe(false)
})
