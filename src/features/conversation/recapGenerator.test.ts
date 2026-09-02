import { describe, expect, it } from 'vitest'
import type { RecapGeneratorState, RecapHistoryMessage } from './recapGenerator'
import { parseGeneratedRecap, recapPrompt, RECAP_TEXT_MAX_CHARS, reduceRecapGeneratorEvent } from './recapGenerator'

const state = (): RecapGeneratorState => ({
  targetThreadId: 'thread-1', attemptId: 'attempt-1', text: '', startedAt: 1,
})

describe('recap generator event state', () => {
  it('accumulates streamed agent-message deltas', () => {
    const first = reduceRecapGeneratorEvent(state(), 'item/agentMessage/delta', { delta: '正在' })
    expect(first).toMatchObject({ kind: 'pending', state: { text: '正在' } })
    if (first.kind !== 'pending') throw new Error('expected pending state')
    expect(reduceRecapGeneratorEvent(first.state, 'item/agentMessage/delta', { delta: '修复' })).toMatchObject({
      kind: 'pending', state: { text: '正在修复' },
    })
  })

  it('uses the completed agent item as the authoritative text', () => {
    const current = { ...state(), text: 'streamed' }
    expect(reduceRecapGeneratorEvent(current, 'item/completed', {
      item: { type: 'agentMessage', text: '最终回顾' },
    })).toMatchObject({ kind: 'pending', state: { text: '最终回顾' } })
  })

  it('falls back to the completed turn and returns the recap', () => {
    const result = reduceRecapGeneratorEvent(state(), 'turn/completed', {
      turn: {
        id: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', text: '正在实现登录功能。' }],
        error: null, startedAt: 1, completedAt: 2, durationMs: 1,
      },
    })
    expect(result).toMatchObject({ kind: 'completed', generatedText: '正在实现登录功能。', recap: '正在实现登录功能。' })
  })

  it('returns null recap when nothing was generated', () => {
    expect(reduceRecapGeneratorEvent(state(), 'turn/completed', {
      turn: { id: 'turn-1', status: 'unknown' },
    })).toMatchObject({ kind: 'completed', recap: null })
  })
})

describe('parseGeneratedRecap', () => {
  it('trims and caps the recap length', () => {
    expect(parseGeneratedRecap('  简短回顾。  ')).toBe('简短回顾。')
    const long = 'x'.repeat(RECAP_TEXT_MAX_CHARS + 50)
    expect(parseGeneratedRecap(long)).toHaveLength(RECAP_TEXT_MAX_CHARS)
  })

  it('rejects empty text', () => {
    expect(parseGeneratedRecap('   ')).toBeNull()
  })
})

describe('recapPrompt', () => {
  const messages: RecapHistoryMessage[] = [
    { role: 'User', content: '修复登录 bug' },
    { role: 'Assistant', content: '我先看认证模块。' },
    { role: 'User', content: '顺便加上单测。' },
  ]

  it('labels roles and keeps the behavior prompt first', () => {
    const prompt = recapPrompt('Write a brief catch-up.', messages)
    expect(prompt.startsWith('Write a brief catch-up.')).toBe(true)
    expect(prompt).toContain('User: 修复登录 bug')
    expect(prompt).toContain('Assistant: 我先看认证模块。')
  })

  it('always keeps the latest user message within budget', () => {
    const huge: RecapHistoryMessage[] = [
      { role: 'Assistant', content: 'y'.repeat(10_000) },
      { role: 'User', content: '最后的请求' },
    ]
    const prompt = recapPrompt('behavior', huge)
    expect(prompt).toContain('User: 最后的请求')
  })
})
