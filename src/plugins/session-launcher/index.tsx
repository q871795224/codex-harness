import { useEffect, useMemo, useState } from 'react'
import { Check, Gauge, LoaderCircle, RefreshCw, Shield, ShieldCheck, ShieldOff, Sparkles } from 'lucide-react'
import type { CodexRadarService } from '../../core/codex-radar/types'
import type { CodexModel, ThreadCodexSettings } from '../../core/domain/codex'
import type { HarnessPlugin, NewThreadPanelProps, PluginInstanceRecord } from '../../extensions/types'

type LaunchMode = 'yolo' | 'auto-review' | 'manual'

interface PickerRow {
  group: 'hard' | 'reference' | 'fallback'
  model: string
  effort: string
  iq: number | null
  price: number | null
  minutes: number | null
  bestIq: boolean
  bestPrice: boolean
  bestMinutes: boolean
  automatic: boolean
  defaultCursor: boolean
}

export const sessionLauncherPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.session-launcher',
    name: '会话启动器',
    description: '在新会话中按 Codex Radar 指标选择模型与推理强度，并切换 YOLO、Auto-review 或 Manual 模式。',
    version: '1.0.0',
    engine: { codexHarness: '^0.3.0' },
    supportedScopes: ['global', 'workspace', 'thread'],
    permissions: ['network:codexradar.com'],
  },
  activate(ctx) {
    const radar = ctx.services.get<CodexRadarService>('harness.codexRadar')
    ctx.slots.newThreadPanels.register({
      id: 'session-launcher',
      order: 10,
      render: (props) => <SessionLauncher radar={radar} {...props} />,
    })
  },
}

export const sessionLauncherDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.session-launcher:default',
  pluginId: sessionLauncherPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

function SessionLauncher({ radar, models, settings, disabled, onSettingsChange }: NewThreadPanelProps & { radar: CodexRadarService }) {
  const [remoteRows, setRemoteRows] = useState<PickerRow[] | null>(null)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const rows = useMemo(() => availableRows(remoteRows, models, settings), [models, remoteRows, settings])
  const mode = launchMode(settings)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const table = await radar.modelTable()
      setRemoteRows(table.rows)
      setFetchedAt(table.fetchedAt)
    } catch (nextError) {
      setRemoteRows([])
      setError(messageOf(nextError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const apply = async (patch: Partial<ThreadCodexSettings>) => {
    if (disabled || saving) return
    setSaving(true)
    setSettingsError(null)
    try {
      await onSettingsChange(patch)
    } catch (nextError) {
      setSettingsError(messageOf(nextError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="session-launcher" aria-label="Codex Radar 会话配置">
      <header className="session-launcher-head">
        <div>
          <span><Sparkles size={13} /> CODEX RADAR{fetchedAt ? ` · cache ${cacheMinutes(fetchedAt)}m` : ''}</span>
          <h3>选择这次会话的运行方式</h3>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} title="刷新 Radar 数据" aria-label="刷新 Radar 数据">
          <RefreshCw className={loading ? 'spin' : ''} size={14} />
        </button>
      </header>

      <div className="launch-mode-switch" role="radiogroup" aria-label="运行模式">
        <ModeButton mode="yolo" selected={mode === 'yolo'} disabled={disabled || saving} onSelect={() => void apply(modePatch('yolo'))} />
        <ModeButton mode="auto-review" selected={mode === 'auto-review'} disabled={disabled || saving} onSelect={() => void apply(modePatch('auto-review'))} />
        <ModeButton mode="manual" selected={mode === 'manual'} disabled={disabled || saving} onSelect={() => void apply(modePatch('manual'))} />
      </div>

      <div className="radar-table-wrap">
        <table className="radar-table">
          <thead><tr><th aria-label="selected" /><th>GROUP</th><th>MODEL</th><th>IQ</th><th>COST</th><th>TIME</th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const selected = row.model === settings.model && row.effort === settings.effort
              return (
                <tr key={`${row.model}:${row.effort}`} className={selected ? 'selected' : ''}>
                  <td>{selected ? <Check size={14} /> : null}</td>
                  <td><span className={`radar-group ${row.group}`}>{groupLabel(row.group)}</span></td>
                  <td><button type="button" disabled={disabled || saving} onClick={() => void apply({ model: row.model, effort: row.effort })}><strong>{modelLabel(row.model)}</strong> <span>{row.effort}</span></button></td>
                  <Metric value={row.iq === null ? '—' : row.iq.toFixed(1)} best={row.bestIq} tone="iq" />
                  <Metric value={row.price === null ? '—' : `$${row.price.toFixed(2)}`} best={row.bestPrice} tone="price" />
                  <Metric value={row.minutes === null ? '—' : `${Math.round(row.minutes)}m`} best={row.bestMinutes} tone="time" />
                </tr>
              )
            })}
          </tbody>
        </table>
        {loading && <div className="radar-table-state"><LoaderCircle className="spin" size={15} />正在加载 Radar 指标…</div>}
      </div>
      <footer className="session-launcher-foot">
        <span className={settingsError ? 'error' : ''}>{settingsError ?? (error ? 'Radar 暂不可用，已显示 App Server 模型。' : '★ 表示当前表格中的最佳指标')}</span>
        <span className={`launch-mode-summary ${mode}`}><Gauge size={13} />{modeLabel(mode)}</span>
      </footer>
    </section>
  )
}

function ModeButton({ mode, selected, disabled, onSelect }: { mode: LaunchMode; selected: boolean; disabled: boolean; onSelect(): void }) {
  const Icon = mode === 'yolo' ? ShieldOff : mode === 'auto-review' ? ShieldCheck : Shield
  return <button type="button" role="radio" aria-checked={selected} title={modeDescription(mode)} className={selected ? `selected ${mode}` : ''} disabled={disabled} onClick={onSelect}><Icon size={14} /><span>{modeLabel(mode)}</span></button>
}

function Metric({ value, best, tone }: { value: string; best: boolean; tone: string }) {
  return <td><span className={best ? `radar-best ${tone}` : ''}>{value}{best && '★'}</span></td>
}

export function modePatch(mode: LaunchMode): Partial<ThreadCodexSettings> {
  if (mode === 'yolo') return { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxMode: 'danger-full-access' }
  if (mode === 'auto-review') return { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxMode: 'workspace-write' }
  return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxMode: 'workspace-write' }
}

