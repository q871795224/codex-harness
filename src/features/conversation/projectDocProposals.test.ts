import { describe, expect, it } from 'vitest'
import type { ThreadItemEntry } from '../../core/domain/codex'
import { collectProjectDocProposals } from './projectDocProposals'

function agentMessage(turnId: string, itemId: string, text: string, phase?: 'commentary' | 'final_answer'): ThreadItemEntry {
  return { turnId, item: { type: 'agentMessage', id: itemId, text, phase: phase ?? null } }
}

describe('collectProjectDocProposals', () => {
  it('extracts proposals with stable keys from agent messages', () => {
    const items = [
      agentMessage('t1', 'm1', '前言\n<project-doc-update>\nsection: status\nbase_seq: 3\n\n### run-1: 进展\n已完成\n</project-doc-update>\n后记'),
    ]
    const entries = collectProjectDocProposals(items)
    expect(entries).toHaveLength(1)
    expect(entries[0].key).toBe('t1:m1:0')
    expect(entries[0].turnId).toBe('t1')
    expect(entries[0].proposal.section).toBe('status')
    expect(entries[0].proposal.baseSeq).toBe(3)
    expect(entries[0].proposal.content).toContain('run-1')
  })

  it('skips non-agent items and invalid blocks', () => {
    const items: ThreadItemEntry[] = [
      { turnId: 't1', item: { type: 'userMessage', id: 'u1', content: [] } },
      agentMessage('t1', 'm1', '<project-doc-update>\nsection: unknown\n\n内容\n</project-doc-update>'),
      agentMessage('t1', 'm2', '普通回复，没有提议块'),
    ]
    expect(collectProjectDocProposals(items)).toHaveLength(0)
  })

  it('extracts multiple proposals across messages', () => {
    const items = [
      agentMessage('t1', 'm1', '<project-doc-update>\nsection: status\nbase_seq: 1\n\n甲\n</project-doc-update>'),
      agentMessage('t2', 'm2', '<project-doc-update>\nsection: status\nbase_seq: 2\n\n乙\n</project-doc-update>'),
    ]
    const entries = collectProjectDocProposals(items)
    expect(entries.map((entry) => entry.key)).toEqual(['t1:m1:0', 't2:m2:0'])
    expect(entries.map((entry) => entry.proposal.content)).toEqual(['甲', '乙'])
  })

  it('merges consecutive same-phase agent messages before extracting', () => {
    // groupTranscriptItems 会把同 turn 同 phase 的连续 agentMessage 拼成一条（与 ConversationView 一致）。
    const items = [
      agentMessage('t1', 'm1', '上半段\n<project-doc-update>\nsection: status\nbase_seq: 1', 'final_answer'),
      agentMessage('t1', 'm2', '\n\n内容跨块\n</project-doc-update>', 'final_answer'),
    ]
    const entries = collectProjectDocProposals(items)
    expect(entries).toHaveLength(1)
    expect(entries[0].proposal.content).toContain('内容跨块')
  })
})
