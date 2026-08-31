import { describe, expect, it } from 'vitest'
import type { ThreadItemEntry } from '../../core/domain/codex'
import { groupTranscriptItems, groupTranscriptTurns, summarizeProcessRows } from './transcript'

const entry = (turnId: string, type: string, text?: string, phase?: 'commentary' | 'final_answer'): ThreadItemEntry => ({
  turnId,
  item: { id: `${turnId}:${type}:${phase ?? ''}:${text ?? ''}`, type, text, phase },
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

  it('does not merge commentary with the final answer', () => {
    const rows = groupTranscriptItems([
      entry('turn-1', 'agentMessage', '处理中', 'commentary'),
      entry('turn-1', 'agentMessage', '继续处理', 'commentary'),
      entry('turn-1', 'agentMessage', '最终结论', 'final_answer'),
    ])

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ agentText: '处理中\n\n继续处理', phase: 'commentary' })
    expect(rows[1]).toMatchObject({ agentText: '最终结论', phase: 'final_answer' })
  })
})

describe('groupTranscriptTurns', () => {
  it('separates user input, execution process and explicit final answer', () => {
    const turns = groupTranscriptTurns([
      entry('turn-1', 'userMessage', '修复问题'),
      entry('turn-1', 'agentMessage', '先检查实现', 'commentary'),
      { turnId: 'turn-1', item: { id: 'command-1', type: 'commandExecution', command: 'pnpm test' } },
      entry('turn-1', 'agentMessage', '已经修复', 'final_answer'),
    ], [{ id: 'turn-1', status: 'completed', error: null }])

    expect(turns).toHaveLength(1)
    expect(turns[0].userRows).toHaveLength(1)
    expect(turns[0].processRows.map((row) => row.entry.item.type)).toEqual(['agentMessage', 'commandExecution'])
    expect(turns[0].finalRows).toHaveLength(1)
  })

  it('uses the last phase-less agent message as a completed legacy final answer', () => {
    const turns = groupTranscriptTurns([
      entry('turn-1', 'agentMessage', '第一段'),
      { turnId: 'turn-1', item: { id: 'command-1', type: 'commandExecution' } },
      entry('turn-1', 'agentMessage', '总结'),
    ], [{ id: 'turn-1', status: 'completed', error: null }])

    expect(turns[0].processRows).toHaveLength(2)
    expect(turns[0].finalRows[0].agentText).toBe('总结')
  })

  it('keeps phase-less agent messages in the process while a turn is running', () => {
    const turns = groupTranscriptTurns([
      entry('turn-1', 'agentMessage', '仍在处理'),
    ], [{ id: 'turn-1', status: 'inProgress', error: null }])

    expect(turns[0].processRows).toHaveLength(1)
    expect(turns[0].finalRows).toHaveLength(0)
  })

  it('summarizes process records without exposing their contents', () => {
    const turns = groupTranscriptTurns([
      entry('turn-1', 'agentMessage', '检查中', 'commentary'),
      { turnId: 'turn-1', item: { id: 'command-1', type: 'commandExecution' } },
      { turnId: 'turn-1', item: { id: 'files-1', type: 'fileChange', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] } },
    ], [{ id: 'turn-1', status: 'completed', error: null }])

    expect(summarizeProcessRows(turns[0].processRows)).toBe('3 项 · 修改 2 个文件 · 运行 1 条命令')
  })

  it('keeps a failed turn visible when no item was returned', () => {
    const turns = groupTranscriptTurns([], [{
      id: 'turn-failed',
      status: 'failed',
      error: { message: 'Selected model is at capacity. Please try a different model.' },
    }])

    expect(turns).toEqual([expect.objectContaining({
      turnId: 'turn-failed',
      status: 'failed',
      error: { message: 'Selected model is at capacity. Please try a different model.' },
    })])
  })
})
