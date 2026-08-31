import { describe, expect, it } from 'vitest'
import type { TitleGeneratorState } from './titleGenerator'
import { reduceTitleGeneratorEvent } from './titleGenerator'

const state = (): TitleGeneratorState => ({
  targetThreadId: 'thread-1', attemptId: 'attempt-1', text: '', startedAt: 1,
})

describe('title generator event state', () => {
  it('accumulates streamed agent-message deltas', () => {
    const first = reduceTitleGeneratorEvent(state(), 'item/agentMessage/delta', { delta: '修复' })
    expect(first).toMatchObject({ kind: 'pending', state: { text: '修复' } })
    if (first.kind !== 'pending') throw new Error('expected pending state')
    expect(reduceTitleGeneratorEvent(first.state, 'item/agentMessage/delta', { delta: '登录' })).toMatchObject({
      kind: 'pending', state: { text: '修复登录' },
    })
  })

  it('uses the completed agent item as the authoritative text', () => {
    const current = { ...state(), text: 'streamed' }
    expect(reduceTitleGeneratorEvent(current, 'item/completed', {
      item: { type: 'agentMessage', text: '最终标题' },
    })).toMatchObject({ kind: 'pending', state: { text: '最终标题' } })
  })

  it('falls back to the completed turn and normalizes the generated title', () => {
    const result = reduceTitleGeneratorEvent(state(), 'turn/completed', {
      turn: {
        id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: '# 修复登录问题。' }],
        error: null, startedAt: 1, completedAt: 2, durationMs: 1,
      },
    })
    expect(result).toMatchObject({ kind: 'completed', generatedText: '# 修复登录问题。', title: '修复登录问题' })
  })

  it('completes safely when the turn payload is malformed', () => {
    expect(reduceTitleGeneratorEvent({ ...state(), text: '已有标题' }, 'turn/completed', {
      turn: { id: 'turn-1', status: 'unknown' },
    })).toMatchObject({ kind: 'completed', turn: null, title: '已有标题' })
  })
})
