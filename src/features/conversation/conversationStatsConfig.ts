import type { Thread, ThreadCreditUsage, ThreadItemEntry, ThreadTokenUsage, Turn, TurnPlanStep, Workspace } from '../../core/domain/codex'
import { formatDuration } from '../../core/domain/format'

export type ConversationStatId =
  | 'activity'
  | 'tokenSummary'
  | 'latestTurnDuration'
  | 'toolDuration'
  | 'cacheHitRate'
  | 'inputOutputTokens'
  | 'contextUsage'
  | 'cachedInputTokens'
  | 'cacheWriteTokens'
  | 'reasoningOutputTokens'
  | 'totalTurnDuration'
  | 'projectName'
  | 'gitBranch'
  | 'runState'
  | 'taskProgress'
  | 'usedTokens'
  | 'credits'
  | 'usd'

export interface ConversationStatPreference {
  id: ConversationStatId
  visible: boolean
}

export interface ConversationStatsPreferences {
  items: ConversationStatPreference[]
}

export interface ConversationStatsData {
  turns: Turn[]
  items: ThreadItemEntry[]
  tokenUsage: ThreadTokenUsage | null
  costUsd?: number | null
  creditUsage: ThreadCreditUsage | null
  thread: Thread | null
  workspace: Workspace | null
  taskPlan: TurnPlanStep[] | null
}

export interface ConversationStatDefinition {
  id: ConversationStatId
  name: string
  description: string
  defaultVisible: boolean
}

export interface ConversationStatSegment {
  id: ConversationStatId
  text: string
  title?: string
}

export const CONVERSATION_STAT_DEFINITIONS: ConversationStatDefinition[] = [
  { id: 'activity', name: '已加载活动', description: '当前已加载的会话轮数与工具步骤数', defaultVisible: true },
  { id: 'tokenSummary', name: 'Token 总览', description: '会话累计 token 与最近一轮 token', defaultVisible: true },
  { id: 'latestTurnDuration', name: '本轮耗时', description: '最近一轮从开始到完成的耗时', defaultVisible: true },
  { id: 'toolDuration', name: '工具耗时', description: '已加载工具调用的累计执行耗时', defaultVisible: true },
  { id: 'cacheHitRate', name: '缓存命中率', description: '缓存输入 token 占全部输入 token 的比例', defaultVisible: true },
  { id: 'inputOutputTokens', name: '输入 / 输出', description: '会话累计输入与输出 token', defaultVisible: true },
  { id: 'contextUsage', name: '上下文占用', description: '最近一轮 token 相对模型上下文窗口的占用', defaultVisible: false },
  { id: 'cachedInputTokens', name: '缓存输入', description: '会话累计命中的缓存输入 token', defaultVisible: false },
  { id: 'cacheWriteTokens', name: '缓存写入', description: '会话累计写入缓存的输入 token', defaultVisible: false },
  { id: 'reasoningOutputTokens', name: '推理输出', description: '会话累计用于推理的输出 token', defaultVisible: false },
  { id: 'totalTurnDuration', name: '累计回合耗时', description: '已加载且有耗时数据的回合总耗时', defaultVisible: false },
  { id: 'projectName', name: '项目名', description: '当前会话所属的 Harness Git workspace 名称', defaultVisible: false },
  { id: 'gitBranch', name: 'Git 分支', description: 'App Server 会话元数据中的当前 Git 分支', defaultVisible: false },
  { id: 'runState', name: '运行状态', description: 'App Server 会话状态，包括就绪、工作中、等待操作和错误', defaultVisible: false },
  { id: 'taskProgress', name: '任务进度', description: 'App Server 最近一次 turn/plan/updated 通知中的计划进度', defaultVisible: false },
  { id: 'usedTokens', name: '已用 Token', description: 'App Server 返回的会话累计 token 数', defaultVisible: false },
  { id: 'credits', name: 'Credits', description: '账户接口返回的会话预估 credit 消耗', defaultVisible: true },
  { id: 'usd', name: '预估费用', description: '账户接口返回的会话预估美元费用', defaultVisible: false },
]

const definitionById = new Map(CONVERSATION_STAT_DEFINITIONS.map((definition) => [definition.id, definition]))
const toolItemTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange'])

export function defaultConversationStatsPreferences(): ConversationStatsPreferences {
  return {
    items: CONVERSATION_STAT_DEFINITIONS.map(({ id, defaultVisible }) => ({ id, visible: defaultVisible })),
  }
}

export function normalizeConversationStatsPreferences(value: unknown): ConversationStatsPreferences {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { items?: unknown }).items)) {
    return defaultConversationStatsPreferences()
  }
  const saved = (value as { items: unknown[] }).items
  const seen = new Set<ConversationStatId>()
  const items: ConversationStatPreference[] = []
  for (const candidate of saved) {
    if (!candidate || typeof candidate !== 'object') continue
    const id = (candidate as { id?: unknown }).id
    if (typeof id !== 'string' || !definitionById.has(id as ConversationStatId) || seen.has(id as ConversationStatId)) continue
    seen.add(id as ConversationStatId)
    items.push({ id: id as ConversationStatId, visible: (candidate as { visible?: unknown }).visible === true })
  }
  for (const definition of CONVERSATION_STAT_DEFINITIONS) {
    if (!seen.has(definition.id)) items.push({ id: definition.id, visible: definition.defaultVisible })
  }
  return { items }
}

export function conversationStatDefinition(id: ConversationStatId): ConversationStatDefinition {
  return definitionById.get(id)!
}

