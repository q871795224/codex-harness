import './AsyncWaitPanel.css'
import React from 'react'
import { useEffect, useState } from 'react'
import { runtime } from '../runtime/bridge'
import type { AsyncWaitAction, AsyncWaitSnapshot } from './types'

const labels: Record<string, string> = { waiting: '等待外部结果', ready: '已就绪，等待会话空闲', paused: '已暂停', expired: '等待已到期', dispatching: '提交中／待核对', uncertain: '提交结果待核对', delivered: '已继续处理', cancelled: '已取消', closed: '已核对结束' }
export function AsyncWaitPanel({ threadId, onOpenThread, view = 'compact' }: { threadId: string; onOpenThread?: (id: string) => void; view?: 'compact' | 'page' }) {
  const [snapshot, setSnapshot] = useState<AsyncWaitSnapshot>({ data: [], schedulerError: null })
  const [all, setAll] = useState(view === 'page')
  const [statusFilter, setStatusFilter] = useState(view === 'page' ? 'pending' : 'all')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false, sequence = 0
    let unlisten: (() => void) | undefined
    const refresh = async () => {
      const current = ++sequence
      try {
        const value = await runtime.listAsyncWaits()
        if (!disposed && current === sequence && value) { setSnapshot(value); setError(null) }
      } catch (cause) { if (!disposed && current === sequence) setError(String(cause)) }
    }
    // Some read-only hosts/tests do not expose native services.
    if (!runtime.listAsyncWaits || !runtime.listenAsyncWaits) return
    void runtime.listenAsyncWaits(() => { void refresh() }).then((stop) => {
      if (disposed) stop(); else { unlisten = stop; void refresh() }
    }).catch((cause) => { if (!disposed) setError(String(cause)) })
    return () => { disposed = true; unlisten?.() }
  }, [])
  const act = async (id: string, action: AsyncWaitAction) => {
    setPending(id)
    try { await runtime.asyncWaitAction(id, action); setSnapshot(await runtime.listAsyncWaits()); setError(null) }
    catch (cause) { setError(String(cause)) }
    finally { setPending(null) }
  }
  const ended = (status: string) => ['delivered', 'cancelled', 'closed'].includes(status)
  const tasks = snapshot.data.filter((task) => (all || task.threadId === threadId) && (statusFilter === 'all' || (statusFilter === 'ended' ? ended(task.status) : !ended(task.status))))
  if (view === 'compact' && !snapshot.data.length && !error && !snapshot.schedulerError) return null
  const content = <>
    {view === 'page' && <header><h2>异步任务</h2><span>{snapshot.data.filter((task) => !ended(task.status)).length} 项待处理</span></header>}

    <div className="async-wait-filters">
    <label><input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />查看所有会话</label>
    {view === 'page' && <label>状态 <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option><option value="pending">待处理</option><option value="ended">已结束</option></select></label>}
    </div>
    {(error || snapshot.schedulerError) && <p role="alert">{error || snapshot.schedulerError}</p>}
    {tasks.length === 0 && <p>{view === 'page' ? '没有符合条件的异步任务。任务由 Agent 创建后会显示在这里。' : '当前会话没有异步等待。'}</p>}
    {tasks.map((task) => <article key={task.id} data-status={task.status}>
      <div className="async-wait-heading">
        <strong>{task.title}</strong>
        <span className={`async-wait-status ${task.status}`} role="status">{labels[task.status] ?? task.status}</span>
        <div className="async-wait-times">
          <time title={task.lastCheckedAt ? new Date(task.lastCheckedAt * 1000).toLocaleString() : undefined} dateTime={task.lastCheckedAt ? new Date(task.lastCheckedAt * 1000).toISOString() : undefined}>
            {task.lastCheckedAt ? `检查 ${shortTime(task.lastCheckedAt)}` : '尚未检查'}
          </time>
          <time className={task.status === 'expired' ? 'expired' : ''} title={new Date(task.deadline * 1000).toLocaleString()} dateTime={new Date(task.deadline * 1000).toISOString()}>到期 {shortTime(task.deadline)}</time>
        </div>
      </div>
      <p className="async-wait-summary" title={task.summary}>{task.summary}</p>
      <div className="async-wait-actions">
        {(view === 'page' || task.threadId !== threadId) && onOpenThread && <button type="button" onClick={() => onOpenThread(task.threadId)}>打开来源会话</button>}
        {['waiting', 'ready'].includes(task.status) && <button type="button" disabled={pending !== null} onClick={() => void act(task.id, 'pause')}>暂停</button>}
        {['paused', 'expired'].includes(task.status) && <button type="button" disabled={pending !== null} onClick={() => void act(task.id, 'resume')}>重新检查并继续</button>}
      </div>
      <details className="async-wait-details"><summary>详情</summary>
        {task.lastObservation && task.lastObservation !== task.summary && <p>最近观察：{task.lastObservation}</p>}
        <p>就绪后：{task.continuation}</p>
        <small>Harness 打开时每5分钟检查，休眠或关闭后暂停；就绪后自动继续，忙时排队。</small>
        <small>任务 {task.id}</small>
        {!['delivered', 'cancelled', 'closed', 'dispatching', 'uncertain'].includes(task.status) && <button type="button" disabled={pending !== null} onClick={() => void act(task.id, 'cancel')}>取消等待</button>}
        {['dispatching', 'uncertain'].includes(task.status) && <button type="button" disabled={pending !== null} onClick={() => void act(task.id, 'acknowledge')}>我已核对会话，结束此记录</button>}
      </details>
    </article>)}
  </>
  return view === 'page'
    ? <section className="async-wait-panel async-wait-page" aria-label="异步任务">{content}</section>
    : <details className="async-wait-panel"><summary>异步等待 · {tasks.filter((task) => !ended(task.status)).length} 项待处理</summary>{content}</details>
}

function shortTime(seconds: number) {
  return new Date(seconds * 1000).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
