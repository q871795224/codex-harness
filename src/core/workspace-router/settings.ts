import { runtime } from '../runtime/bridge'

export interface RouterSettings {
  model: string
  effort: string
  descriptions: Record<string, string>
  tokenBudget?: number
  feedbackCount?: number
  feedbackRule?: 'relevant' | 'recent'
}
export const ROUTER_SETTINGS_KEY = 'workspace-router.settings.v1'
export const DEFAULT_ROUTER_SETTINGS: RouterSettings = { model: 'gpt-6.1-terra', effort: 'medium', descriptions: {}, tokenBudget: 8192, feedbackCount: 3, feedbackRule: 'relevant' }
export function validateRouterSettings(value: RouterSettings): RouterSettings {
  if (typeof value.model !== 'string' || !value.model.trim() || typeof value.effort !== 'string') throw new Error('请选择 Router 模型和推理强度')
  if (!value.descriptions || typeof value.descriptions !== 'object' || Array.isArray(value.descriptions)
    || Object.values(value.descriptions).some((text) => typeof text !== 'string' || text.length > 4000)) throw new Error('工作区用途说明不能超过 4,000 字符')
  const tokenBudget = value.tokenBudget ?? 8192
  if (!Number.isInteger(tokenBudget) || tokenBudget < 2048 || tokenBudget > 32768) throw new Error('Router文本预算应为2048–32768 tokens')
  const feedbackCount = value.feedbackCount ?? 3
  const feedbackRule = value.feedbackRule ?? 'relevant'
  if (!Number.isInteger(feedbackCount) || feedbackCount < 0 || feedbackCount > 10) throw new Error('纠错引用条数应为0–10')
  if (!['relevant', 'recent'].includes(feedbackRule)) throw new Error('请选择有效的纠错选取规则')
  return { tokenBudget, feedbackCount, feedbackRule, model: value.model.trim(), effort: value.effort.trim(), descriptions: { ...value.descriptions } }
}
export async function loadRouterSettings(): Promise<RouterSettings> {
  const stored = await runtime.getAppState(ROUTER_SETTINGS_KEY)
  return validateRouterSettings(stored ? { ...DEFAULT_ROUTER_SETTINGS, ...JSON.parse(stored) } : DEFAULT_ROUTER_SETTINGS)
}
export async function saveRouterSettings(value: RouterSettings): Promise<RouterSettings> {
  const settings = validateRouterSettings(value)
  await runtime.setAppState(ROUTER_SETTINGS_KEY, JSON.stringify(settings))
  return settings
}
