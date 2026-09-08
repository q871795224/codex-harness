import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, GitCompareArrows, LoaderCircle, NotebookPen, RefreshCw, X } from 'lucide-react'
import type { ProjectDocService, ProjectDocProposal } from '../../core/project-docs/types'

/** 审批卡状态机：pending → applying → applied / conflict / rejected / error。 */
type CardState =
  | { kind: 'pending' }
  | { kind: 'applying' }
  | { kind: 'applied'; newSeq: number }
  | { kind: 'conflict'; currentSeq: number; baseSeq?: number }
  | { kind: 'rejected' }
  | { kind: 'error'; message: string }

/**
 * 项目文档审批卡（受控区 status 写入过人的关键闭环）。
 *
 * 数据源是 Harness 的**待审批提议队列**（Agent 经 `project-doc propose` 命令回传，
 * 不再扫会话文本里的标记块）。确认时经 `projectDoc.approveProposal` 落盘——
 * 服务端在写入时按队列里存的 base_seq 走 seq CAS，过期则冲突，可跳项目 tab 看 diff。
 */
export function ProjectDocApprovalCards({ projectDoc, projectId, onOpenProject }: {
  projectDoc: ProjectDocService
  projectId: string
  /** 跳项目 tab；携带冲突上下文时 tab 内打开 diff 面板。 */
  onOpenProject: (request?: { conflict?: { proposalContent: string; section: string } }) => void
}) {
  const [proposals, setProposals] = useState<ProjectDocProposal[]>([])
  const [states, setStates] = useState<Record<string, CardState>>({})
  const [currentSeq, setCurrentSeq] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [snapshot, pending] = await Promise.all([
        projectDoc.read(projectId),
        projectDoc.listProposals(projectId),
      ])
      setCurrentSeq(snapshot.currentSeq)
      setProposals(pending)
    } catch {
      setCurrentSeq(null)
    }
  }, [projectDoc, projectId])

  useEffect(() => {
    void refresh()
    // 轮询待审批队列（Agent 随时可能回传新提议）。
    const timer = window.setInterval(() => void refresh(), 2_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const setState = (key: string, state: CardState) =>
    setStates((current) => ({ ...current, [key]: state }))

  // 已落定的提议（applied/conflict/rejected）可能已从队列移除；保留最后一份内容让结果卡可见。
  const settledRef = useRef<Record<string, ProjectDocProposal>>({})
  useEffect(() => {
    for (const proposal of proposals) {
      if (states[proposal.id]) settledRef.current[proposal.id] = proposal
    }
  }, [proposals, states])

  const visible = useMemo(() => {
    const byId = new Map<string, ProjectDocProposal>()
    for (const proposal of proposals) byId.set(proposal.id, proposal)
    // 队列里没有但已落定的，用缓存内容补回（让结果卡短暂可见）。
    for (const [id, state] of Object.entries(states)) {
      if (!byId.has(id) && settledRef.current[id] && (state.kind === 'applied' || state.kind === 'conflict')) {
        byId.set(id, settledRef.current[id])
      }
    }
    return [...byId.values()].filter((proposal) => states[proposal.id]?.kind !== 'rejected')
  }, [proposals, states])

  const apply = async (proposal: ProjectDocProposal) => {
    setState(proposal.id, { kind: 'applying' })
    try {
      const outcome = await projectDoc.approveProposal(proposal.id)
      if (outcome.kind === 'applied') {
        setState(proposal.id, { kind: 'applied', newSeq: outcome.newSeq })
        setCurrentSeq(outcome.newSeq)
        // 落盘后提议已从队列移除；延迟刷新，让「已落盘为 v{N}」卡片短暂可见再消失。
        window.setTimeout(() => void refresh(), 2_500)
        return
      }
      setState(proposal.id, { kind: 'conflict', currentSeq: outcome.currentSeq, baseSeq: proposal.baseSeq })
      setCurrentSeq(outcome.currentSeq)
      // 冲突时提议保留在队列（服务端不移除），刷新以反映最新队列。
      void refresh()
    } catch (error) {
      setState(proposal.id, { kind: 'error', message: messageOf(error) })
    }
  }

  const reject = async (proposal: ProjectDocProposal) => {
    setState(proposal.id, { kind: 'rejected' })
    try {
      await projectDoc.rejectProposal(proposal.id)
    } catch {
      // 拒绝失败不阻塞 UI（卡片已隐藏）。
    }
    void refresh()
  }

  if (visible.length === 0) return null

  return (
    <div className="project-doc-approvals" role="group" aria-label="项目文档写入审批">
      {visible.map((proposal) => (
        <ProjectDocApprovalCard
          key={proposal.id}
          proposal={proposal}
          state={states[proposal.id] ?? { kind: 'pending' }}
          currentSeq={currentSeq}
          onApply={() => void apply(proposal)}
          onReject={() => void reject(proposal)}
          onReset={() => setState(proposal.id, { kind: 'pending' })}
          onOpenConflict={() => onOpenProject({
            conflict: { proposalContent: proposal.content, section: proposal.section },
          })}
        />
      ))}
    </div>
  )
}

function ProjectDocApprovalCard({ proposal, state, currentSeq, onApply, onReject, onReset, onOpenConflict }: {
  proposal: ProjectDocProposal
  state: CardState
  currentSeq: number | null
  onApply: () => void
  onReject: () => void
  onReset: () => void
  onOpenConflict: () => void
}) {
  const busy = state.kind === 'applying'
  // 本地已读到的 seq 与提议入队时的 base_seq 不一致时提前给出冲突提示；最终仍以写入时 CAS 为准。
  const staleHint = state.kind === 'pending'
    && currentSeq !== null
    && proposal.baseSeq !== currentSeq

  return (
    <article className={`project-doc-approval-card${state.kind === 'conflict' ? ' conflict' : ''}`} data-state={state.kind}>
      <span className="project-doc-approval-icon"><NotebookPen size={14} /></span>
      <div className="project-doc-approval-body">
        <div className="project-doc-approval-head">
          <strong>写入项目文档 · {sectionLabel(proposal.section)}</strong>
          <small>
            基于 v{proposal.baseSeq}
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

export type { ProjectDocProposal }
