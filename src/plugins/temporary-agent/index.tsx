import { useSyncExternalStore, useState } from 'react'
import { Bot, CircleHelp, ExternalLink, ListTodo, LoaderCircle, Play, RotateCcw, Square } from 'lucide-react'
import type { AgentRun, AgentRunMode, AgentRunService } from '../../core/agent-runs/types'
import type { HarnessPlugin, PluginInstanceRecord, PluginSettingsProps, PluginViewContext } from '../../extensions/types'

interface TemporaryAgentConfig {
  defaultMode: AgentRunMode
}

export const temporaryAgentPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.temporary-agent',
    name: '临时 Agent',
    description: '在独立 child thread 中运行后台任务，并可将委派结果回传主会话。',
    version: '1.0.0',
    engine: { codexHarness: '^0.1.0' },
    supportedScopes: ['global', 'workspace', 'thread'],
  },
  settings: TemporaryAgentSettings,
  activate(ctx) {
    const service = ctx.services.get<AgentRunService>('harness.agentRuns')
    const defaultMode = readConfig(ctx.config).defaultMode
    ctx.slots.conversationTabs.register({
      id: 'temporary-agent',
      label: '任务',
      order: 30,
      icon: ListTodo,
      render: (props) => <TemporaryAgentTab service={service} instanceId={ctx.instanceId} defaultMode={defaultMode} context={props} />,
    })
    ctx.slots.composerActions.register({
      id: 'temporary-agent',
      order: 20,
      render: (props) => <TemporaryAgentAction service={service} instanceId={ctx.instanceId} defaultMode={defaultMode} context={props} />,
    })
  },
}

export const temporaryAgentDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.temporary-agent:default',
  pluginId: temporaryAgentPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: { defaultMode: 'detached' },
  createdAt: 0,
  updatedAt: 0,
}

function TemporaryAgentTab({ service, instanceId, defaultMode, context }: {
  service: AgentRunService
  instanceId: string
  defaultMode: AgentRunMode
  context: PluginViewContext
}) {
  const runs = useSyncExternalStore(service.subscribe, service.snapshot)
    .filter((run) => run.instanceId === instanceId)
  return (
    <div className="agent-runs-scroll">
      <div className="agent-runs-content">
        <header className="agent-runs-heading">
          <div><h2>临时 Agent</h2><p>任务运行在独立 Codex thread，切换页面不会中断。</p></div>
        </header>
        <AgentRunLauncher service={service} instanceId={instanceId} defaultMode={defaultMode} context={context} />
        <section className="agent-run-list" aria-label="临时 Agent 任务">
          {runs.length === 0 ? <div className="agent-run-empty">还没有临时任务。</div> : runs.map((run) => <AgentRunCard key={run.runId} run={run} service={service} />)}
        </section>
      </div>
    </div>
  )
}

