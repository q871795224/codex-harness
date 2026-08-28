import { describe, expect, it } from 'vitest'
import type { Thread } from '../../core/domain/codex'
import { resolveThreadBadge } from './threadBadge'

function thread(status: Thread['status']): Thread {
  return { id: 'thread-1', status } as Thread
}

describe('resolveThreadBadge', () => {
  it('uses the live active status instead of a persisted unread badge', () => {
    expect(resolveThreadBadge(thread({ type: 'active', activeFlags: [] }), 'success')).toBe('working')
    expect(resolveThreadBadge(thread({ type: 'active', activeFlags: ['waitingOnApproval'] }), 'working')).toBe('approval')
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
