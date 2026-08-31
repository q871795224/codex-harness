import { describe, expect, it } from 'vitest'
import { emptyThreadDetail, type Thread, type Turn } from '../../core/domain/codex'
import { reduceThreadDetailEvent } from './conversationEventReducer'

const thread = (): Thread => ({ id: 'thread-1', cwd: '/repo', name: null, preview: '', ephemeral: false, createdAt: 1, updatedAt: 1, recencyAt: 1, status: { type: 'idle' }, canAcceptDirectInput: true })
const turn = (overrides: Partial<Turn> = {}): Turn => ({ id: 'turn-1', status: 'inProgress', items: [], error: null, startedAt: 1, completedAt: null, durationMs: null, ...overrides })

describe('conversation event reducer', () => {
  it('merges turn events without discarding hydrated items', () => {
    const item = { id: 'message-1', type: 'agentMessage' as const, text: '已有内容' }
    const detail = { ...emptyThreadDetail(thread()), turns: [turn({ items: [item] })], items: [{ turnId: 'turn-1', item }] }
    const next = reduceThreadDetailEvent(detail, { type: 'turnStarted', turn: turn() })

    expect(next.turns[0].items).toHaveLength(1)
    expect(next.items[0].item.id).toBe('message-1')
  })

  it('applies streaming deltas and completes only the matching active turn', () => {
    const detail = {
      ...emptyThreadDetail(thread()),
      activeTurnId: 'turn-1',
      foreignActive: true,
      items: [{ turnId: 'turn-1', item: { id: 'message-1', type: 'agentMessage', text: 'A' } }],
    }
    const streamed = reduceThreadDetailEvent(detail, { type: 'agentMessageDelta', itemId: 'message-1', delta: 'B' })
    const completed = reduceThreadDetailEvent(streamed, { type: 'turnCompleted', turn: turn({ status: 'completed' }) })

    expect(streamed.items[0].item.text).toBe('AB')
    expect(completed.activeTurnId).toBeNull()
    expect(completed.foreignActive).toBe(false)
  })

  it('updates runtime settings while retaining unspecified values', () => {
    const detail = { ...emptyThreadDetail(thread()), model: 'old-model', sandbox: { type: 'readOnly', networkAccess: false } as const }
    const next = reduceThreadDetailEvent(detail, {
      type: 'settingsUpdated',
      cwd: '/repo/worktree',
      activePermissionProfile: null,
      model: null,
      threadSettings: { effort: 'high' },
    })

    expect(next.thread.cwd).toBe('/repo/worktree')
    expect(next.model).toBe('old-model')
    expect(next.sandbox).toEqual(detail.sandbox)
    expect(next.threadSettings).toEqual({ effort: 'high' })
  })

  it('updates thread metadata and command output through reducer actions', () => {
    const detail = {
      ...emptyThreadDetail(thread()),
      items: [{ turnId: 'turn-1', item: { id: 'command-1', type: 'commandExecution', aggregatedOutput: 'A' } }],
    }
    const named = reduceThreadDetailEvent(detail, { type: 'nameUpdated', name: '交付任务' })
    const active = reduceThreadDetailEvent(named, { type: 'statusChanged', status: { type: 'active', activeFlags: [] } })
    const output = reduceThreadDetailEvent(active, { type: 'commandOutputDelta', itemId: 'command-1', delta: 'B' })
    const withItem = reduceThreadDetailEvent(output, { type: 'itemUpserted', turnId: 'turn-1', item: { id: 'command-1', type: 'commandExecution', status: 'completed' } })

    expect(withItem.thread.name).toBe('交付任务')
    expect(withItem.thread.status.type).toBe('active')
    expect(withItem.items[0].item).toMatchObject({ aggregatedOutput: 'AB', status: 'completed' })
  })
})
