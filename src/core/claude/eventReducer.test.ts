import { describe, expect, it } from 'vitest'
import { emptyThreadDetail, type Thread } from '../domain/codex'
import { reduceClaudeEvent } from './eventReducer'

const thread: Thread = {
  id: 'claude:1',
  provider: 'claude',
  preview: '',
  cwd: '/workspace',
  name: 'Claude 会话',
  createdAt: 1,
  updatedAt: 1,
  recencyAt: 1,
  status: { type: 'idle' },
  ephemeral: false,
  canAcceptDirectInput: true,
}

describe('Claude event reducer', () => {
  it('streams assistant text into one stable final item', () => {
    let detail = emptyThreadDetail(thread)
    detail = reduceClaudeEvent(detail, { method: 'turn/started', params: { sessionId: thread.id, turnId: 'turn-1' } })
    detail = reduceClaudeEvent(detail, { method: 'message/delta', params: { sessionId: thread.id, turnId: 'turn-1', itemId: 'assistant', delta: 'AIS_' } })
    detail = reduceClaudeEvent(detail, { method: 'message/delta', params: { sessionId: thread.id, turnId: 'turn-1', itemId: 'assistant', delta: 'OK' } })
    detail = reduceClaudeEvent(detail, { method: 'turn/completed', params: { sessionId: thread.id, turnId: 'turn-1' } })

    expect(detail.items).toHaveLength(1)
    expect(detail.items[0].item).toMatchObject({ type: 'agentMessage', text: 'AIS_OK', phase: 'final_answer' })
    expect(detail.turns[0].status).toBe('completed')
    expect(detail.activeTurnId).toBeNull()
  })

  it('maps Bash and file edits to existing activity cards', () => {
    let detail = emptyThreadDetail(thread)
    detail = reduceClaudeEvent(detail, { method: 'tool/started', params: { turnId: 'turn-1', itemId: 'bash-1', toolName: 'Bash', input: { command: 'pnpm test' } } })
    detail = reduceClaudeEvent(detail, { method: 'tool/started', params: { turnId: 'turn-1', itemId: 'edit-1', toolName: 'Edit', input: { file_path: '/workspace/a.ts' } } })
    expect(detail.items.map((entry) => entry.item.type)).toEqual(['commandExecution', 'fileChange'])
  })
})
