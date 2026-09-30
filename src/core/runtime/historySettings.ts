import { runtime } from './bridge'

export interface HistorySettings {
  loading: 'on-demand' | 'eager'
  maxResponseMiB: number
}

export const HISTORY_SETTINGS_KEY = 'conversationHistoryPreferences'
export const DEFAULT_HISTORY_SETTINGS: HistorySettings = { loading: 'on-demand', maxResponseMiB: 256 }

export function validateHistorySettings(value: HistorySettings): HistorySettings {
  if (value.loading !== 'on-demand' && value.loading !== 'eager') throw new Error('请选择历史加载方式')
  if (!Number.isInteger(value.maxResponseMiB) || value.maxResponseMiB < 16 || value.maxResponseMiB > 1024) {
    throw new Error('响应上限须为 16–1024 MiB 的整数')
  }
  return { loading: value.loading, maxResponseMiB: value.maxResponseMiB }
}

export async function loadHistorySettings(): Promise<HistorySettings> {
  const raw = await runtime.getAppState(HISTORY_SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_HISTORY_SETTINGS }
  try { return validateHistorySettings(JSON.parse(raw) as HistorySettings) }
  catch { return { ...DEFAULT_HISTORY_SETTINGS } }
}

export async function saveHistorySettings(value: HistorySettings): Promise<HistorySettings> {
  const settings = validateHistorySettings(value)
  await runtime.setAppState(HISTORY_SETTINGS_KEY, JSON.stringify(settings))
  return settings
}

export async function historyItemsView(): Promise<'summary' | 'full'> {
  return (await loadHistorySettings()).loading === 'on-demand' ? 'summary' : 'full'
}
