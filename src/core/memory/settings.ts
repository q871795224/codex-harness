import { runtime } from '../runtime/bridge'
import { MEMORY_INSTRUCTIONS } from './extraction'

export interface MemorySettings {
  model: string
  effort: string
  prompt: string
  maxTurns: number
  budgetPercent: number
  /** 0 follows workspace configuration, falling back to 150,000. */
  contextWindowTokens: number
}
export const MEMORY_SETTINGS_KEY = 'memory.settings.v1'
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  model: '', effort: 'low', prompt: MEMORY_INSTRUCTIONS,
  maxTurns: 0, budgetPercent: 70, contextWindowTokens: 0,
}

export function validateMemorySettings(value: MemorySettings): MemorySettings {
  if (typeof value.model !== 'string' || typeof value.effort !== 'string') throw new Error('模型或推理强度无效')
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 100_000) throw new Error('提示词不能为空，且不能超过 100,000 字符')
  if (!Number.isInteger(value.maxTurns) || value.maxTurns < 0 || value.maxTurns > 10_000) throw new Error('上下文轮数须为 0–10,000 的整数')
  if (!Number.isInteger(value.budgetPercent) || value.budgetPercent < 1 || value.budgetPercent > 100) throw new Error('上下文预算须为 1–100 的整数')
  if (!Number.isInteger(value.contextWindowTokens) || (value.contextWindowTokens !== 0 && (value.contextWindowTokens < 1024 || value.contextWindowTokens > 10_000_000))) throw new Error('上下文窗口须为 0，或 1,024–10,000,000 的整数')
  return { ...value, model: value.model.trim(), effort: value.effort.trim(), prompt: value.prompt.trim() }
}

export async function loadMemorySettings(): Promise<MemorySettings> {
  const stored = await runtime.getAppState(MEMORY_SETTINGS_KEY)
  if (!stored) return { ...DEFAULT_MEMORY_SETTINGS }
  let value: unknown
  try { value = JSON.parse(stored) } catch { throw new Error('记忆设置读取失败：保存的配置格式无效') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('记忆设置格式无效')
  return validateMemorySettings({ ...DEFAULT_MEMORY_SETTINGS, ...value })
}
export async function saveMemorySettings(value: MemorySettings): Promise<MemorySettings> {
  const settings = validateMemorySettings(value)
  await runtime.setAppState(MEMORY_SETTINGS_KEY, JSON.stringify(settings))
  return settings
}
