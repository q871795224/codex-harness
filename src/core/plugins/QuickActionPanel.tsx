import { useEffect, useState, useSyncExternalStore } from 'react'
import { Bot, Check, ChevronDown, ChevronRight, CircleAlert, Copy, LoaderCircle, Play, Reply, SquareCode, Trash2 } from 'lucide-react'
import type { AgentRun, AgentRunService } from '../agent-runs/types'
import type { QuickActionProps } from '../../extensions/types'
import type { ResolvedContribution } from './runtime'
import type { QuickActionContribution } from '../../extensions/types'

interface QuickActionPanelProps {
  actions: ResolvedContribution<QuickActionContribution>[]
  context: QuickActionProps
  agentRuns: AgentRunService
  anchorBottom?: number
}

export function QuickActionPanel({ actions, context, agentRuns, anchorBottom }: QuickActionPanelProps) {
  const [open, setOpen] = useState(false)
  const [startingId, setStartingId] = useState<string | null>(null)
  const [expandedInstanceId, setExpandedInstanceId] = useState<string | null>(null)
  const [runActionId, setRunActionId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const runs = useSyncExternalStore(agentRuns.subscribe, agentRuns.snapshot)
  const hasActiveRuns = runs.some(isActiveRun)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!open || !hasActiveRuns) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [hasActiveRuns, open])
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

  const copyBranch = async (run: AgentRun) => {
    setRunActionId(`copy:${run.runId}`)
    setError(null)
    try {
      const delivery = await agentRuns.deliveryContext(run.runId)
      if (!delivery.branch) throw new Error('当前 worktree 没有可复制的分支')
      await navigator.clipboard.writeText(delivery.branch)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setRunActionId(null)
    }
  }

  const removeWorkspace = async (run: AgentRun) => {
    if (!window.confirm('移除这个隔离 worktree？未提交改动会阻止清理，分支会保留。')) return
    setRunActionId(`remove:${run.runId}`)
    setError(null)
    try {
      await agentRuns.removeWorkspace(run.runId)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setRunActionId(null)
    }
  }

  const returnResult = async (run: AgentRun) => {
    setRunActionId(`return:${run.runId}`)
    setError(null)
    try {
      await agentRuns.returnToParent(run.runId)
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setRunActionId(null)
    }
  }

  return (
    <div className={`quick-action-dock${open ? ' open' : ''}`} style={anchorBottom === undefined ? undefined : { bottom: anchorBottom }}>
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
              const actionRuns = runsForQuickAction(runs, action.instanceId, context.threadId)
              const activeRuns = actionRuns.filter(isActiveRun)
              const activeCount = activeRuns.length
              const status = quickActionRunsStatus(actionRuns, startingId === action.contribution.id)
              const expanded = expandedInstanceId === action.instanceId
              const accessibleLabel = `${action.contribution.label} · ${activeCount > 0 ? `运行中 ${activeCount}` : quickActionStatusLabel(status)}`
              return (
                <div className="quick-action-entry" key={`${action.pluginId}:${action.contribution.id}`}>
                  <div className="quick-action-row">
                    <button
                      className="quick-action-launch"
                      type="button"
                      disabled={context.disabled || startingId !== null}
                      onClick={() => void run(action)}
                      title={accessibleLabel}
                      aria-label={`启动 ${action.contribution.label}`}
                    >
                      <span className={`quick-action-play ${status}`}>
                        {status === 'running' ? <LoaderCircle className="spin" size={14} />
                          : status === 'completed' ? <Check size={14} />
                            : status === 'failed' ? <CircleAlert size={14} />
                              : <Play size={13} fill="currentColor" />}
                      </span>
                      <strong>{action.contribution.label}</strong>
                    </button>
                    {shouldShowRunGroup(actionRuns) && (
                      <button
                        className={`quick-action-runs-toggle${activeCount > 0 ? ' active' : ''}`}
                        type="button"
                        aria-expanded={expanded}
                        aria-label={`${action.contribution.label}，${activeCount > 0 ? `${activeCount} 个运行中任务` : `${actionRuns.length} 条运行记录`}`}
                        onClick={() => setExpandedInstanceId(expanded ? null : action.instanceId)}
                      >
                        <span>{activeCount > 0 ? `运行中 ${activeCount}` : `记录 ${actionRuns.length}`}</span>
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                    )}
                  </div>
                  {expanded && (
                    <div className="quick-action-runs">
                      {actionRuns.slice(0, 5).map((run, index) => {
                        const isolated = run.workspaceAccess === 'isolated-delivery'
                        const workspaceAvailable = isolated && !run.workspaceRemovedAt
                        const canReturn = run.mode === 'delegated' && run.status === 'completed' && !run.returnedAt
                        return (
                          <div className="quick-action-run" key={run.runId}>
                            <button
                              className="quick-action-run-thread"
                              type="button"
                              disabled={!run.childThreadId}
                              onClick={() => run.childThreadId && agentRuns.openThread(run.childThreadId)}
                              title={run.childThreadId ? '打开独立会话' : '独立会话正在创建'}
                            >
                              <span>#{actionRuns.length - index}</span>
                              <strong>{quickActionRunLabel(run.status)}</strong>
                              {isActiveRun(run) ? <small>{formatElapsed(now - run.createdAt)}</small>
                                : run.returnedAt ? <small>已回传</small>
                                  : run.workspaceRemovedAt ? <small>已清理</small> : null}
                            </button>
                            {(isolated || canReturn) && (
                              <div className="quick-action-run-tools">
                                {canReturn && <button type="button" disabled={runActionId !== null} onClick={() => void returnResult(run)} title="回传结果到当前会话" aria-label="回传结果到当前会话">{runActionId === `return:${run.runId}` ? <LoaderCircle className="spin" size={11} /> : <Reply size={11} />}</button>}
                                {workspaceAvailable && <button type="button" disabled={runActionId !== null} onClick={() => void agentRuns.openWorkspace(run.runId).catch((nextError) => setError(messageOf(nextError)))} title="在 GoLand 中打开 worktree" aria-label="在 GoLand 中打开 worktree"><SquareCode size={11} /></button>}
                                <button type="button" disabled={runActionId !== null} onClick={() => void copyBranch(run)} title="复制隔离分支" aria-label="复制隔离分支">{runActionId === `copy:${run.runId}` ? <LoaderCircle className="spin" size={11} /> : <Copy size={11} />}</button>
                                {workspaceAvailable && isTerminalRun(run) && <button type="button" disabled={runActionId !== null} onClick={() => void removeWorkspace(run)} title="安全清理 worktree（保留分支）" aria-label="安全清理 worktree">{runActionId === `remove:${run.runId}` ? <LoaderCircle className="spin" size={11} /> : <Trash2 size={11} />}</button>}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
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

export function runsForQuickAction(runs: AgentRun[], instanceId: string, parentThreadId: string | null): AgentRun[] {
  if (!parentThreadId) return []
  return runs.filter((run) => run.instanceId === instanceId && run.parentThreadId === parentThreadId)
}

export function quickActionRunsStatus(runs: AgentRun[], starting: boolean): 'idle' | 'running' | 'completed' | 'failed' {
  if (starting || runs.some(isActiveRun)) return 'running'
  return quickActionRunStatus(runs[0], false)
}

export function quickActionRunStatus(run: AgentRun | undefined, starting: boolean): 'idle' | 'running' | 'completed' | 'failed' {
  if (starting || run?.status === 'starting' || run?.status === 'running' || run?.status === 'waitingApproval') return 'running'
  if (run?.status === 'completed') return 'completed'
  if (run?.status === 'failed' || run?.status === 'cancelled') return 'failed'
  return 'idle'
}

export function shouldShowRunGroup(runs: AgentRun[]): boolean {
  return runs.length > 0
}

function quickActionStatusLabel(status: 'idle' | 'running' | 'completed' | 'failed'): string {
  if (status === 'running') return '运行中'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  return '可运行'
}

function quickActionRunLabel(status: AgentRun['status']): string {
  if (status === 'starting') return '启动中'
  if (status === 'running') return '运行中'
  if (status === 'waitingApproval') return '等待审批'
  if (status === 'completed') return '已完成'
  if (status === 'cancelled') return '已取消'
  return '失败'
}

function isActiveRun(run: AgentRun): boolean {
  return run.status === 'starting' || run.status === 'running' || run.status === 'waitingApproval'
}

function isTerminalRun(run: AgentRun): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
