import { useState } from 'react'
import { Bot, ChevronDown, ChevronRight, LoaderCircle, Play } from 'lucide-react'
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
  if (actions.length === 0) return null

  const run = async (action: ResolvedContribution<QuickActionContribution>) => {
    setRunningId(action.contribution.id)
    setError(null)
    try {
      await action.contribution.run(context)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setRunningId(null)
    }
  }

  return (
    <div className={`quick-action-dock${open ? ' open' : ''}`}>
      {open ? (
        <section className="quick-action-panel" aria-label="快捷 Agent">
          <header>
            <span><Bot size={15} />快捷 Agent</span>
            <button type="button" aria-label="收起快捷 Agent" title="收起" onClick={() => setOpen(false)}>
              <ChevronRight size={15} />
            </button>
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
                  title={action.contribution.label}
                >
                  <span className="quick-action-play">{running ? <LoaderCircle className="spin" size={14} /> : <Play size={13} fill="currentColor" />}</span>
                  <strong>{action.contribution.label}</strong>
                </button>
              )
            })}
          </div>
          {error && <div className="quick-action-error">{error}</div>}
        </section>
      ) : (
        <button
          type="button"
          className="quick-action-trigger"
          aria-expanded={false}
          aria-label="打开快捷 Agent"
          title="快捷 Agent"
          onClick={() => { setError(null); setOpen(true) }}
        >
          <Bot size={17} />
          <ChevronDown size={13} />
        </button>
      )}
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
