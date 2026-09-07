import { describe, expect, it } from 'vitest'
import { emptyThreadDetail, textInput, type Thread } from '../domain/codex'
import type { ClaudeSessionMessage } from './types'
import { hydrateClaudeHistory, mergeClaudeHistory } from './history'

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

function message(type: ClaudeSessionMessage['type'], uuid: string, content: unknown, timestamp: string): ClaudeSessionMessage {
  return {
    type,
    uuid,
    sessionId: 'provider-1',
    message: { role: type, content },
    parentToolUseId: null,
    timestamp,
  }
}

describe('Claude history hydration', () => {
  it('maps transcript messages into the existing conversation cards', () => {
    const history = hydrateClaudeHistory([
      message('user', 'user-1', '请运行测试', '2026-09-07T01:00:00.000Z'),
      message('assistant', 'assistant-1', [
        { type: 'thinking', thinking: '内部推理' },
        { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pnpm test' } },
        { type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '/workspace/a.ts' } },
      ], '2026-09-07T01:00:01.000Z'),
      message('user', 'tool-result-1', [
        { type: 'tool_result', tool_use_id: 'bash-1', content: 'passed' },
        { type: 'tool_result', tool_use_id: 'edit-1', is_error: true, content: 'denied' },
      ], '2026-09-07T01:00:02.000Z'),
      message('assistant', 'assistant-2', [{ type: 'text', text: '测试已完成。' }], '2026-09-07T01:00:03.000Z'),
      message('user', 'user-2', [{ type: 'text', text: '再总结一下' }], '2026-09-07T01:01:00.000Z'),
      message('assistant', 'assistant-3', [{ type: 'text', text: '总结如下。' }], '2026-09-07T01:01:01.000Z'),
    ])

    expect(history.turns).toHaveLength(2)
    expect(history.turns.map((turn) => turn.id)).toEqual(['claude-history:user-1', 'claude-history:user-2'])
    expect(history.items.filter((entry) => entry.item.type === 'userMessage')).toHaveLength(2)
    expect(history.items.find((entry) => entry.item.id === 'bash-1')?.item).toMatchObject({
      type: 'commandExecution',
      command: 'pnpm test',
      status: 'completed',
    })
    expect(history.items.find((entry) => entry.item.id === 'edit-1')?.item).toMatchObject({
      type: 'fileChange',
      status: 'failed',
    })
    expect(history.items.find((entry) => entry.item.type === 'agentMessage')?.item).toMatchObject({
      text: '测试已完成。',
      phase: 'final_answer',
    })
    expect(history.turns[0]).toMatchObject({
      status: 'completed',
      startedAt: Date.parse('2026-09-07T01:00:00.000Z'),
      completedAt: Date.parse('2026-09-07T01:00:03.000Z'),
      durationMs: 3_000,
    })
  })

  it('reuses the live turn id when the transcript contains its user prompt', () => {
    const history = hydrateClaudeHistory([
      message('user', 'user-1', '继续执行', '2026-09-07T01:00:00.000Z'),
      message('assistant', 'assistant-1', [{ type: 'text', text: '处理中' }], '2026-09-07T01:00:01.000Z'),
    ], {
      activeTurnId: 'claude-turn:live',
      activeUserInput: [textInput('继续执行')],
    })

    expect(history.activeTurnId).toBe('claude-turn:live')
    expect(history.turns[0].id).toBe('claude-turn:live')
    expect(history.turns[0].status).toBe('inProgress')
    expect(history.items.map((entry) => entry.item.id)).toEqual(['claude-turn:live:user', 'claude-turn:live:assistant'])
  })

  it('merges hydrated items with live detail without duplicating stable ids', () => {
    const history = hydrateClaudeHistory([
      message('user', 'user-1', '继续执行', '2026-09-07T01:00:00.000Z'),
      message('assistant', 'assistant-1', [{ type: 'text', text: '历史中的完整答复' }], '2026-09-07T01:00:01.000Z'),
    ], {
      activeTurnId: 'claude-turn:live',
      activeUserInput: [textInput('继续执行')],
    })
    const live = emptyThreadDetail(thread)
    live.activeTurnId = 'claude-turn:live'
    live.turns = [{
      id: 'claude-turn:live',
      items: [],
      status: 'inProgress',
      error: null,
      startedAt: Date.parse('2026-09-07T01:00:00.000Z'),
      completedAt: null,
      durationMs: null,
    }]
    live.items = [
      { turnId: 'claude-turn:live', item: { id: 'claude-turn:live:user', type: 'userMessage', content: [textInput('继续执行')] } },
      { turnId: 'claude-turn:live', item: { id: 'claude-turn:live:assistant', type: 'agentMessage', text: '实时答复', phase: 'final_answer' } },
    ]

    const merged = mergeClaudeHistory(live, history)

    expect(merged.items).toHaveLength(2)
    expect(merged.items.find((entry) => entry.item.id === 'claude-turn:live:assistant')?.item.text).toBe('实时答复')
    expect(merged.turns).toHaveLength(1)
    expect(merged.turns[0].items).toHaveLength(2)
    expect(merged.activeTurnId).toBe('claude-turn:live')
  })
})
