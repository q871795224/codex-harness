import type { Badge, Thread } from '../../core/domain/codex'

export function activityBadge(thread: Thread): Badge {
  if (thread.status.type === 'systemError') return 'error'
  if (thread.status.type === 'active' && thread.status.activeFlags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput')) return 'approval'
  if (thread.status.type === 'active') return 'working'
  return null
}

export function resolveThreadBadge(thread: Thread, savedBadge: Badge, working = false, waiting = false): Badge {
  if (waiting) return 'approval'
  const activity = activityBadge(thread)
  if (activity) return activity
  if (working) return 'working'
  return savedBadge === 'working' || savedBadge === 'approval' ? null : savedBadge
}
