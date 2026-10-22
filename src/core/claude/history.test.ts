import { describe, expect, it } from 'vitest'
import { emptyThreadDetail, textInput, type Thread, type ThreadDetail, type UserInput } from '../domain/codex'
import type { ClaudeSessionMessage } from './types'
import { hydrateClaudeHistory, mergeClaudeHistory } from './history'
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

function liveTurn(detail: ThreadDetail, turnId: string, providerMessageId: string, input: UserInput[], completed = true): ThreadDetail {
  detail = reduceClaudeEvent(detail, { method: 'turn/started', params: { turnId } })
  detail = reduceClaudeEvent(detail, {
    method: 'message/user',
    params: { turnId, itemId: `${turnId}:user`, providerMessageId, content: input },
  })
  detail = reduceClaudeEvent(detail, {
    method: 'message/completed',
    params: { turnId, itemId: `${turnId}:assistant`, text: '实时答复' },
  })
  return completed ? reduceClaudeEvent(detail, { method: 'turn/completed', params: { turnId } }) : detail
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

  it.each([true, false])('merges the live prompt and answer by provider UUID (completed=%s)', (completed) => {
    const history = hydrateClaudeHistory([
      message('user', 'user-1', '继续执行', '2026-09-07T01:00:00.000Z'),
      message('assistant', 'assistant-1', [{ type: 'text', text: '处理中' }], '2026-09-07T01:00:01.000Z'),
    ])
    const live = liveTurn(emptyThreadDetail(thread), 'claude-turn:live', 'user-1', [textInput('继续执行')], completed)
    const merged = mergeClaudeHistory(live, history)

    expect(merged.turns).toHaveLength(1)
    expect(merged.turns[0]).toMatchObject({ id: 'claude-turn:live', status: completed ? 'completed' : 'inProgress' })
    expect(merged.activeTurnId).toBe(completed ? null : 'claude-turn:live')
    expect(merged.items.map((entry) => entry.item.id)).toEqual(['claude-turn:live:user', 'claude-turn:live:assistant'])
    expect(merged.items.find((entry) => entry.item.type === 'agentMessage')?.item.text).toBe('实时答复')
    expect(mergeClaudeHistory(merged, history)).toEqual(merged)
  })

  it('preserves completion when history requested during a turn returns after completion', () => {
    const history = hydrateClaudeHistory([
      message('user', 'user-1', '继续执行', '2026-09-07T01:00:00.000Z'),
      message('assistant', 'assistant-1', [{ type: 'text', text: '历史中的完整答复' }], '2026-09-07T01:00:01.000Z'),
    ])
    let live = liveTurn(emptyThreadDetail(thread), 'claude-turn:live', 'user-1', [textInput('继续执行')], false)
    live = reduceClaudeEvent(live, { method: 'turn/completed', params: { turnId: 'claude-turn:live' } })

    const merged = mergeClaudeHistory(live, history)

    expect(merged.items).toHaveLength(2)
    expect(merged.items.find((entry) => entry.item.id === 'claude-turn:live:assistant')?.item.text).toBe('实时答复')
    expect(merged.turns).toHaveLength(1)
    expect(merged.turns[0].items).toHaveLength(2)
    expect(merged.activeTurnId).toBeNull()
    expect(merged.turns[0].status).toBe('completed')
  })

  it('keeps genuinely repeated prompts as separate turns and matches only their UUIDs', () => {
    const history = hydrateClaudeHistory([
      message('user', 'user-1', '继续执行', '2026-09-07T01:00:00.000Z'),
      message('assistant', 'assistant-1', '第一轮答复', '2026-09-07T01:00:01.000Z'),
      message('user', 'user-2', '继续执行', '2026-09-07T01:01:00.000Z'),
      message('assistant', 'assistant-2', '第二轮答复', '2026-09-07T01:01:01.000Z'),
    ])
    let live = liveTurn(emptyThreadDetail(thread), 'live-1', 'user-1', [textInput('继续执行')])
    live = liveTurn(live, 'live-2', 'user-2', [textInput('继续执行')])
    // A new identical submission may not have reached the transcript yet.
    live = liveTurn(live, 'live-3', 'user-3', [textInput('继续执行')], false)
    const merged = mergeClaudeHistory(live, history)

    expect(merged.turns.map((turn) => turn.id)).toEqual(['live-1', 'live-2', 'live-3'])
    expect(merged.items.filter((entry) => entry.item.type === 'userMessage')).toHaveLength(3)
    expect(merged.items.filter((entry) => entry.item.type === 'agentMessage')).toHaveLength(3)
    expect(merged.activeTurnId).toBe('live-3')
  })

  it('matches image prompts by UUID while retaining local attachment paths and tool IDs', () => {
    const history = hydrateClaudeHistory([
      message('user', 'user-image', [{ type: 'image' }], '2026-09-07T01:00:00.000Z'),
      message('assistant', 'assistant-1', [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'pwd' } }], '2026-09-07T01:00:01.000Z'),
      message('user', 'result-1', [{ type: 'tool_result', tool_use_id: 'bash-1', content: '/workspace' }], '2026-09-07T01:00:02.000Z'),
    ])
    const input: UserInput[] = [{ type: 'localImage', path: '/tmp/fixture.png' }]
    const live = liveTurn(emptyThreadDetail(thread), 'live-image', 'user-image', input)
    const merged = mergeClaudeHistory(live, history)

    expect(merged.turns).toHaveLength(1)
    expect(merged.items.filter((entry) => entry.item.type === 'userMessage')).toEqual([
      expect.objectContaining({ turnId: 'live-image', item: expect.objectContaining({ content: input }) }),
    ])
    expect(merged.items.find((entry) => entry.item.id === 'bash-1')).toMatchObject({
      turnId: 'live-image', item: { status: 'completed', command: 'pwd' },
    })
  })

  it('does not merge unrelated prompts with equal text but different UUIDs', () => {
    const history = hydrateClaudeHistory([message('user', 'old-user', '继续执行', '2026-09-07T01:00:00.000Z')])
    const live = liveTurn(emptyThreadDetail(thread), 'new-turn', 'new-user', [textInput('继续执行')])
    expect(mergeClaudeHistory(live, history).turns).toHaveLength(2)
  })
})
