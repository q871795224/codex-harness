import { beforeEach, expect, it, vi } from 'vitest'
import { runtime } from './bridge'
import { appServer } from './appServerClient'
import { DEFAULT_HISTORY_SETTINGS, HISTORY_SETTINGS_KEY, loadHistorySettings, saveHistorySettings } from './historySettings'

vi.mock('./bridge', () => ({ runtime: { getAppState: vi.fn(), setAppState: vi.fn(), request: vi.fn() } }))
beforeEach(() => { vi.resetAllMocks(); vi.mocked(runtime.getAppState).mockResolvedValue(null) })

it('defaults to on-demand history and 256 MiB, and recovers invalid stored settings', async () => {
  expect(await loadHistorySettings()).toEqual(DEFAULT_HISTORY_SETTINGS)
  for (const raw of ['null', 'broken', '{"loading":"eager","maxResponseMiB":0}']) {
    vi.mocked(runtime.getAppState).mockResolvedValue(raw)
    expect(await loadHistorySettings()).toEqual(DEFAULT_HISTORY_SETTINGS)
  }
})

it('persists both choices and rejects invalid sizes before writing', async () => {
  const settings = { loading: 'eager' as const, maxResponseMiB: 250 }
  await saveHistorySettings(settings)
  expect(runtime.setAppState).toHaveBeenCalledWith(HISTORY_SETTINGS_KEY, JSON.stringify(settings))
  vi.mocked(runtime.setAppState).mockClear()
  for (const maxResponseMiB of [0, 15, 1025, 20.5, NaN]) await expect(saveHistorySettings({ ...settings, maxResponseMiB })).rejects.toThrow('16–1024')
  expect(runtime.setAppState).not.toHaveBeenCalled()
})

it('uses the selected mode for resume, archived history and older pages', async () => {
  const params = { threadId: 't', excludeTurns: true, initialTurnsPage: { limit: 5, sortDirection: 'desc', itemsView: 'full' } }
  for (const [loading, itemsView] of [['on-demand', 'summary'], ['eager', 'full']] as const) {
    vi.mocked(runtime.getAppState).mockResolvedValue(JSON.stringify({ loading, maxResponseMiB: 256 }))
    await appServer.resumeThread(params)
    expect(runtime.request).toHaveBeenLastCalledWith('thread/resume', { ...params, initialTurnsPage: { ...params.initialTurnsPage, itemsView } })
    await appServer.listConversationTurns({ threadId: 't', cursor: 'older', limit: 5 })
    expect(runtime.request).toHaveBeenLastCalledWith('thread/turns/list', { threadId: 't', cursor: 'older', limit: 5, itemsView })
  }
})
