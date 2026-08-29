import { useEffect, useState } from 'react'
import type { ConversationStatsData, ConversationStatsPreferences } from './conversationStatsConfig'
import { conversationStatSegments } from './conversationStatsConfig'

interface ConversationStatsProps extends ConversationStatsData {
  preferences: ConversationStatsPreferences
  emptyLabel?: string
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

export function ConversationStats({ turns, items, tokenUsage, creditUsage, thread, workspace, taskPlan, preferences, emptyLabel }: ConversationStatsProps) {
  const segments = conversationStatSegments(preferences, { turns, items, tokenUsage, creditUsage, thread, workspace, taskPlan })
  if (segments.length === 0) return emptyLabel ? <div className="conversation-stats empty">{emptyLabel}</div> : null
  return (
    <div className="conversation-stats">
      {segments.map((segment) => <span key={segment.id} title={segment.title}>{segment.text}</span>)}
    </div>
  )
}

export function formatWorkingElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}
