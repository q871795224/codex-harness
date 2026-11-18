import { useEffect, useMemo, useState } from 'react'
import { Check, Gauge, LoaderCircle, RefreshCw, Shield, ShieldCheck, ShieldOff, Sparkles } from 'lucide-react'
import type { CodexRadarService } from '../../core/codex-radar/types'
import type { CodexModel, ThreadCodexSettings } from '../../core/domain/codex'
import type { NotificationService } from '../../core/notifications/store'
import type { HarnessPlugin, NewThreadPanelProps, PluginInstanceRecord, PluginStorage } from '../../extensions/types'

type LaunchMode = 'yolo' | 'auto-review' | 'manual'

export interface PickerRow {
  group: 'hard' | 'simple' | 'reference' | 'agi' | 'fallback'
  model: string
  effort: string
  score: number | null
  coverage: number | null
  requiredTasks?: number
  price: number | null
  minutes: number | null
  bestScore: boolean
  bestPrice: boolean
  bestMinutes: boolean
  automatic: boolean
  defaultCursor: boolean
  available?: boolean
}

// Keep the launcher compact and independent of website ranking changes.
const choices = [
  { group: 'reference', model: 'gpt-6.1-sol', effort: 'medium', defaultEligible: true },
  { group: 'reference', model: 'gpt-6.1-sol', effort: 'high', defaultEligible: true },
  { group: 'reference', model: 'gpt-6.2-sol', effort: 'medium', defaultEligible: true },
  { group: 'reference', model: 'gpt-6.1-terra', effort: 'max', defaultEligible: false },
  { group: 'agi', model: 'gpt-6.2-astra', effort: 'medium', defaultEligible: false },
  { group: 'agi', model: 'gpt-6-astra', effort: 'medium', defaultEligible: false },
  { group: 'simple', model: 'gpt-6-luna', effort: 'max', defaultEligible: false },
] as const

const yoloInitializedThreads = new Set<string>()
// Includes failed attempts so switching panels cannot restart automatic retries.
const defaultInitializedThreads = new Set<string>()