export function launchMode(settings: ThreadCodexSettings): LaunchMode {
  if (settings.approvalPolicy === 'never' && settings.sandboxMode === 'danger-full-access') return 'yolo'
  if (settings.approvalPolicy === 'on-request' && settings.approvalsReviewer === 'auto_review') return 'auto-review'
  return 'manual'
}

function availableRows(remoteRows: PickerRow[] | null, models: CodexModel[], settings: ThreadCodexSettings): PickerRow[] {
  if (remoteRows === null) return []
  const supported = remoteRows.filter((row) => modelSupports(models, row.model, row.effort))
  if (supported.length > 0) return supported
  const preferred = models.find((model) => model.model === 'gpt-5.6-sol') ?? models.find((model) => model.model === settings.model) ?? models[0]
  if (!preferred) return []
  const effort = preferred.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === 'xhigh')
    ? 'xhigh'
    : preferred.defaultReasoningEffort
  return [{
    group: 'fallback', model: preferred.model, effort, iq: null, price: null, minutes: null,
    bestIq: false, bestPrice: false, bestMinutes: false, automatic: false, defaultCursor: true,
  }]
}

function modelSupports(models: CodexModel[], modelId: string, effort: string): boolean {
  return models.some((model) => model.model === modelId
    && model.supportedReasoningEfforts.some((candidate) => candidate.reasoningEffort === effort))
}

function modeLabel(mode: LaunchMode): string {
  if (mode === 'yolo') return 'YOLO'
  if (mode === 'auto-review') return 'AUTO-REVIEW'
  return 'MANUAL'
}

function modeDescription(mode: LaunchMode): string {
  if (mode === 'yolo') return 'Never ask for approval · Danger full access'
  if (mode === 'auto-review') return 'On request · Auto review · Workspace write'
  return 'On request · User review · Workspace write'
}

function cacheMinutes(fetchedAt: number): number {
  return Math.max(0, Math.floor((Date.now() / 1000 - fetchedAt) / 60))
}

function groupLabel(group: PickerRow['group']): string {
  if (group === 'hard') return '复杂任务'
  if (group === 'reference') return '参考模型'
  return 'FALLBACK'
}

function modelLabel(model: string): string {
  if (model === 'gpt-5.6-sol') return 'Sol'
  if (model === 'gpt-5.6-terra') return 'Terra'
  if (model === 'gpt-5.6-luna') return 'Luna'
  if (model === 'gpt-5.5') return '5.5'
  return model
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
