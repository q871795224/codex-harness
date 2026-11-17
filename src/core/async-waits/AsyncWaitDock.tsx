import { useState } from 'react'
import { ChevronDown, ChevronUp, Clock3 } from 'lucide-react'
import type { AsyncWaitTask } from './types'
import { asyncWaitStatusLabels } from './presentation'
import './AsyncWaitDock.css'

export function AsyncWaitDock({ tasks, error, onOpenTasks, pending, onStop }: {
  tasks: AsyncWaitTask[]
  error: string | null
  onOpenTasks?: () => void
  pending: string | null
  onStop: (id: string) => void
}) {
  if (!tasks.length && !error) return null
  return <section className="queue-dock async-wait-dock" aria-label="当前会话的异步任务">
    <div className="steer-panel">
      {error && <p className="async-wait-dock-error" role="alert">异步任务状态更新失败：{error}</p>}
      {tasks.map(task => <AsyncWaitRow key={task.id} task={task} onOpenTasks={onOpenTasks} pending={pending} onStop={onStop} />)}
    </div>
  </section>
}

function AsyncWaitRow({ task, onOpenTasks, pending, onStop }: { task: AsyncWaitTask; onOpenTasks?: () => void; pending: string | null; onStop: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const summary = task.target?.type === 'sleep' && (!task.summary || task.summary === `定时唤醒：${task.target.wakeAt}`)
    ? `定时唤醒：${formatTime(task.target.wakeAt)}`
    : task.summary || task.condition || '等待下一次检查'
  const canStop = ['awaitingApproval', 'waiting', 'ready', 'paused', 'expired'].includes(task.status)
  return <div className="steer-entry">
    <button type="button" className="steer-row async-wait-dock-row" aria-expanded={open}
      aria-label={`${open ? '收起' : '展开'}异步任务：${task.title}`} onClick={() => setOpen(value => !value)}>
      <Clock3 size={13} aria-hidden="true" />
      <span className="async-wait-dock-description" title={`${task.title}：${summary}`}>
        <strong>{task.title}</strong><span>{summary}</span>
      </span>
      <small className={`async-wait-status ${task.status}`} role="status">{asyncWaitStatusLabels[task.status]}</small>
      {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
    </button>
    {open && <div className="steer-text async-wait-dock-details">
      <div className="async-wait-dock-times">
        <span>{task.lastCheckedAt ? `最近检查：${formatTime(task.lastCheckedAt)}` : '尚未检查'}</span>
        {task.status === 'waiting' && <span>{task.target?.type === 'sleep'
          ? `唤醒时间：${formatTime(task.target.wakeAt)}`
          : `下次检查：${formatTime(task.nextCheckAt)}`}</span>}
      </div>
      <div className="async-wait-dock-actions">
        {onOpenTasks && <button type="button" className="async-wait-dock-open" onClick={onOpenTasks}>查看异步任务</button>}
        {canStop && <button type="button" className="async-wait-dock-stop" disabled={pending !== null} onClick={() => onStop(task.id)}>{pending === task.id ? '停止中…' : '停止'}</button>}
      </div>
    </div>}
  </div>
}

function formatTime(seconds: number) {
  return new Date(seconds * 1000).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
