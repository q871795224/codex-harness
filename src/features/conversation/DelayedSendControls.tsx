import { useEffect, useRef, useState } from 'react'
import { Clock3 } from 'lucide-react'
import type { DelayedSend } from './useDelayedSend'
import './delayedSend.css'

export function DelayedSendMenu({ onSelect, onClose }: {
  onSelect: (minutes: 1 | 5 | 10) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
    const dismiss = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) closeRef.current()
    }
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [])
  return <div ref={ref} className="follow-up-menu delayed-send-menu" role="menu" aria-label="延迟发送" onKeyDown={(event) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault()
      onClose()
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const buttons = Array.from(ref.current?.querySelectorAll('button') ?? [])
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    }
  }}>
    {([1, 5, 10] as const).map(minutes => <button type="button" role="menuitem" key={minutes} onClick={() => onSelect(minutes)}>
      <Clock3 size={13} />{minutes} 分钟后发送
    </button>)}
  </div>
}

export function DelayedSendStatus({ job, onCancel }: { job: DelayedSend; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [job.dueAt])
  const seconds = Math.max(0, Math.ceil((job.dueAt - now) / 1000))
  return <div className="delayed-send-status">
    <Clock3 size={14} />
    <span role="status">{job.sending ? '正在发送…' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} 后发送`}</span>
    <span className="delayed-send-hint">保持应用运行</span>
    <button type="button" disabled={job.sending} onClick={onCancel}>取消延迟发送</button>
  </div>
}
