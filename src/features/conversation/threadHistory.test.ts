import { describe, expect, it } from 'vitest'
import { emptyThreadDetail, type Thread, type Turn } from '../../core/domain/codex'
import { prependOlderTurns } from './threadHistory'

const thread: Thread = {
  id: 'thread-1', cwd: '/repo', name: null, preview: '', ephemeral: false,
  createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: 'idle' }, canAcceptDirectInput: true,
}

function turn(id: string): Turn {
  return {
    id, status: 'completed', items: [{ id: `item-${id}`, type: 'agentMessage', text: id }],
    error: null, startedAt: 1, completedAt: 2, durationMs: 1,
  }
}

describe('older turn pagination', () => {
  it('reverses a descending server page before prepending it', () => {
    const currentTurn = turn('turn-3')
    const detail = {
      ...emptyThreadDetail(thread),
      turns: [currentTurn],
      items: [{ turnId: currentTurn.id, item: currentTurn.items[0] }],
      nextTurnsCursor: 'page-2',
    }

    const next = prependOlderTurns(detail, {
      data: [turn('turn-2'), turn('turn-1')],
      nextCursor: 'page-3',
    })

    expect(next.turns.map((item) => item.id)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    expect(next.items.map((entry) => entry.turnId)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    expect(next.nextTurnsCursor).toBe('page-3')
    expect(detail.turns).toEqual([currentTurn])
  })

  it('updates the cursor without changing history for an empty page', () => {
    const detail = emptyThreadDetail(thread)
    expect(prependOlderTurns(detail, { data: [], nextCursor: null })).toEqual({ ...detail, nextTurnsCursor: null })
  })
})
