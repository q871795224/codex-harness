import { describe, expect, it } from 'vitest'
import type { ThreadItemEntry } from '../../core/domain/codex'
import { emptyThreadDetail, textInput, type Thread } from '../../core/domain/codex'
import { asyncUserInputAnswer, asyncUserInputAnswered, asyncUserInputRequest, hasUnansweredAsyncInput } from './asyncUserInput'
import { parseUserInputQuestions } from './userInputRequest'

const item = {
  type: 'agentMessage', id: 'async-1', phase: 'final_answer' as const, delivery: 'async' as const,
  questions: [{ title: '如何分发？', options: ['安装包', '远程服务'] }, { title: '分发范围？', options: null }],
}

describe('async Codex questions', () => {
  it('keeps the waiting indicator only for unanswered questions in a live turn', () => {
    const detail = emptyThreadDetail({ id: 'thread-1' } as Thread)
    detail.items = [{ turnId: 'turn-1', item }]
    expect(hasUnansweredAsyncInput('thread-1', detail, 'turn-1')).toBe(true)
    expect(hasUnansweredAsyncInput('thread-1', detail, 'turn-2')).toBe(false)
    expect(hasUnansweredAsyncInput('thread-1', detail, undefined)).toBe(false)
    const answer = asyncUserInputAnswer(asyncUserInputRequest('thread-1', item)!, { answers: {} })
    expect(hasUnansweredAsyncInput('thread-1', detail, 'turn-1', [{ clientUserMessageId: 'answer', text: answer, input: [textInput(answer)], createdAt: 1 }])).toBe(false)
    detail.items.push({ turnId: 'turn-1', item: { type: 'userMessage', content: [textInput(answer)] } })
    expect(hasUnansweredAsyncInput('thread-1', detail, 'turn-1')).toBe(false)
    detail.items.pop()
    detail.turns = [{ id: 'turn-1', status: 'completed', items: [item], error: null, startedAt: null, completedAt: null, durationMs: null }]
    expect(hasUnansweredAsyncInput('thread-1', detail, 'turn-1')).toBe(false)
  })
  it('adapts the protocol questions, including freeform questions, without selecting an answer', () => {
    const request = asyncUserInputRequest('thread-1', item)!
    expect(parseUserInputQuestions(request.params)).toMatchObject([
      { id: 'question-0', question: '如何分发？', options: [{ label: '安装包' }, { label: '远程服务' }], isOther: true },
      { id: 'question-1', question: '分发范围？', options: [], isOther: true },
    ])
    expect(asyncUserInputRequest('thread-1', { ...item, delivery: null })).toBeNull()
    expect(asyncUserInputRequest('thread-1', { ...item, questions: [] })).toBeNull()
  })

  it('sends readable question and answer pairs, and skips without inventing answers', () => {
    const request = asyncUserInputRequest('thread-1', item)!
    expect(asyncUserInputAnswer(request, { answers: {
      'question-0': { answers: ['远程服务'] }, 'question-1': { answers: ['本组'] },
    } })).toBe('问题：如何分发？\n回答：远程服务\n\n问题：分发范围？\n回答：本组')
    expect(asyncUserInputAnswer(request, { answers: {} })).toContain('回答：跳过，请继续。')
    expect(() => asyncUserInputAnswer(request, { answers: { 'question-0': { answers: ['安装包'] } } })).toThrow()
  })

  it('recognizes submitted answers in restored history but leaves unrelated follow-ups pending', () => {
    const request = asyncUserInputRequest('thread-1', item)!
    const message = (text: string): ThreadItemEntry => ({ turnId: 'next-turn', item: { type: 'userMessage', content: [textInput(text)] } })
    expect(asyncUserInputAnswered(request, [message('继续检查依赖')])).toBe(false)
    expect(asyncUserInputAnswered(request, [message(asyncUserInputAnswer(request, { answers: {} }))])).toBe(true)
    expect(asyncUserInputAnswered(request, [], [asyncUserInputAnswer(request, { answers: {} })])).toBe(true)
    expect(asyncUserInputAnswered(request, [], ['继续检查依赖'])).toBe(false)
  })
})
