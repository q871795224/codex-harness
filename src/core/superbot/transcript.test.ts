import { describe, expect, it } from 'vitest'
import { superbotTranscript } from './transcript'
import type { SuperbotSnapshot } from './types'
const snapshot = (values: Partial<SuperbotSnapshot>): SuperbotSnapshot => ({ session: {} as SuperbotSnapshot['session'], page: { messages: [], has_more: false, next_cursor: null }, pending: {}, events: [], ...values })
describe('Superbot shared transcript adapter', () => {
  it('groups user and final messages using remote task IDs, preserving repeated messages', () => {
    const result = superbotTranscript(snapshot({ page: { has_more: false, next_cursor: null, messages: [
      { id: 'u1', role: 'user', content: 'repeat', task_id: 't1', created_at: '2026-11-17T08:00:00Z' },
      { id: 'a1', role: 'assistant', content: 'answer', task_id: 't1', created_at: '2026-11-17T08:00:01Z' },
      { id: 'u2', role: 'user', content: 'repeat', task_id: 't2', task_status: 'failed', failure_reason: 'remote error', created_at: '2026-11-17T08:01:00Z' },
    ] } }))
    expect(result.turns.map(t => t.id)).toEqual(['t1', 't2'])
    expect(result.items.map(e => e.item.type)).toEqual(['userMessage', 'agentMessage', 'userMessage'])
    expect(result.turns[0].items[1]).toMatchObject({ text: 'answer', phase: 'final_answer' })
    expect(result.turns[1]).toMatchObject({ status: 'failed', error: { message: 'remote error' } })
  })
  it('maps active tool calls and results into the shared execution process', () => {
    const result = superbotTranscript(snapshot({ pending: { task_id: 'active' }, events: [
      { seq: 1, call_id: 'call', type: 'tool_use', tool: 'Bash', input: { command: 'pwd' } },
      { seq: 2, call_id: 'call', type: 'tool_result', output: 'remote path' },
    ] }))
    expect(result.activeTurnId).toBe('active')
    expect(result.turns[0].status).toBe('inProgress')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].item).toMatchObject({ type: 'dynamicToolCall', tool: 'Bash', status: 'completed', arguments: { command: 'pwd' }, contentItems: 'remote path' })
  })
})
