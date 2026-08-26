import { describe, expect, it } from 'vitest'
import type { ThreadItemEntry } from '../../core/domain/codex'
import { groupTranscriptItems } from './transcript'

const entry = (turnId: string, type: string, text?: string): ThreadItemEntry => ({
  turnId,
  item: { id: `${turnId}:${type}:${text ?? ''}`, type, text },
})

describe('groupTranscriptItems', () => {
  it('shows Codex once per turn while retaining tool order', () => {
    const rows = groupTranscriptItems([
      entry('turn-1', 'agentMessage', '第一段'),
      entry('turn-1', 'agentMessage', '第二段'),
      entry('turn-1', 'commandExecution'),
      entry('turn-1', 'agentMessage', '工具后的说明'),
      entry('turn-2', 'agentMessage', '下一轮回复'),
    ])

    expect(rows).toHaveLength(4)
    expect(rows[0].agentText).toBe('第一段\n\n第二段')
    expect(rows[0].showAgentLabel).toBe(true)
    expect(rows[1].entry.item.type).toBe('commandExecution')
    expect(rows[2].showAgentLabel).toBe(false)
    expect(rows[3].showAgentLabel).toBe(true)
  })
})
