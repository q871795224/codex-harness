import { useSyncExternalStore } from 'react'
import { runtime } from '../runtime/bridge'
import { parseReplacement, type Replacement } from './engine'

export interface CorrectionSettings { enabled: boolean; quotes: boolean; rules: Replacement[] }
export const CORRECTION_KEY = 'input-correction.v1'
const defaults: CorrectionSettings = { enabled: true, quotes: true, rules: [] }
let snapshot = defaults
let loading: Promise<void> | undefined
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())
export function readCorrectionSettings(): CorrectionSettings {
  return { ...snapshot, rules: snapshot.rules.map(rule => ({ ...rule })) }
}
export function useCorrectionSettings() {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => snapshot)
}
export function loadCorrectionSettings(): Promise<void> {
  return loading ??= runtime.getAppState(CORRECTION_KEY).then((raw) => {
    if (raw) {
      const value = JSON.parse(raw) as CorrectionSettings
      if (!Array.isArray(value.rules)) throw new Error('纠错词库格式无效')
      snapshot = { enabled: value.enabled !== false, quotes: value.quotes !== false, rules: value.rules.map((rule) => parseReplacement(`${rule.from} → ${rule.to}`)) }
      emit()
    }
  }).catch((error) => { loading = undefined; throw error })
}
export async function saveCorrectionSettings(settings: CorrectionSettings): Promise<void> {
  const rules = settings.rules.map((rule) => parseReplacement(`${rule.from} → ${rule.to}`))
  if (new Set(rules.map((rule) => rule.from)).size !== rules.length) throw new Error('同一个原词只能有一条替换规则')
  const next = { ...settings, rules }
  await runtime.setAppState(CORRECTION_KEY, JSON.stringify(next))
  snapshot = next
  emit()
}
export async function addReplacement(value: string): Promise<void> {
  await loadCorrectionSettings()
  const rule = parseReplacement(value)
  await saveCorrectionSettings({ ...snapshot, rules: [...snapshot.rules.filter((entry) => entry.from !== rule.from), rule] })
}
