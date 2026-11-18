import { needsAttention, notificationAttention, type AppNotification } from '../notifications/store'
import type { DesktopPetActivity } from './types'

function status(record: AppNotification): 'waiting' | 'failed' | 'ready' | null {
  if (record.level === 'error') return 'failed'
  if (notificationAttention(record) === 'action' && record.state === 'pending') return 'waiting'
  if (record.watchThread && record.state === 'done') return 'ready'
  return null
}

const priority = { waiting: 0, failed: 1, ready: 2 }

export function desktopPetActivity(records: AppNotification[], working: boolean, now = Date.now()): DesktopPetActivity {
  const attention = records.flatMap(record => {
    if (!needsAttention(record, now)) return []
    const kind = status(record)
    return kind ? [{ record, kind }] : []
  }).sort((a, b) => priority[a.kind] - priority[b.kind] || b.record.updatedAt - a.record.updatedAt)

  const current = attention[0]
  return {
    status: current?.kind ?? (working ? 'running' : 'idle'),
    count: new Set(attention.map(({ record }) => record.threadId ?? record.id)).size,
    threadId: current?.record.threadId ?? null,
    notificationId: current?.record.id ?? null,
  }
}
