import type { ThreadItemEntry, ThreadTokenUsage, Turn } from '../../core/domain/codex'
import { formatDuration } from '../../core/domain/format'

interface ConversationStatsProps {
  turns: Turn[]
  items: ThreadItemEntry[]
  tokenUsage: ThreadTokenUsage | null
}

const toolItemTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange'])

export function ConversationStats({ turns, items, tokenUsage }: ConversationStatsProps) {
  const toolItems = items.filter((entry) => toolItemTypes.has(entry.item.type))
  const toolDuration = toolItems.reduce((total, entry) => {
    const duration = entry.item.durationMs
    return total + (typeof duration === 'number' && Number.isFinite(duration) ? Math.max(0, duration) : 0)
  }, 0)
  const segments: string[] = []

  if (turns.length > 0 || toolItems.length > 0) segments.push(`已加载 ${turns.length} 轮 · ${toolItems.length} 步`)
  if (toolDuration > 0) segments.push(`工具调用 ${formatDuration(toolDuration)}`)

  if (tokenUsage) {
    const { inputTokens, cachedInputTokens, outputTokens } = tokenUsage.total
    if (inputTokens > 0) segments.push(`缓存命中 ${Math.round(Math.min(1, cachedInputTokens / inputTokens) * 100)}%`)
    if (inputTokens > 0 || outputTokens > 0) segments.push(`输入 ${formatTokens(inputTokens)} tok · 输出 ${formatTokens(outputTokens)} tok`)
  }

  if (segments.length === 0) return null
  return (
    <div
      className="conversation-stats"
      title="统计仅使用 App Server 已公开且已加载的数据；历史 LLM 耗时、首 token 耗时和输出速率目前没有可靠字段。"
    >
      {segments.map((segment) => <span key={segment}>{segment}</span>)}
    </div>
  )
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 100_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
