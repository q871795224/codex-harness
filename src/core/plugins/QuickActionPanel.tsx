import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, LoaderCircle, Play } from 'lucide-react'
import type { QuickActionProps } from '../../extensions/types'
import type { ResolvedContribution } from './runtime'
import type { QuickActionContribution } from '../../extensions/types'

interface QuickActionPanelProps {
  actions: ResolvedContribution<QuickActionContribution>[]
  context: QuickActionProps
}

export function QuickActionPanel({ actions, context }: QuickActionPanelProps) {
  const [open, setOpen] = useState(false)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  if (actions.length === 0) return null

  const run = async (action: ResolvedContribution<QuickActionContribution>) => {
    setRunningId(action.contribution.id)
    setError(null)
    try {
      await action.contribution.run(context)
      setOpen(false)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setRunningId(null)
    }
  }

  return (
    <div ref={rootRef} className={`quick-action-dock${open ? ' open' : ''}`}>
      {open && (
        <section className="quick-action-panel" aria-label="快捷 Agent">
          <header>
            <span><Bot size={15} />快捷 Agent</span>
            <small>{actions.length} 个可用 Job</small>
          </header>
          <div className="quick-action-list">
            {actions.map((action) => {
              const running = runningId === action.contribution.id
              return (
                <button
                  key={`${action.pluginId}:${action.contribution.id}`}
                  type="button"
                  disabled={context.disabled || runningId !== null}
                  onClick={() => void run(action)}
                >
                  <span className="quick-action-play">{running ? <LoaderCircle className="spin" size={14} /> : <Play size={13} fill="currentColor" />}</span>
                  <span className="quick-action-copy">
                    <strong>{action.contribution.label}</strong>
                    {action.contribution.description && <small>{action.contribution.description}</small>}
                  </span>
                  {action.contribution.meta && <em>{action.contribution.meta}</em>}
                </button>
              )
            })}
          </div>
          {error && <div className="quick-action-error">{error}</div>}
        </section>
      )}
      <button
        type="button"
        className="quick-action-trigger"
        aria-expanded={open}
        aria-label="打开快捷 Agent"
        title="快捷 Agent"
        onClick={() => { setError(null); setOpen((current) => !current) }}
      >
        <Bot size={17} />
        <ChevronDown size={13} />
      </button>
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
