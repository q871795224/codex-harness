import type { ThreadItemEntry } from '../../core/domain/codex'
import type { ProjectDocUpdateProposal } from '../project-doc/document'
import { APPEND_SECTIONS, CONTROLLED_SECTIONS, extractProjectDocUpdates } from '../project-doc/document'
import { groupTranscriptItems } from './transcript'

/** 一条带出来源的提议：从某条 agent 消息里提取出的 <project-doc-update> 块。 */
export interface ProjectDocProposalEntry {
  /** 审批卡的稳定 key：turnId:itemId:proposalIndex */
  key: string
  turnId: string
  proposal: ProjectDocUpdateProposal
}

/**
 * 扫描会话 items，提取所有 <project-doc-update> 提议块及其来源。
 * 只读 agentMessage；连续同 phase 消息与 ConversationView 一致地拼接后再提取。
 * 提取是纯函数，卡片渲染与否由调用方决定（本项目一期只渲染受控区）。
 */
export function collectProjectDocProposals(items: ThreadItemEntry[]): ProjectDocProposalEntry[] {
  const entries: ProjectDocProposalEntry[] = []
  for (const row of groupTranscriptItems(items)) {
    if (row.agentText === undefined) continue
    const proposals = extractProjectDocUpdates(row.agentText)
    proposals.forEach((proposal, index) => {
      entries.push({
        key: `${row.entry.turnId}:${row.entry.item.id ?? 'unknown'}:${index}`,
        turnId: row.entry.turnId,
        proposal,
      })
    })
  }
  return entries
}

/** 受控区提议（必须过审批卡 + CAS）。 */
export function collectControlledProposals(items: ThreadItemEntry[]): ProjectDocProposalEntry[] {
  return collectProjectDocProposals(items).filter((entry) => CONTROLLED_SECTIONS.has(entry.proposal.section))
}

/** 追加区提议（免审批，落盘时由 Harness 按 seq 定序）。 */
export function collectAppendProposals(items: ThreadItemEntry[]): ProjectDocProposalEntry[] {
  return collectProjectDocProposals(items).filter((entry) => APPEND_SECTIONS.has(entry.proposal.section))
}
