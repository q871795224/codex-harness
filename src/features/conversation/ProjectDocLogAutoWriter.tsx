import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, CircleAlert, Inbox, RotateCw, X } from 'lucide-react'
import type { ThreadItemEntry } from '../../core/domain/codex'
import type { ProjectDocService } from '../../core/project-docs/types'
import { collectAppendProposals, type ProjectDocProposalEntry } from './projectDocProposals'

type AutoWriteState =
  | { kind: 'applied'; newSeq: number }
  | { kind: 'error'; message: string }

/**
 * 追加区（Log / Decisions / Open Questions）提议的免审批直落盘。
 *
 * 完成态提取：消息文本完整出现在 items 后即触发 writeSection（append-only、低风险高频，
 * 设计稿「免审批直接落盘」）；不再等审批。每条带 updatedBy（threadId）+ seq 留痕。
 *
 * 反馈分级：
 * - applied：卡片短暂可见（可见性兜底），自动消失；人在版本历史可删可回滚。
 * - error：进失败态留在卡片上，由人选择「重试 / 放弃」——失败不静默。
 */
export function ProjectDocLogAutoWriter({ items, projectDoc, projectId, updatedBy }: {
  items: ThreadItemEntry[]
  projectDoc: ProjectDocService
  projectId: string
  updatedBy: string
}) {
  const proposals = useMemo(() => collectAppendProposals(items), [items])
  const [states, setStates] = useState<Record<string, AutoWriteState>>({})
  const [visibleApplied, setVisibleApplied] = useState<Record<string, true>>({})
  // 已触发过写入的 key：StrictMode 双跑 effect 与 items 重渲染都不得重复落盘。
  const attempted = useRef(new Set<string>())

  const apply = async (entry: ProjectDocProposalEntry) => {
    try {
      const outcome = await projectDoc.writeSection({
        projectId,
        section: entry.proposal.section,
        content: entry.proposal.content,
        updatedBy,
        summary: `Agent 追加（${entry.proposal.section}）免审批落盘`,
      })
      if (outcome.kind === 'applied') {
        setStates((current) => ({ ...current, [entry.key]: { kind: 'applied', newSeq: outcome.newSeq } }))
        setVisibleApplied((current) => ({ ...current, [entry.key]: true }))
        window.setTimeout(() => {
          setVisibleApplied((current) => {
            const next = { ...current }
            delete next[entry.key]
            return next
          })
        }, 4_000)
      } else {
        // 追加区不校验 base_seq，理论上不会 conflict；兜底记为错误让人看见。
        setStates((current) => ({ ...current, [entry.key]: { kind: 'error', message: `写入被拒绝（当前 v${outcome.currentSeq}）` } }))
      }
    } catch (error) {
      setStates((current) => ({ ...current, [entry.key]: { kind: 'error', message: messageOf(error) } }))
    }
  }
  const applyRef = useRef(apply)
  applyRef.current = apply

  useEffect(() => {
    for (const entry of proposals) {
      if (attempted.current.has(entry.key)) continue
      attempted.current.add(entry.key)
      void applyRef.current(entry)
    }
  }, [proposals])

  const retry = (entry: ProjectDocProposalEntry) => {
    setStates((current) => {
      const next = { ...current }
      delete next[entry.key]
      return next
    })
    void applyRef.current(entry)
  }

  const dismiss = (entry: ProjectDocProposalEntry) => {
    setStates((current) => {
      const next = { ...current }
      delete next[entry.key]
      return next
    })
    setVisibleApplied((current) => {
      const next = { ...current }
      delete next[entry.key]
      return next
    })
  }

  const appliedEntries = proposals.filter((entry) => visibleApplied[entry.key] && states[entry.key]?.kind === 'applied')
  const failedEntries = proposals.filter((entry) => states[entry.key]?.kind === 'error')
  if (appliedEntries.length === 0 && failedEntries.length === 0) return null

  return (
    <div className="project-doc-auto-writes" role="group" aria-label="项目文档追加落盘">
      {appliedEntries.map((entry) => (
        <article key={entry.key} className="project-doc-auto-card applied">
          <span className="project-doc-auto-icon"><Inbox size={13} /></span>
          <span className="project-doc-auto-text">
            已追加到 {sectionLabel(entry.proposal.section)} · v{(states[entry.key] as { newSeq: number }).newSeq}
          </span>
          <Check size={12} />
        </article>
      ))}
      {failedEntries.map((entry) => {
        const state = states[entry.key] as Extract<AutoWriteState, { kind: 'error' }>
        return (
          <article key={entry.key} className="project-doc-auto-card error">
            <span className="project-doc-auto-icon"><CircleAlert size={13} /></span>
            <span className="project-doc-auto-text">
              {sectionLabel(entry.proposal.section)} 追加失败：{state.message}
            </span>
            <span className="project-doc-auto-actions">
              <button type="button" onClick={() => retry(entry)} title="重新尝试落盘">
                <RotateCw size={11} />重试
              </button>
              <button type="button" onClick={() => dismiss(entry)} title="放弃这次追加">
                <X size={11} />放弃
              </button>
            </span>
          </article>
        )
      })}
    </div>
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
