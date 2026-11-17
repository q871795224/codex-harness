import { describe, expect, it } from 'vitest'
import { mergeSuperbotMessages, remoteSuperbotId, superbotThread, type SuperbotMessage, type SuperbotSession } from './types'

describe('Superbot conversation mapping', () => {
  it('keeps cloud sessions out of local workspaces', () => {
    const thread = superbotThread({ id: 'remote', title: 'work', status: 'active', read_only: false, created_at: '2026-11-17T08:00:00Z', updated_at: '2026-11-17T09:00:00Z' } as SuperbotSession, 'task')
    expect(thread).toMatchObject({ id: 'superbot:remote', provider: 'superbot', cwd: '', status: { type: 'active' }, canAcceptDirectInput: true })
    expect(thread.createdAt).toBe(1794902400)
    expect(() => remoteSuperbotId('claude:remote')).toThrow()
  })
  it('preserves SeaTalk origin without assigning a local workspace', () => {
    const thread = superbotThread({ id: 'channel', title: 'SeaTalk', status: 'active', read_only: false, seatalk_kind: 'thread', created_at: '2026-11-17T08:00:00Z', updated_at: '2026-11-17T09:00:00Z' } as SuperbotSession)
    expect(thread).toMatchObject({ provider: 'superbot', channelSource: 'seatalk', cwd: '' })
  })
  it('deduplicates by remote message ID while preserving repeated text', () => {
    const a = { id: 'a', content: 'retry', created_at: '2026-11-17T08:00:00Z' } as SuperbotMessage
    const b = { ...a, id: 'b', created_at: '2026-11-17T09:00:00Z' }
    expect(mergeSuperbotMessages([a, b], [{ ...a, task_status: 'completed' }])).toEqual([{ ...a, task_status: 'completed' }, b])
  })
})
