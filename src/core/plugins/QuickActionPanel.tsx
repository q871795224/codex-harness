import { useState, useSyncExternalStore } from 'react'
import { Bot, Check, ChevronDown, ChevronRight, CircleAlert, LoaderCircle, Play } from 'lucide-react'
import type { AgentRun, AgentRunService } from '../agent-runs/types'
import type { QuickActionProps } from '../../extensions/types'
import type { ResolvedContribution } from './runtime'
import type { QuickActionContribution } from '../../extensions/types'

interface QuickActionPanelProps {
  actions: ResolvedContribution<QuickActionContribution>[]
  context: QuickActionProps
  agentRuns: AgentRunService
}

export function QuickActionPanel({ actions, context, agentRuns }: QuickActionPanelProps) {
  const [open, setOpen] = useState(false)
  const [startingId, setStartingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runs = useSyncExternalStore(agentRuns.subscribe, agentRuns.snapshot)
  if (actions.length === 0) return null

  const run = async (action: ResolvedContribution<QuickActionContribution>) => {
    setStartingId(action.contribution.id)
    setError(null)
    try {
      await action.contribution.run(context)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setStartingId(null)
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
              const latestRun = latestRunForAction(runs, action)
              const status = quickActionRunStatus(latestRun, startingId === action.contribution.id)
              const running = status === 'running'
              const accessibleLabel = `${action.contribution.label} · ${quickActionStatusLabel(status)}`
              return (
                <button
                  key={`${action.pluginId}:${action.contribution.id}`}
                  type="button"
                  disabled={context.disabled || startingId !== null || running}
                  onClick={() => void run(action)}
                  title={accessibleLabel}
                  aria-label={accessibleLabel}
                >
                  <span className={`quick-action-play ${status}`}>
                    {status === 'running' ? <LoaderCircle className="spin" size={14} />
                      : status === 'completed' ? <Check size={14} />
                        : status === 'failed' ? <CircleAlert size={14} />
                          : <Play size={13} fill="currentColor" />}
                  </span>
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

function latestRunForAction(
  runs: AgentRun[],
  action: ResolvedContribution<QuickActionContribution>,
): AgentRun | undefined {
  return runs.find((run) => run.instanceId === action.instanceId && run.title === action.contribution.label)
}

export function quickActionRunStatus(run: AgentRun | undefined, starting: boolean): 'idle' | 'running' | 'completed' | 'failed' {
  if (starting || run?.status === 'starting' || run?.status === 'running' || run?.status === 'waitingApproval') return 'running'
  if (run?.status === 'completed') return 'completed'
  if (run?.status === 'failed' || run?.status === 'cancelled') return 'failed'
  return 'idle'
}

function quickActionStatusLabel(status: 'idle' | 'running' | 'completed' | 'failed'): string {
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  return '可运行'
}