export const sessionLauncherPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.session-launcher',
    name: '会话启动器',
    description: '在新会话中按 Codex Radar 指标选择模型与推理强度，并切换 YOLO、Auto-review 或 Manual 模式。',
    version: '1.0.6',
    engine: { codexHarness: '^0.3.0' },
    supportedScopes: ['global', 'workspace', 'thread'],
    supportedProviders: ['codex'],
    permissions: ['network:codexradar.com'],
  },
  activate(ctx) {
    const radar = ctx.services.get<CodexRadarService>('harness.codexRadar')
    const notifications = ctx.services.get<NotificationService>('harness.notifications')
    ctx.slots.newThreadPanels.register({
      id: 'session-launcher',
      order: 10,
      render: (props) => <SessionLauncher radar={radar} storage={ctx.storage} notifications={notifications} {...props} />,
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

export function SessionLauncher({ radar, storage, notifications, threadId, workspaceRoot, isNewThread, models, settings, disabled, onSettingsChange }: NewThreadPanelProps & { radar: CodexRadarService; storage: PluginStorage; notifications: NotificationService }) {
  const [remoteRows, setRemoteRows] = useState<PickerRow[] | null>(null)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadedDefaultThread, setLoadedDefaultThread] = useState<string | null>(null)
  const rows = useMemo(() => availableRows(remoteRows, models), [models, remoteRows])
  const selectedRow = useMemo(() => selectedRadarRow(rows, settings), [rows, settings])
  const defaultRow = useMemo(() => defaultRadarRow(rows), [rows])
  const mode = threadId && !yoloInitializedThreads.has(threadId) ? 'yolo' : launchMode(settings)

  const load = async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      const table = await radar.modelTable(force)
      setRemoteRows(table.rows)
      setFetchedAt(table.fetchedAt)
      setWarnings(table.warnings ?? [])
    } catch (nextError) {
      if (!force) setRemoteRows([])
      setError(messageOf(nextError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (!threadId) return
    let disposed = false
    void storage.get<boolean>(`model-initialized:${threadId}`).then((initialized) => {
      if (disposed) return
      if (initialized) defaultInitializedThreads.add(threadId)
      setLoadedDefaultThread(threadId)
    }).catch((error) => { if (!disposed) setSettingsError(messageOf(error)) })
    return () => { disposed = true }
  }, [storage, threadId])

  useEffect(() => {
    if (!threadId || disabled || yoloInitializedThreads.has(threadId)) return
    yoloInitializedThreads.add(threadId)
    if (launchMode(settings) !== 'yolo') {
      void Promise.resolve(onSettingsChange(modePatch('yolo'))).catch((nextError) => setSettingsError(messageOf(nextError)))
    }
  }, [disabled, onSettingsChange, settings, threadId])

  useEffect(() => {
    if (!threadId || loadedDefaultThread !== threadId || !isNewThread || disabled || loading || models.length === 0 || !defaultRow || defaultInitializedThreads.has(threadId)) return
    defaultInitializedThreads.add(threadId)
    setSaving(true)
    void Promise.resolve().then(() => onSettingsChange({ model: defaultRow.model, effort: defaultRow.effort }))
      .then(() => storage.set(`model-initialized:${threadId}`, true)).catch((nextError) => {
        // Keep the attempt marked: rollback/rerender must not retry a failed initialization.
        setSettingsError(messageOf(nextError))
        notifications.publish({
          source: '会话启动器', level: 'error', title: '默认模型初始化未完成',
          message: '已停止自动重试，可在会话启动器中手动选择模型。',
          details: `模型：${defaultRow.model}；推理强度：${defaultRow.effort}\n${messageOf(nextError)}`,
          threadId, workspaceRoot,
        })
      }).finally(() => setSaving(false))
  }, [defaultRow, disabled, isNewThread, loading, loadedDefaultThread, models.length, notifications, onSettingsChange, storage, threadId, workspaceRoot])

  const apply = async (patch: Partial<ThreadCodexSettings>) => {
    if (disabled || saving) return
    const selectingModel = threadId && (patch.model !== undefined || patch.effort !== undefined)
    if (selectingModel) defaultInitializedThreads.add(threadId)
    setSaving(true)
    setSettingsError(null)
    try {
      await onSettingsChange(patch)
      if (selectingModel) await storage.set(`model-initialized:${threadId}`, true)
    } catch (nextError) {
      setSettingsError(messageOf(nextError))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="session-launcher" aria-label="Codex Radar 会话配置">
      <header className="session-launcher-head">
        <span><Sparkles size={14} /> CODEX RADAR{fetchedAt ? ` · cache ${cacheMinutes(fetchedAt)}m` : ''}</span>
        <button type="button" onClick={() => void load(true)} disabled={loading} title="刷新 Radar 数据" aria-label="刷新 Radar 数据">
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
          <thead><tr><th aria-label="selected" /><th>GROUP</th><th>MODEL</th><th title="雷达四项测试 · 满分 150">雷达分</th><th title="同轮四项测试的 API 等价总费用">COST</th><th title="同轮四项测试的模型总耗时">TIME</th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const selected = selectedRow?.model === row.model && selectedRow?.effort === row.effort
              return (
                <tr key={`${row.model}:${row.effort}`} className={[selected ? 'selected' : '', row.available === false ? 'unavailable' : ''].filter(Boolean).join(' ')}>
                  <td>{selected ? <Check size={14} /> : null}</td>
                  <td><span className={`radar-group ${row.group}`}>{groupLabel(row.group)}</span></td>
                  <td><button type="button" disabled={disabled || saving || row.available === false} title={row.available === false ? '当前模型目录暂不支持此档位' : row.model === 'gpt-6.1-terra' ? '仅作参考，不参与默认选择' : undefined} onClick={() => void apply({ model: row.model, effort: row.effort })}><strong>{modelLabel(row.model)}</strong> <span>{row.effort}{row.available === false ? ' · 暂不可用' : ''}</span></button></td>
                  <Metric title={row.coverage === null ? undefined : `覆盖 ${row.coverage}/${row.requiredTasks ?? 64} 道题`} value={row.score === null ? '—' : row.score.toFixed(1)} best={row.bestScore} tone="iq" />
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
        <span title={error ?? warnings.join('\n')} className={settingsError || error || warnings.length ? 'error' : ''}>{settingsError ?? (error ? (remoteRows?.length ? 'Radar 更新失败，保留上次数据。' : 'Radar 暂不可用，仍可手动选择可用模型。') : warnings.length ? `Radar 数据不完整：${warnings.length} 项获取失败，详情见日志。` : '雷达四项测试 · 满分 150 · COST 为四项测试 API 等价总费用 · ★ 最佳指标')}</span>
        <span className={`launch-mode-summary ${mode}`}><Gauge size={13} />{modeLabel(mode)}</span>
      </footer>
    </section>
  )
}

function ModeButton({ mode, selected, disabled, onSelect }: { mode: LaunchMode; selected: boolean; disabled: boolean; onSelect(): void }) {
  const Icon = mode === 'yolo' ? ShieldOff : mode === 'auto-review' ? ShieldCheck : Shield
  return <button type="button" role="radio" aria-checked={selected} title={modeDescription(mode)} className={selected ? `selected ${mode}` : ''} disabled={disabled} onClick={onSelect}><Icon size={14} /><span>{modeLabel(mode)}</span></button>
}

function Metric({ value, best, tone, title }: { value: string; best: boolean; tone: string; title?: string }) {
  return <td><span title={title} className={best ? `radar-best ${tone}` : ''}>{value}{best && <b aria-label="最佳指标">★</b>}</span></td>
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

export function selectedRadarRow(rows: PickerRow[], settings: Pick<ThreadCodexSettings, 'model' | 'effort'>): PickerRow | null {
  return rows.find((row) => row.model === settings.model && row.effort === settings.effort) ?? null
}

export function defaultRadarRow(rows: PickerRow[]): PickerRow | null {
  const ranked = rows.filter((row) => row.available !== false && choices.some((choice) => choice.defaultEligible && choice.model === row.model && choice.effort === row.effort)
    && row.coverage !== null && row.coverage / (row.requiredTasks ?? 64) > 40 / 64 && row.score !== null && Number.isFinite(row.score))
    .sort((left, right) => right.score! - left.score! || (left.price ?? Infinity) - (right.price ?? Infinity))
  const [highest, second] = ranked
  if (!highest) return null
  if (second && highest.score! - second.score! <= 2 && highest.price !== null && second.price !== null && second.price < highest.price) return second
  return highest
}

export function availableRows(remoteRows: PickerRow[] | null, models: CodexModel[]): PickerRow[] {
  if (remoteRows === null) return []
  const rows: PickerRow[] = choices.map(({ group, model, effort }) => {
    const measured = remoteRows.find((row) => row.model === model && row.effort === effort)
    return {
      score: null, coverage: null, price: null, minutes: null,
      ...measured, group, model, effort,
      available: modelSupports(models, model, effort),
      bestScore: false, bestPrice: false, bestMinutes: false, automatic: false, defaultCursor: false,
    }
  })
  // Stars describe the displayed comparisons, never hidden website entries.
  const compared = rows.filter((row) => row.group !== 'simple')
  for (const [metric, flag] of [['score', 'bestScore'], ['price', 'bestPrice'], ['minutes', 'bestMinutes']] as const) {
    const values = compared.flatMap((row) => row[metric] === null ? [] : [row[metric]!])
    if (!values.length) continue
    const best = metric === 'score' ? Math.max(...values) : Math.min(...values)
    for (const row of compared) row[flag] = row[metric] === best
  }
  return rows
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
  if (group === 'simple') return '简单任务'
  if (group === 'reference') return '参考模型'
  if (group === 'agi') return 'AGI 模型'
  return 'FALLBACK'
}

function modelLabel(model: string): string {
  if (model === 'gpt-6.2-sol') return '6.2 Sol'
  if (model === 'gpt-6.2-astra') return '6.2 Astra'
  if (model === 'gpt-6.1-terra') return '6.1 Terra'
  if (model === 'gpt-6.1-sol') return '6.1 Sol'
  if (model === 'gpt-6-sol') return '6 Sol'
  if (model === 'gpt-6-astra') return '6 Astra'
  if (model === 'gpt-6-luna') return '6 Luna'
  if (model === 'gpt-5.6-sol') return '5.6 Sol'
  if (model === 'gpt-5.6-terra') return '5.6 Terra'
  if (model === 'gpt-5.6-luna') return '5.6 Luna'
  if (model === 'gpt-5.5') return '5.5'
  return model
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
