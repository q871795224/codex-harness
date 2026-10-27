import { describe, expect, it } from 'vitest'
import type { Thread } from '../../core/domain/codex'
import { resolveThreadBadge } from './threadBadge'

function thread(status: Thread['status']): Thread {
  return { id: 'thread-1', status } as Thread
}

describe('resolveThreadBadge', () => {
  it('shows questions and approvals ahead of running status until they are handled', () => {
    const active = thread({ type: 'active', activeFlags: [] })
    expect(resolveThreadBadge(active, null, true, true)).toBe('approval')
    expect(resolveThreadBadge(thread({ type: 'idle' }), null, false, true)).toBe('approval')
    expect(resolveThreadBadge(active, 'approval', true, false)).toBe('working')
    expect(resolveThreadBadge(thread({ type: 'active', activeFlags: ['waitingOnUserInput'] }), null)).toBe('approval')
  })
  it('uses the live active status instead of a persisted unread badge', () => {
    expect(resolveThreadBadge(thread({ type: 'active', activeFlags: [] }), 'success')).toBe('working')
    expect(resolveThreadBadge(thread({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'working')).toBe('approval')
  })

  it('uses the live turn state when thread metadata has not caught up', () => {
    expect(resolveThreadBadge(thread({ type: 'idle' }), null, true)).toBe('working')
  })

  it('drops stale transient badges after the thread becomes idle', () => {
    expect(resolveThreadBadge(thread({ type: 'idle' }), 'working')).toBeNull()
    expect(resolveThreadBadge(thread({ type: 'idle' }), 'approval')).toBeNull()
  })

  it('keeps persisted terminal unread badges', () => {
    expect(resolveThreadBadge(thread({ type: 'idle' }), 'success')).toBe('success')
    expect(resolveThreadBadge(thread({ type: 'idle' }), 'error')).toBe('error')
  })
})