export function conversationStatSegments(preferences: ConversationStatsPreferences, data: ConversationStatsData): ConversationStatSegment[] {
  if (!hasConversationActivity(data)) return []
  const toolItems = data.items.filter((entry) => toolItemTypes.has(entry.item.type))
  const toolDuration = sumDurations(toolItems.map((entry) => entry.item.durationMs))
  const totalTurnDuration = sumDurations(data.turns.map((turn) => turn.durationMs))
  const latestTurn = data.turns.at(-1) ?? null
  const total = data.tokenUsage?.total ?? null
  const last = data.tokenUsage?.last ?? null
  const contextWindow = data.tokenUsage?.modelContextWindow ?? null

  return preferences.items.flatMap((preference): ConversationStatSegment[] => {
    if (!preference.visible) return []
    switch (preference.id) {
      case 'activity':
        return data.turns.length > 0 || toolItems.length > 0
          ? [{ id: preference.id, text: `已加载 ${data.turns.length} 轮 · ${toolItems.length} 步` }]
          : []
      case 'tokenSummary':
        return total && last && (total.totalTokens > 0 || last.totalTokens > 0)
          ? [{ id: preference.id, text: `Tokens ${formatTokens(total.totalTokens)} / ${formatTokens(last.totalTokens)}` }]
          : []
      case 'latestTurnDuration':
        return latestTurn?.durationMs !== null && latestTurn?.durationMs !== undefined
          ? [{ id: preference.id, text: `本轮 ${formatDuration(latestTurn.durationMs)}` }]
          : []
      case 'toolDuration':
        return toolDuration > 0 ? [{ id: preference.id, text: `工具调用 ${formatDuration(toolDuration)}` }] : []
      case 'cacheHitRate':
        return total && total.inputTokens > 0
          ? [{ id: preference.id, text: `缓存命中 ${Math.round(Math.min(1, total.cachedInputTokens / total.inputTokens) * 100)}%` }]
          : []
      case 'inputOutputTokens':
        return total && (total.inputTokens > 0 || total.outputTokens > 0)
          ? [{ id: preference.id, text: `输入 ${formatTokens(total.inputTokens)} tok · 输出 ${formatTokens(total.outputTokens)} tok` }]
          : []
      case 'contextUsage': {
        if (!last || !contextWindow) return []
        const percent = Math.round(Math.min(100, Math.max(0, last.totalTokens / contextWindow * 100)))
        return [{ id: preference.id, text: `上下文 ${formatTokens(last.totalTokens)} / ${formatTokens(contextWindow)} · ${percent}%` }]
      }
      case 'cachedInputTokens':
        return total && total.cachedInputTokens > 0 ? [{ id: preference.id, text: `缓存输入 ${formatTokens(total.cachedInputTokens)} tok` }] : []
      case 'cacheWriteTokens':
        return total && total.cacheWriteInputTokens > 0 ? [{ id: preference.id, text: `缓存写入 ${formatTokens(total.cacheWriteInputTokens)} tok` }] : []
      case 'reasoningOutputTokens':
        return total && total.reasoningOutputTokens > 0 ? [{ id: preference.id, text: `推理输出 ${formatTokens(total.reasoningOutputTokens)} tok` }] : []
      case 'totalTurnDuration':
        return totalTurnDuration > 0 ? [{ id: preference.id, text: `累计回合 ${formatDuration(totalTurnDuration)}` }] : []
      case 'projectName':
        return data.workspace?.name ? [{ id: preference.id, text: `项目 ${data.workspace.name}` }] : []
      case 'gitBranch': {
        const branch = data.thread?.gitInfo?.branch ?? data.workspace?.branch
        return branch ? [{ id: preference.id, text: `分支 ${branch}` }] : []
      }
      case 'runState':
        return data.thread ? [{ id: preference.id, text: `状态 ${runStateLabel(data.thread.status)}` }] : []
      case 'taskProgress': {
        const plan = data.taskPlan
        if (!plan?.length) return []
        const completed = plan.filter((step) => step.status === 'completed').length
        const current = plan.find((step) => step.status === 'inProgress')?.step
        return [{ id: preference.id, text: `任务 ${completed}/${plan.length}${current ? ` · ${current}` : ''}` }]
      }
      case 'usedTokens':
        return total && total.totalTokens > 0 ? [{ id: preference.id, text: `已用 ${formatTokens(total.totalTokens)} tok` }] : []
      case 'credits':
        return data.creditUsage ? [{ id: preference.id, text: `${formatCredits(data.creditUsage.creditsMicros)} credits` }] : []
      case 'usd':
        return data.costUsd !== null && data.costUsd !== undefined
          ? [{ id: preference.id, text: `$${formatUsdDollars(data.costUsd)} USD` }]
          : data.creditUsage?.usdMicros !== null && data.creditUsage?.usdMicros !== undefined
            ? [{ id: preference.id, text: `$${formatUsd(data.creditUsage.usdMicros)} USD` }]
            : []
    }
  })
}

function hasConversationActivity(data: ConversationStatsData): boolean {
  return data.turns.length > 0
    || data.items.length > 0
    || (data.tokenUsage?.total.totalTokens ?? 0) > 0
}

function runStateLabel(status: Thread['status']): string {
  if (status.type === 'systemError') return '错误'
  if (status.type !== 'active') return '就绪'
  if (status.activeFlags.includes('waitingOnApproval') || status.activeFlags.includes('waitingOnUserInput')) return '等待操作'
  return '工作中'
}

function sumDurations(values: Array<number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0), 0)
}

function formatCredits(micros: number): string {
  const credits = micros / 1_000_000
  return credits.toLocaleString(undefined, { maximumFractionDigits: credits < 10 ? 3 : 2 })
}

function formatUsd(micros: number): string {
  return (micros / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function formatUsdDollars(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 100_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
