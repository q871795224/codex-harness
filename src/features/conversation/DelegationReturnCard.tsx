import { useState } from 'react'
import { Check, Eye, LoaderCircle, MoonStar, SendHorizontal, X } from 'lucide-react'
import type { AgentRun, AgentRunService } from '../../core/agent-runs/types'

/**
 * 委托回传卡片（模式 B，Luna ↔ 主会话）。
 *
 * 当前会话存在「已完成、未回传、delegated」的子 run 时出现在输入框上方。
 * 两个方向：
 * - 子 → 主：注入 / 查看 / 忽略（注入把结果塞进主会话草稿，不自动发送）。
 * - 主 → 子：注入结果后卡片进入"等待验收"态，可输入意见回传给子 Agent（塞进子会话草稿）。
 *
 * 全程不自动发送任何消息；所有注入都进草稿，经人审批后由用户发送。
 */
export function DelegationReturnCard({ runs, agentRuns, onInjectDraft }: {
  runs: AgentRun[]
  agentRuns: AgentRunService
  onInjectDraft: (threadId: string, text: string) => void
}) {
  const [busyRunId, setBusyRunId] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [awaitingReview, setAwaitingReview] = useState<Set<string>>(new Set())
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState<string | null>(null)

  const pending = runs.filter((run) =>
    run.mode === 'delegated'
    && run.parentThreadId
    && !dismissed.has(run.runId)
    && (run.status === 'completed' || run.status === 'failed')
    && (!run.returnedAt || awaitingReview.has(run.runId)))

  if (pending.length === 0) return null
  const run = pending[0]
  const busy = busyRunId === run.runId
  const reviewing = awaitingReview.has(run.runId)

  const inject = async () => {
    if (!run.parentThreadId) return
    setBusyRunId(run.runId)
    setError(null)
    try {
      const draft = await agentRuns.buildReturnDraft(run.runId)
      onInjectDraft(run.parentThreadId, draft)
      await agentRuns.markReturned(run.runId)
      setAwaitingReview((current) => new Set(current).add(run.runId))
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusyRunId(null)
    }
  }

  const sendFeedback = async () => {
    const text = feedback.trim()
    if (!text) return
    setBusyRunId(run.runId)
    setError(null)
    try {
      const childThreadId = await agentRuns.childThreadForFeedback(run.runId)
      onInjectDraft(childThreadId, `主会话验收意见：\n\n${text}`)
      setFeedback('')
      setAwaitingReview((current) => { const next = new Set(current); next.delete(run.runId); return next })
      setDismissed((current) => new Set(current).add(run.runId))
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusyRunId(null)
    }
  }

  const dismiss = async () => {
    setDismissed((current) => new Set(current).add(run.runId))
    setAwaitingReview((current) => { const next = new Set(current); next.delete(run.runId); return next })
    await agentRuns.markReturned(run.runId).catch(() => undefined)
  }

  return (
    <div className={`delegation-return-card${reviewing ? ' reviewing' : ''}`} role="status">
      <span className="delegation-return-icon"><MoonStar size={14} /></span>
      {!reviewing ? (
        <>
          <span className="delegation-return-text">
            子 Agent「{run.title}」{run.status === 'failed' ? '失败' : '已完成'}，结果待回传。
          </span>
          <span className="delegation-return-actions">
            {run.status === 'completed' && (
              <button type="button" className="primary" disabled={busy} onClick={() => void inject()} title="把结果填入输入框，经你确认后发送">
                {busy ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}注入
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => run.childThreadId && agentRuns.openThread(run.childThreadId)} title="打开子 Agent 会话查看完整过程">
              <Eye size={12} />查看
            </button>
            <button type="button" disabled={busy} onClick={() => void dismiss()} title="不回传，关闭此卡片">
              <X size={12} />忽略
            </button>
          </span>
        </>
      ) : (
        <>
          <span className="delegation-return-text">结果已注入。验收后可回传意见给「{run.title}」：</span>
          <input
            className="delegation-return-feedback"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="验收意见，填入子 Agent 输入框"
            aria-label="回传意见"
            onKeyDown={(event) => { if (event.key === 'Enter') void sendFeedback() }}
          />
          <span className="delegation-return-actions">
            <button type="button" className="primary" disabled={busy || !feedback.trim()} onClick={() => void sendFeedback()} title="把意见填入子 Agent 输入框">
              {busy ? <LoaderCircle className="spin" size={12} /> : <SendHorizontal size={12} />}回传
            </button>
            <button type="button" disabled={busy} onClick={() => void dismiss()} title="完成，不回传意见">
              <X size={12} />完成
            </button>
          </span>
        </>
      )}
      {error && <span className="delegation-return-error">{error}</span>}
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
