import React, { useEffect, useState } from 'react'
import { runtime } from '../runtime/bridge'
import type { AsyncWaitTask } from './types'

export function AsyncWaitApproval({ task, onChanged }: { task: AsyncWaitTask; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const review = async (approve: boolean) => {
    setBusy(true)
    try { await runtime.reviewAsyncWait(task.id, task.revision, approve); onChanged() }
    catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  return <section className="async-wait-panel" aria-label="确认自定义异步任务">
    <p>是否允许创建「{task.title}」？</p>
    <p>工作目录：{task.cwd}</p>
    <p>每5分钟只读检查，批准后7天到期；就绪后唤醒来源 Agent。</p>
    <p>就绪条件：{task.condition || '见检查脚本（旧任务）'}</p>
    <p>后续动作：{task.continuation}</p>
    <details><summary>查看待执行的 Python 检查脚本</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 320, overflow: 'auto' }}>{task.checkerSource}</pre></details>
    <p>脚本以当前用户权限运行。确认前不会执行；请核对脚本只观察已授权的目标。</p>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => void review(true)}>同意创建</button>{' '}
    <button type="button" disabled={busy} onClick={() => void review(false)}>拒绝</button>
  </section>
}

/** Visible in the source conversation, even while its Agent is still working. */
export function AsyncWaitApprovals({ threadId }: { threadId: string }) {
  const [tasks, setTasks] = useState<AsyncWaitTask[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!runtime.listenAsyncWaits) return
    let disposed = false, sequence = 0
    let stop: (() => void) | undefined
    const refresh = async () => {
      const version = ++sequence
      try {
        const state = await runtime.listAsyncWaits()
        if (!disposed && version === sequence) { setTasks(state.data); setError('') }
      } catch (cause) { if (!disposed) setError(String(cause)) }
    }
    void runtime.listenAsyncWaits(() => void refresh()).then(unlisten => { if (disposed) unlisten(); else { stop = unlisten; void refresh() } }).catch(cause => { if (!disposed) setError(String(cause)) })
    return () => { disposed = true; stop?.() }
  }, [])
  return <>{error && <p role="alert">无法读取自定义任务确认：{error}</p>}{tasks.filter(t => t.threadId === threadId && t.status === 'awaitingApproval').map(task => <AsyncWaitApproval key={task.id} task={task} onChanged={() => { /* native changed event refreshes snapshot */ }} />)}</>
}
