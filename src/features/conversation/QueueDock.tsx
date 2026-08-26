import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Clock3, Pencil, Play, Send, Trash2, X } from 'lucide-react'
import type { PendingSteer, QueuedSubmission } from '../../core/domain/codex'
import { queueText } from '../../core/domain/codex'

interface QueueDockProps {
  queue: QueuedSubmission[]
  pendingSteers: PendingSteer[]
  working: boolean
  canMutate: boolean
  busy: Record<string, boolean>
  onEdit: (queueId: string, text: string) => void
  onRemove: (queueId: string) => void
  onPromote: (queue: QueuedSubmission) => void
  onStart: () => void
}

export function QueueDock({
  queue,
  pendingSteers,
  working,
  canMutate,
  busy,
  onEdit,
  onRemove,
  onPromote,
  onStart,
}: QueueDockProps) {
  const [open, setOpen] = useState(queue.length <= 1)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)

  useEffect(() => {
    if (queue.length <= 1) setOpen(true)
    if (editing && !queue.some((item) => item.id === editing.id)) setEditing(null)
  }, [editing, queue])

  if (queue.length === 0 && pendingSteers.length === 0) return null

  return (
    <section className="queue-dock" data-queue-dock>
      {pendingSteers.length > 0 && (
        <div className="steer-panel">
          <div className="dock-label"><Send size={13} /> 插话</div>
          {pendingSteers.map((steer) => (
            <div className="steer-row" key={steer.clientUserMessageId}>
              <span>{steer.text}</span>
              <small><Clock3 size={12} /> 已提交，等待下一次工具调用</small>
            </div>
          ))}
        </div>
      )}

      {queue.length > 0 && (
        <div className="queue-panel">
          <div className="queue-header">
            <button type="button" className="queue-title" onClick={() => setOpen((value) => !value)}>
              <span className="queue-count">{queue.length}</span>
              <span>排队消息</span>
              {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
            {!working && canMutate && (
              <button className="queue-start" type="button" onClick={onStart}><Play size={13} />继续队列</button>
            )}
          </div>
          {open && (
            <div className="queue-list">
              {queue.map((item, index) => {
                const isEditing = editing?.id === item.id
                const isBusy = busy[`promote:${item.id}`]
                return (
                  <div className="queue-row" key={item.id}>
                    <span className="queue-index">{index + 1}</span>
                    {isEditing ? (
                      <textarea
                        autoFocus
                        className="queue-editor"
                        value={editing.text}
                        onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setEditing(null)
                          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault()
                            onEdit(item.id, editing.text)
                            setEditing(null)
                          }
                        }}
                      />
                    ) : <span className="queue-text">{queueText(item)}</span>}
                    {canMutate && (
                      <div className="queue-actions">
                        {isEditing ? (
                          <>
                            <button type="button" title="保存修改" onClick={() => { onEdit(item.id, editing.text); setEditing(null) }}><Check size={14} /></button>
                            <button type="button" title="取消修改" onClick={() => setEditing(null)}><X size={14} /></button>
                          </>
                        ) : (
                          <>
                            <button type="button" title="修改排队消息" disabled={isBusy} onClick={() => setEditing({ id: item.id, text: queueText(item) })}><Pencil size={14} /></button>
                            <button type="button" title="撤回排队消息" disabled={isBusy} onClick={() => onRemove(item.id)}><Trash2 size={14} /></button>
                            <button type="button" title={working ? '改为插话' : '运行中才能插话'} disabled={isBusy || !working} onClick={() => onPromote(item)}><Send size={14} /></button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
