import { useEffect, useState } from 'react'
import type { ThreadCreditUsage, ThreadTokenUsage, Turn } from '../../core/domain/codex'
import { formatDuration } from '../../core/domain/format'

interface ConversationStatsProps {
  turns: Turn[]
  tokenUsage: ThreadTokenUsage | null
  creditUsage: ThreadCreditUsage | null
}

export function WorkingStatus({ startedAt }: { startedAt: number | null }) {
  const [fallbackStartedAt] = useState(Date.now)
  const [now, setNow] = useState(Date.now)
  const startedAtMs = startedAt ? startedAt * 1_000 : fallbackStartedAt

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className="working-status" aria-label={`会话正在工作，已运行 ${formatWorkingElapsed(now - startedAtMs)}`}>
      <span className="working-status-dot" />
      <span className="working-status-label">Working</span>
      <span>({formatWorkingElapsed(now - startedAtMs)})</span>
    </div>
  )
}

export function ConversationStats({ turns, tokenUsage, creditUsage }: ConversationStatsProps) {
  const latestTurn = turns.at(-1) ?? null
  const segments: Array<{ text: string; title?: string }> = []

  if (tokenUsage && (tokenUsage.total.totalTokens > 0 || tokenUsage.last.totalTokens > 0)) {
    segments.push({ text: `Tokens ${formatTokens(tokenUsage.total.totalTokens)} / ${formatTokens(tokenUsage.last.totalTokens)}` })
  }
  if (latestTurn?.durationMs !== null && latestTurn?.durationMs !== undefined) {
    segments.push({ text: `本轮 ${formatDuration(latestTurn.durationMs)}` })
  }
  if (creditUsage) {
    segments.push({
      text: `${formatCredits(creditUsage.creditsMicros)} credits`,
      title: creditUsage.usdMicros === null ? undefined : `$${formatUsd(creditUsage.usdMicros)} USD`,
    })
  }

  if (segments.length === 0) return null
  return (
    <div className="conversation-stats">
      {segments.map((segment) => <span key={segment.text} title={segment.title}>{segment.text}</span>)}
    </div>
  )
}

function formatCredits(micros: number): string {
  const credits = micros / 1_000_000
  return credits.toLocaleString(undefined, { maximumFractionDigits: credits < 10 ? 3 : 2 })
}

function formatUsd(micros: number): string {
  return (micros / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 100_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

export function formatWorkingElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
