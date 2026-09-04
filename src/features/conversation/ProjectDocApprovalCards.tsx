import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, GitCompareArrows, LoaderCircle, NotebookPen, RefreshCw, X } from 'lucide-react'
import type { ThreadItemEntry } from '../../core/domain/codex'
import type { ProjectDocService } from '../../core/project-docs/types'
import { requiresBaseSeq } from '../project-doc/document'
import { collectProjectDocProposals, type ProjectDocProposalEntry } from './projectDocProposals'

/** 审批卡状态机：pending → applying → applied / conflict / rejected / error。 */
type CardState =
  | { kind: 'pending' }
  | { kind: 'applying' }
  | { kind: 'applied'; newSeq: number }
  | { kind: 'conflict'; currentSeq: number; baseSeq?: number }
  | { kind: 'rejected' }
  | { kind: 'error'; message: string }

/**
 * 项目文档审批卡（场景一写 Status 过人的关键闭环）。
 *
 * 扫描当前会话 items 里 agent emit 的 <project-doc-update> 受控区提议，
 * 逐条渲染成卡片；确认后经 `projectDoc.writeSection` 落盘（seq CAS 在 Rust 兜底），
 * base_seq 过期 → 冲突态，可跳项目 tab 看 diff 或重读最新版后重写。
 *
 * 只处理受控区（requiresBaseSeq）：追加区提议一期不在这里承载，避免绕过审批。
 */
export function ProjectDocApprovalCards({ items, projectDoc, projectId, updatedBy, onOpenProject }: {
  items: ThreadItemEntry[]
  projectDoc: ProjectDocService
  projectId: string
  /** 写入者标识（血缘）：当前会话 threadId。 */
  updatedBy: string
  /** 跳项目 tab；携带冲突上下文时 tab 内打开 diff 面板。 */
  onOpenProject: (request?: { conflict?: { proposalContent: string; section: string } }) => void
}) {
  const proposals = useMemo(
    () => collectProjectDocProposals(items).filter((entry) => requiresBaseSeq(entry.proposal.section)),
    [items],
  )
  const [states, setStates] = useState<Record<string, CardState>>({})
  const [currentSeq, setCurrentSeq] = useState<number | null>(null)

  const refreshSeq = useCallback(async () => {
    try {
      const snapshot = await projectDoc.read(projectId)
      setCurrentSeq(snapshot.currentSeq)
    } catch {
      setCurrentSeq(null)
    }
  }, [projectDoc, projectId])

  useEffect(() => {
    void refreshSeq()
  }, [refreshSeq])

  const setState = (key: string, state: CardState) =>
    setStates((current) => ({ ...current, [key]: state }))

  if (proposals.length === 0) return null

  const apply = async (entry: ProjectDocProposalEntry) => {
    const { key, proposal } = entry
    setState(key, { kind: 'applying' })
    try {
      const outcome = await projectDoc.writeSection({
        projectId,
        section: proposal.section,
        baseSeq: proposal.baseSeq,
        content: proposal.content,
        updatedBy,
        summary: `Agent 提议（${proposal.section}）经审批落盘`,
      })
      if (outcome.kind === 'applied') {
        setState(key, { kind: 'applied', newSeq: outcome.newSeq })
        setCurrentSeq(outcome.newSeq)
      } else {
        setState(key, { kind: 'conflict', currentSeq: outcome.currentSeq, baseSeq: proposal.baseSeq })
        setCurrentSeq(outcome.currentSeq)
      }
    } catch (error) {
      setState(key, { kind: 'error', message: messageOf(error) })
    }
  }

  return (
    <div className="project-doc-approvals" role="group" aria-label="项目文档写入审批">
      {proposals.map((entry) => (
        <ProjectDocApprovalCard
          key={entry.key}
          entry={entry}
          state={states[entry.key] ?? { kind: 'pending' }}
          currentSeq={currentSeq}
          onApply={() => void apply(entry)}
          onReject={() => setState(entry.key, { kind: 'rejected' })}
          onReset={() => setState(entry.key, { kind: 'pending' })}
          onOpenConflict={() => onOpenProject({
            conflict: { proposalContent: entry.proposal.content, section: entry.proposal.section },
          })}
        />
      ))}
    </div>
  )
}

function ProjectDocApprovalCard({ entry, state, currentSeq, onApply, onReject, onReset, onOpenConflict }: {
  entry: ProjectDocProposalEntry
  state: CardState
  currentSeq: number | null
  onApply: () => void
  onReject: () => void
  onReset: () => void
  onOpenConflict: () => void
}) {
  const { proposal } = entry
  const busy = state.kind === 'applying'
  // 本地已读到的 seq 与提议 base_seq 不一致时提前给出冲突提示；最终仍以写入时 CAS 为准。
  const staleHint = state.kind === 'pending'
    && currentSeq !== null
    && proposal.baseSeq !== undefined
    && proposal.baseSeq !== currentSeq

  return (
    <article className={`project-doc-approval-card${state.kind === 'conflict' ? ' conflict' : ''}`} data-state={state.kind}>
      <span className="project-doc-approval-icon"><NotebookPen size={14} /></span>
      <div className="project-doc-approval-body">
        <div className="project-doc-approval-head">
          <strong>写入项目文档 · {sectionLabel(proposal.section)}</strong>
          <small>
            {proposal.baseSeq !== undefined ? `基于 v${proposal.baseSeq}` : '未声明 base_seq'}
            {currentSeq !== null && ` · 当前 v${currentSeq}`}
          </small>
        </div>
        <pre className="project-doc-approval-content">{proposal.content}</pre>

        {state.kind === 'applied' && <p className="project-doc-approval-note success">已落盘为 v{state.newSeq}。</p>}
        {state.kind === 'rejected' && <p className="project-doc-approval-note">已放弃这次写入。</p>}
        {state.kind === 'conflict' && (
          <p className="project-doc-approval-note warning">
            版本冲突：提议基于 v{state.baseSeq ?? '?'}，当前已是 v{state.currentSeq}。
          </p>
        )}
        {state.kind === 'error' && <p className="project-doc-approval-note warning">写入失败：{state.message}</p>}
        {staleHint && <p className="project-doc-approval-note warning">注意：提议基于的版本已过期，确认可能被拒绝。</p>}

        <div className="project-doc-approval-actions">
          {(state.kind === 'pending' || state.kind === 'error') && (
            <>
              <button type="button" className="primary" disabled={busy} onClick={onApply} title="经 seq 校验后写入项目文档">
                {busy ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}确认写入
              </button>
              <button type="button" disabled={busy} onClick={onReject} title="不写入，关闭此卡片">
                <X size={12} />拒绝
              </button>
            </>
          )}
          {state.kind === 'conflict' && (
            <>
              <button type="button" className="primary" onClick={onOpenConflict} title="在项目页对比提议版与当前版">
                <GitCompareArrows size={12} />查看差异
              </button>
              <button type="button" onClick={onReject} title="放弃这次写入">
                <X size={12} />放弃
              </button>
            </>
          )}
          {(state.kind === 'applied' || state.kind === 'rejected') && (
            <button type="button" onClick={onReset} title="回到待审批态（误操作时恢复）">
              <RefreshCw size={12} />重置
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

function sectionLabel(section: string): string {
  const labels: Record<string, string> = {
    status: 'Status',
    log: 'Log',
    decisions: 'Decisions',
    openQuestions: 'Open Questions',
  }
  return labels[section] ?? section
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
