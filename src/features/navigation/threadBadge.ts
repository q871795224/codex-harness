import type { Badge, Thread } from '../../core/domain/codex'

export function activityBadge(thread: Thread): Badge {
  if (thread.status.type === 'systemError') return 'error'
  if (thread.status.type === 'active' && thread.status.activeFlags.includes('waitingOnApproval')) return 'approval'
  if (thread.status.type === 'active') return 'working'
  return null
}

export function resolveThreadBadge(thread: Thread, savedBadge: Badge): Badge {
  const activity = activityBadge(thread)
  if (activity) return activity
  return savedBadge === 'working' || savedBadge === 'approval' ? null : savedBadge
}