function TemporaryAgentAction({ service, instanceId, defaultMode, context }: {
  service: AgentRunService
  instanceId: string
  defaultMode: AgentRunMode
  context: PluginViewContext & { disabled: boolean }
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="plugin-composer-action">
      <button type="button" className="composer-plugin-button" disabled={context.disabled || !context.workspaceRoot} onClick={() => setOpen((value) => !value)} title="启动临时 Agent">
        <Bot size={15} />
      </button>
      {open && (
        <div className="agent-launcher-popover">
          <div className="agent-launcher-popover-head"><strong>启动临时 Agent</strong><button type="button" onClick={() => setOpen(false)}>关闭</button></div>
          <AgentRunLauncher service={service} instanceId={instanceId} defaultMode={defaultMode} context={context} compact onStarted={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}

function AgentRunLauncher({ service, instanceId, defaultMode, context, compact = false, onStarted }: {
  service: AgentRunService
  instanceId: string
  defaultMode: AgentRunMode
  context: PluginViewContext
  compact?: boolean
  onStarted?: () => void
}) {
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<AgentRunMode>(defaultMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canStart = Boolean(prompt.trim() && context.workspaceRoot && (mode === 'detached' || context.threadId))

  const start = async () => {
    if (!canStart || !context.workspaceRoot) return
    setBusy(true)
    setError(null)
    try {
      await service.start({
        instanceId,
        mode,
        workspaceRoot: context.workspaceRoot,
        parentThreadId: mode === 'delegated' ? context.threadId : null,
        prompt,
      })
      setPrompt('')
      onStarted?.()
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`agent-run-launcher ${compact ? 'compact' : ''}`}>
      <div className="agent-run-mode" role="radiogroup" aria-label="任务模式">
        <button type="button" className={mode === 'detached' ? 'selected' : ''} onClick={() => setMode('detached')}>独立运行</button>
        <button type="button" disabled={!context.threadId} className={mode === 'delegated' ? 'selected' : ''} onClick={() => setMode('delegated')}>委派并回传</button>
      </div>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述要交给临时 Agent 的任务…" rows={compact ? 3 : 4} />
      <div className="agent-run-launcher-foot">
        <span>{context.workspaceRoot ?? '当前会话没有 workspace'}</span>
        <button type="button" disabled={!canStart || busy} onClick={() => void start()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}{busy ? '启动中' : '启动'}</button>
      </div>
      {error && <div className="agent-run-error">{error}</div>}
    </section>
  )
}

function AgentRunCard({ run, service }: { run: AgentRun; service: AgentRunService }) {
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = run.status === 'starting' || run.status === 'running' || run.status === 'waitingApproval'

  const action = async (callback: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try { await callback() } catch (nextError) { setError(messageOf(nextError)) } finally { setBusy(false) }
  }

  return (
    <article className="agent-run-card">
      <header><span className={`agent-run-dot ${run.status}`} /><div><strong>{run.title}</strong><small>{run.mode === 'delegated' ? '委派任务' : '独立任务'} · {runStatusLabel(run.status)}</small></div></header>
      <div className="agent-run-actions">
        {run.childThreadId && <button type="button" onClick={() => service.openThread(run.childThreadId!)}><ExternalLink size={13} />打开会话</button>}
        {running && <button type="button" disabled={busy || !run.turnId} onClick={() => void action(() => service.cancel(run.runId))}><Square size={12} />停止</button>}
        {run.status === 'completed' && <button type="button" disabled={busy} onClick={() => void action(async () => setResult(await service.loadResult(run.runId)))}><RotateCcw size={13} />读取结果</button>}
        {run.mode === 'delegated' && run.status === 'completed' && !run.returnedAt && <button type="button" className="primary" disabled={busy} onClick={() => void action(() => service.returnToParent(run.runId))}>回传主 Agent</button>}
        {run.returnedAt && <span className="agent-run-returned">已回传</span>}
      </div>
      {(run.errorSummary || error) && <div className="agent-run-error">{error ?? run.errorSummary}</div>}
      {result && <pre className="agent-run-result">{result}</pre>}
    </article>
  )
}

function TemporaryAgentSettings({ instance, saveConfig }: PluginSettingsProps) {
  const config = readConfig(instance.config)
  return (
    <div className="plugin-business-settings">
      <label className="plugin-setting-row">
        <span>默认运行模式 <i className="plugin-field-help" title="委派模式会把结果回传到当前会话；独立运行不会关联父会话。"><CircleHelp size={13} /></i></span>
        <select value={config.defaultMode} onChange={(event) => void saveConfig({ ...instance.config, defaultMode: event.target.value })}>
          <option value="detached">独立运行</option>
          <option value="delegated">委派并回传</option>
        </select>
      </label>
    </div>
  )
}

function readConfig(config: Readonly<Record<string, unknown>>): TemporaryAgentConfig {
  return { defaultMode: config.defaultMode === 'delegated' ? 'delegated' : 'detached' }
}

function runStatusLabel(status: AgentRun['status']): string {
  if (status === 'starting') return '正在创建会话'
  if (status === 'running') return '运行中'
  if (status === 'waitingApproval') return '等待审批'
  if (status === 'completed') return '已完成'
  if (status === 'cancelled') return '已停止'
  return '失败'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
