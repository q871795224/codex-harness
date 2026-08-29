import { useState } from 'react'
import { Check, ChevronLeft, ChevronUp, CircleAlert, LoaderCircle, Play, Terminal } from 'lucide-react'
import type { QuickCommandContribution } from '../../extensions/types'
import type { ResolvedContribution } from './runtime'

interface QuickCommandPanelProps {
  commands: ResolvedContribution<QuickCommandContribution>[]
  anchorBottom?: number
}

type CommandState = { phase: 'running' | 'success' | 'failed'; message: string }

export function QuickCommandPanel({ commands, anchorBottom }: QuickCommandPanelProps) {
  const [open, setOpen] = useState(false)
  const [states, setStates] = useState<Record<string, CommandState>>({})
  if (commands.length === 0) return null

  const run = async (entry: ResolvedContribution<QuickCommandContribution>) => {
    const key = entry.instanceId
    setStates((current) => ({ ...current, [key]: { phase: 'running', message: '后台执行中…' } }))
    try {
      const result = await entry.contribution.run()
      setStates((current) => ({
        ...current,
        [key]: { phase: result.success ? 'success' : 'failed', message: result.message },
      }))
    } catch (error) {
      setStates((current) => ({
        ...current,
        [key]: { phase: 'failed', message: error instanceof Error ? error.message : String(error) },
      }))
    }
  }

  return (
    <div className={`quick-command-dock${open ? ' open' : ''}`} style={anchorBottom === undefined ? undefined : { bottom: anchorBottom }}>
      {open ? (
        <section className="quick-command-panel" aria-label="快捷命令">
          <header>
            <button type="button" aria-label="收起快捷命令" title="收起" onClick={() => setOpen(false)}><ChevronLeft size={15} /></button>
            <span><Terminal size={15} />快捷命令</span>
          </header>
          <div className="quick-command-list">
            {commands.map((entry) => {
              const state = states[entry.instanceId]
              const running = state?.phase === 'running'
              return (
                <button
                  key={`${entry.pluginId}:${entry.instanceId}:${entry.contribution.id}`}
                  type="button"
                  disabled={running}
                  onClick={() => void run(entry)}
                  title={`${entry.contribution.command}${state ? `\n${state.message}` : ''}`}
                  aria-label={`${entry.contribution.label}：${entry.contribution.command}`}
                >
                  <span className={`quick-command-icon ${state?.phase ?? 'idle'}`}>
                    {running ? <LoaderCircle className="spin" size={14} />
                      : state?.phase === 'success' ? <Check size={14} />
                        : state?.phase === 'failed' ? <CircleAlert size={14} />
                          : <Play size={13} fill="currentColor" />}
                  </span>
                  <strong>{entry.contribution.label}</strong>
                  {state && <small className={state.phase}>{state.message}</small>}
                </button>
              )
            })}
          </div>
        </section>
      ) : (
        <button type="button" className="quick-command-trigger" aria-label="打开快捷命令" title="快捷命令" onClick={() => setOpen(true)}>
          <ChevronUp size={13} /><Terminal size={17} />
        </button>
      )}
    </div>
  )
}
