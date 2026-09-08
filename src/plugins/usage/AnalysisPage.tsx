import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react'
import type { AnalyticsCosts, AnalyticsHotspot, CodexAnalyticsQuery, CodexAnalyticsService, CodexAnalyticsSnapshot, HotspotKind } from '../../core/codex-analytics/types'
import type { ConversationService } from '../../core/conversations/types'
import { threadTitle, type Thread } from '../../core/domain/codex'
import type { UsageService } from '../../core/usage/types'
import { usageDateRange } from './history'
import { SourceCards } from './SourceCards'
import { formatTokens as format, cacheRate, workspaceName, modelName, modelColor, calendarDays } from './format'
import './analysis.css'

type View = 'overview' | 'models' | 'workspaces' | HotspotKind | 'sessions'
const VIEWS: Array<[View, string]> = [['overview', '总览'], ['models', '模型'], ['workspaces', '工作区'], ['skill', 'Skill'], ['mcp', 'MCP'], ['agents', 'AGENTS.md'], ['sessions', '会话']]
const KINDS: Array<[HotspotKind, string]> = [['skill', 'Skill'], ['mcp', 'MCP'], ['agents', 'AGENTS.md']]
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
export function dateBounds(since: string, until: string): { since: number; until: number } | null {
  const start = since ? new Date(`${since}T00:00:00`) : new Date(0)
  const end = new Date(`${until}T00:00:00`)
  end.setDate(end.getDate() + 1)
  return Number.isFinite(+start) && Number.isFinite(+end) && +start < +end ? { since: +start, until: +end } : null
}
function useAnalysis(service: CodexAnalyticsService, query: CodexAnalyticsQuery | null) {
  const key = JSON.stringify(query)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<{ key: string; data: CodexAnalyticsSnapshot } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!query) return
    let cancelled = false
    setLoading(true); setError(null)
    service.snapshot(query).then((data) => { if (!cancelled) setResult({ key, data }) })
      .catch((error: unknown) => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [service, key, revision])
  useEffect(() => { const timer = window.setInterval(() => setRevision((r) => r + 1), 30_000); return () => window.clearInterval(timer) }, [])
  return { snapshot: query && result?.key === key ? result.data : null, error, loading, refresh: () => setRevision((r) => r + 1) }
}
export function AnalysisPage({ service, usage, conversations, threads }: { service: CodexAnalyticsService; usage: UsageService; conversations: ConversationService; threads: Thread[] }) {
  const [range, setRange] = useState<'7d' | '30d' | 'month'>('30d')
  const [revision, setRevision] = useState(0)
  const dates = usageDateRange(range)
  const [day, setDay] = useState<string | null>(null)
  const [model, setModel] = useState<string | undefined>()
  const [workspace, setWorkspace] = useState<string | undefined>()
  const [view, setView] = useState<View>('overview')
  const [hotspot, setHotspot] = useState<AnalyticsHotspot | null>(null)
  const [sort, setSort] = useState<'tokensDesc' | 'tokensAsc' | 'recent'>('tokensDesc')
  const [offset, setOffset] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const bounds = dateBounds(day || dates.since, day || dates.until)!
  const query = useMemo(() => ({ ...bounds, model, workspace, kind: hotspot?.kind, name: hotspot?.name, sort: view === 'overview' ? 'tokensDesc' as const : sort, offset }), [bounds.since, bounds.until, model, workspace, hotspot?.kind, hotspot?.name, offset, sort, view])
  const { snapshot, error, loading, refresh } = useAnalysis(service, query)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    let cancelled = false
    setMetadataError(null)
    void service.refreshMetadata().then((missing) => {
      if (!cancelled) { if (missing) setMetadataError(`${missing} 个会话的名称或工作区暂未补全`); refreshRef.current() }
    }).catch(() => { if (!cancelled) setMetadataError('会话名称与工作区补查失败，可稍后刷新') })
    return () => { cancelled = true }
  }, [service, revision])
  const labels = useMemo(() => new Map(threads.map((t) => [t.id, threadTitle(t)])), [threads])
  const name = useCallback((id: string) => labels.get(id) || snapshot?.sessions.find((s) => s.threadId === id)?.title || `会话 ${id.slice(0, 8)}`, [labels, snapshot])
  const clearFilters = () => { setDay(null); setModel(undefined); setWorkspace(undefined); setHotspot(null); setOffset(0) }
  const chooseView = (next: View) => { setView(next); clearFilters() }
  const selectModel = (value: string | null) => { setModel(value ?? ''); setOffset(0); setView('sessions') }
  const selectWorkspace = (value: string) => { setWorkspace(value); setOffset(0); setView('sessions') }
  const selectHotspot = (value: AnalyticsHotspot, path?: string) => { setHotspot(value); setWorkspace(path); setOffset(0); setView('sessions') }
  const total = snapshot?.summary.actual.totalTokens ?? 0
  const filtered = day || model !== undefined || workspace !== undefined || hotspot
  return <div className="analysis-scroll"><div className="analysis-page">
    <header className="analysis-heading"><h2>用量分析</h2><div><span>Harness · Codex</span><select aria-label="时间范围" value={range} onChange={(e) => { setRange(e.target.value as typeof range); clearFilters() }}><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="month">本月</option></select><button type="button" onClick={() => { setRevision((r) => r + 1); refresh() }} disabled={loading} aria-label="刷新分析"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button></div></header>
    <SourceCards service={usage} since={dates.since} until={dates.until} revision={revision} />
    <nav className="analysis-nav" aria-label="分析视图">{VIEWS.map(([id, label]) => <button type="button" key={id} aria-pressed={view === id} onClick={() => chooseView(id)}>{label}</button>)}</nav>
    {view === 'sessions' && <div className="analysis-filters"><label>模型 <select aria-label="模型筛选" value={model === undefined ? '__all' : model} onChange={(e) => { setModel(e.target.value === '__all' ? undefined : e.target.value); setOffset(0) }}><option value="__all">全部模型</option><option value="">未记录模型</option>{snapshot?.availableModels.map((m) => <option key={m}>{m}</option>)}</select></label>{filtered && <span className="analysis-filter-tag">{[day, model !== undefined ? modelName(model || null) : '', workspace !== undefined ? workspaceName(workspace) : '', hotspot?.name].filter(Boolean).join(' · ')}<button type="button" aria-label="清除筛选" onClick={clearFilters}><X size={14} /></button></span>}</div>}
    {error && <p className="analysis-error" role="alert">{error}</p>}
    {loading && !snapshot && <Empty>正在读取…</Empty>}
    {snapshot && <>
      {(snapshot.droppedEvents > 0 || snapshot.writeErrors > 0 || snapshot.summary.incompleteTurns > 0) && <div className="analysis-warning" title={`丢弃事件 ${snapshot.droppedEvents} · 写入失败 ${snapshot.writeErrors} · 用量异常轮次 ${snapshot.summary.incompleteTurns}`}>部分统计不完整</div>}
      {view === 'overview' && <>
        <div className="analysis-metrics"><Metric label="总 Token" value={format(total)} title={`${total.toLocaleString()} Token · 输入与输出之和，缓存输入不重复相加`} /><Metric label="缓存命中率" value={cacheRate(snapshot.summary.actual.inputTokens, snapshot.summary.actual.cachedInputTokens)} title="缓存输入 / 全部输入" /><Metric label="会话 / 轮次" value={`${snapshot.summary.sessions} / ${snapshot.summary.turns}`} /><Metric label="输入 / 输出" value={`${format(snapshot.summary.actual.inputTokens)} / ${format(snapshot.summary.actual.outputTokens)}`} /></div>
        <div className="analysis-columns"><Panel title="每日消耗" action={<button className="analysis-link" onClick={() => chooseView('models')}>查看模型 →</button>}><Trend snapshot={snapshot} since={dates.since} until={dates.until} onDay={(date) => { setDay(date); setOffset(0); setView('sessions') }} /></Panel><Panel title="输入与输出"><Composition snapshot={snapshot} /></Panel></div>
        <Panel title="工作区用量" action={<button className="analysis-link" onClick={() => chooseView('workspaces')}>查看工作区 →</button>}><Workspaces rows={snapshot.workspaces.slice(0, 5)} onSelect={selectWorkspace} /></Panel>
        <div className="analysis-resource-summaries">{KINDS.map(([kind, label]) => <Panel key={kind} title={label} action={<button className="analysis-link" onClick={() => chooseView(kind)}>查看 →</button>}><ResourceSummary rows={snapshot.hotspots.filter((h) => h.kind === kind)} kind={kind} onSelect={selectHotspot} /></Panel>)}</div>
        <Panel title="高消耗会话" action={<button className="analysis-link" type="button" onClick={() => chooseView('sessions')}>查看会话 →</button>}><Sessions rows={snapshot.sessions.slice(0, 5)} name={name} onSelect={setDetailId} /></Panel>
      </>}
      {view === 'models' && <>
        <div className="analysis-columns"><Panel title="模型 Token 占比"><ModelPie rows={snapshot.models.map((m) => ({ model: m.model, value: m.actual.totalTokens }))} label="Token" availableModels={snapshot.availableModels} onSelect={selectModel} /></Panel><Panel title="模型估算额度占比"><ModelCosts service={service} query={query} revision={revision} availableModels={snapshot.availableModels} onSelect={selectModel} /></Panel></div>
        <Panel title="模型用量"><Table headers={['配置模型', '会话', '轮次', '总 Token', '输入', '输出', '缓存命中率', '用户输入 Token ≈']}>{snapshot.models.map((m) => <tr key={m.model ?? ''}><td><button className="analysis-link" onClick={() => selectModel(m.model)}>{modelName(m.model)}</button>{m.reroutedTurns > 0 && <Badge title="配置模型与实际路由可能不同">重路由</Badge>}</td><td>{m.sessions}</td><td>{m.turns}</td><td title={m.actual.totalTokens.toLocaleString()}>{format(m.actual.totalTokens)}</td><td>{format(m.actual.inputTokens)}</td><td>{format(m.actual.outputTokens)}</td><td>{cacheRate(m.actual.inputTokens, m.actual.cachedInputTokens)}</td><td title="用户文本的独立计数，不等于模型全部输入">{m.inputContentIncomplete && !m.inputContentTokens ? '—' : format(m.inputContentTokens)}{m.inputContentIncomplete && <Badge>部分</Badge>}</td></tr>)}</Table>{!snapshot.models.length && <Empty />}</Panel>
      </>}
      {view === 'workspaces' && <Panel title="工作区用量"><Workspaces rows={snapshot.workspaces} onSelect={selectWorkspace} /></Panel>}
      {(view === 'skill' || view === 'mcp' || view === 'agents') && <Panel title={view === 'skill' ? 'Skill 使用' : view === 'mcp' ? 'MCP 调用' : 'AGENTS.md 读取'}><p className="analysis-note">{view === 'skill' ? '显式选择与观测读取分别统计，不相加为调用次数。展开查看使用工作区。' : view === 'agents' ? '仅统计观测到的显式读取，自动加载未采集。' : '统计已观测工具调用及失败，展开查看使用工作区。'}</p><Hotspots rows={snapshot.hotspots.filter((h) => h.kind === view)} kind={view} onSelect={selectHotspot} /></Panel>}
      {view === 'sessions' && <Panel title="会话消耗" action={<label>{snapshot.totalSessions} 个会话 <select aria-label="会话排序" value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); setOffset(0) }}><option value="tokensDesc">Token 从高到低</option><option value="tokensAsc">Token 从低到高</option><option value="recent">最近执行</option></select></label>}><Sessions rows={snapshot.sessions} name={name} onSelect={setDetailId} /><Pagination offset={offset} total={snapshot.totalSessions} onChange={setOffset} /></Panel>}
      <footer className="analysis-footer"><span>Harness 精细统计 · 采集起点 {new Date(snapshot.capturedSince).toLocaleDateString()}{metadataError && <small>{metadataError}</small>}</span><details><summary>统计口径</summary><p>仅统计 Harness 执行期记录。缓存输入包含在输入中，推理包含在输出中。≈ 为用户文本独立计数，不等同实际消耗。Skill 选择与读取分别统计；AGENTS.md 自动加载未采集。工作区使用会话绑定路径。模型按执行时配置记录，重路由单独标记。包含标题生成等内部轮次。上方账号历史与此处范围不同，不相加。</p><p>计数器：{snapshot.counter.mode === 'official' ? '官方接口' : '本地'}{snapshot.officialFallbacks > 0 ? ` · 回退 ${snapshot.officialFallbacks} 次` : ''}</p></details></footer>
    </>}
    {detailId && <SessionDetail id={detailId} title={name(detailId)} query={query} service={service} conversations={conversations} onClose={() => setDetailId(null)} />}
  </div></div>
}

function Metric({ label, value, title }: { label: string; value: string; title?: string }) { return <div title={title}><span>{label}</span><strong>{value}</strong></div> }
function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <section className="analysis-panel"><div className="analysis-panel-heading"><h3>{title}</h3>{action}</div>{children}</section> }
function Table({ headers, children }: { headers: string[]; children: ReactNode }) { return <div className="analysis-table"><table><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div> }
function Empty({ children = '暂无记录' }: { children?: ReactNode }) { return <div className="analysis-empty">{children}</div> }
function Badge({ children, title }: { children: ReactNode; title?: string }) { return <span className="analysis-badge" title={title}>{children}</span> }
function Sessions({ rows, name, onSelect }: { rows: CodexAnalyticsSnapshot['sessions']; name: (id: string) => string; onSelect: (id: string) => void }) {
  if (!rows.length) return <Empty />
  return <Table headers={['会话', '工作区', '轮次', '总 Token']}>{rows.map((s) => <tr key={s.threadId}><td><button type="button" className="analysis-link" onClick={() => onSelect(s.threadId)}>{name(s.threadId)}</button>{s.incomplete && <Badge>不完整</Badge>}{s.rerouted && <Badge>重路由</Badge>}</td><td title={s.workspace}>{workspaceName(s.workspace)}</td><td>{s.turns}</td><td>{format(s.actual.totalTokens)}</td></tr>)}</Table>
}
function Trend({ snapshot, since, until, onDay }: { snapshot: CodexAnalyticsSnapshot; since: string; until: string; onDay: (date: string) => void }) {
  const days = calendarDays(since, until)
  const byDay = new Map(snapshot.daily.map((d) => [d.date, d]))
  const max = Math.max(1, ...snapshot.daily.map((d) => d.actual.totalTokens))
  return <><div className="analysis-trend-scale">{format(max)} Token</div><div className="analysis-trend">{days.map((date, index) => {
    const day = byDay.get(date)
    const uncaptured = +new Date(`${date}T23:59:59.999`) < snapshot.capturedSince
    const label = `${date} · ${uncaptured ? '尚未采集' : `${format(day?.actual.totalTokens ?? 0)} Token`}`
    return <button type="button" key={date} onClick={() => onDay(date)} disabled={uncaptured} title={label} aria-label={label}><div className={`analysis-day-bar ${uncaptured ? 'uncaptured' : ''}`} style={{ height: `${uncaptured ? 4 : Math.max(2, (day?.actual.totalTokens ?? 0) / max * 130)}px` }}>{day?.models.map((m) => <i key={m.model ?? ''} style={{ background: modelColor(m.model, snapshot.availableModels), flex: m.actual.totalTokens }} title={`${modelName(m.model)} · ${format(m.actual.totalTokens)}`} />)}</div><span style={{ visibility: index === 0 || index === days.length - 1 || index % Math.ceil(days.length / 6) === 0 ? 'visible' : 'hidden' }}>{date.slice(5)}</span></button>
  })}</div><div className="analysis-legend">{snapshot.models.map((m) => <span key={m.model ?? ''}><i style={{ background: modelColor(m.model, snapshot.availableModels) }} />{modelName(m.model)}</span>)}</div></>
}
function ModelPie({ rows, label, availableModels, onSelect }: { rows: Array<{ model: string | null; value: number }>; label: string; availableModels: string[]; onSelect: (model: string | null) => void }) {
  const total = rows.reduce((sum, m) => sum + m.value, 0)
  if (!total) return <Empty />
  let start = 0
  const segments = rows.filter((m) => m.value > 0).map((m) => { const from = start; start += m.value / total * 100; return `${modelColor(m.model, availableModels)} ${from}% ${start}%` })
  return <div className="analysis-pie-layout"><div role="img" aria-label={`模型 ${label} 占比：${rows.map((m) => `${modelName(m.model)} ${(m.value / total * 100).toFixed(1)}%`).join('，')}`} className="analysis-pie" style={{ background: `conic-gradient(${segments.join(',')})` }}><div><strong>{label === 'credits' && total < 1000 ? total.toLocaleString('en-US', { maximumFractionDigits: 4 }) : format(total)}</strong><small>{label}</small></div></div><div className="analysis-legend vertical">{rows.map((m) => <button className="analysis-link" key={m.model ?? ''} onClick={() => onSelect(m.model)}><i style={{ background: modelColor(m.model, availableModels) }} /><span>{modelName(m.model)}</span><b>{(m.value / total * 100).toFixed(1)}%</b></button>)}</div></div>
}
function ModelCosts({ service, query, revision, availableModels, onSelect }: { service: CodexAnalyticsService; query: CodexAnalyticsQuery; revision: number; availableModels: string[]; onSelect: (model: string | null) => void }) {
  const key = JSON.stringify(query)
  const [result, setResult] = useState<{ key: string; value: AnalyticsCosts } | null>(null)
  useEffect(() => {
    let cancelled = false
    setResult(null)
    void service.costs(query).then((value) => { if (!cancelled) setResult({ key, value }) }).catch(() => { if (!cancelled) setResult({ key, value: { models: [], message: '官方估算额度暂不可用' } }) })
    return () => { cancelled = true }
  }, [service, key, revision])
  const value = result?.key === key ? result.value : null
  return <>{!value ? <Empty>正在核对官方估算…</Empty> : value.message ? <Empty>{value.message}</Empty> : <ModelPie rows={value.models.map((m) => ({ model: m.model, value: m.credits }))} label="credits" availableModels={availableModels} onSelect={onSelect} />}<p className="analysis-note">官方估算仅在整个会话落入日期范围、且各模型 Token 与本页记录一致时展示。不是结算账单。</p></>
}
function Workspaces({ rows, onSelect }: { rows: CodexAnalyticsSnapshot['workspaces']; onSelect: (workspace: string) => void }) {
  if (!rows.length) return <Empty />
  return <Table headers={['工作区', '会话', '轮次', '总 Token', '输入 / 输出']}>{rows.map((w) => <tr key={w.workspace}><td><button className="analysis-link" onClick={() => onSelect(w.workspace)}>{workspaceName(w.workspace)}</button><small className="analysis-path">{w.workspace || '归属暂不可用'}</small></td><td>{w.sessions}</td><td>{w.turns}</td><td title={w.actual.totalTokens.toLocaleString()}>{format(w.actual.totalTokens)}</td><td>{format(w.actual.inputTokens)} / {format(w.actual.outputTokens)}</td></tr>)}</Table>
}
function ResourceSummary({ rows, kind, onSelect }: { rows: AnalyticsHotspot[]; kind: HotspotKind; onSelect: (h: AnalyticsHotspot) => void }) {
  if (!rows.length) return <Empty>{kind === 'agents' ? '暂无观测读取 · 自动加载未采集' : '暂无观测记录'}</Empty>
  return <div className="analysis-resource-list">{rows.slice(0, 3).map((h) => <button className="analysis-link" key={h.name} onClick={() => onSelect(h)}><span>{h.name}</span><small>{kind === 'mcp' ? `${h.calls} 次调用` : kind === 'skill' ? `${h.selected} 次选择 / ${h.reads} 次读取` : `${h.reads} 次读取`} · {h.workspaces.filter((w) => w.workspace).length} 个工作区</small></button>)}</div>
}
function Composition({ snapshot }: { snapshot: CodexAnalyticsSnapshot }) {
  const t = snapshot.summary.actual
  const parts: Array<[string, number]> = [['缓存命中输入', t.cachedInputTokens], ['未缓存输入', Math.max(0, t.inputTokens - t.cachedInputTokens)], ['输出（含推理）', t.outputTokens]]
  const total = parts.reduce((n, p) => n + p[1], 0)
  return <><div className="analysis-stack">{parts.map(([label, value]) => <i key={label} title={`${label} ${format(value)}`} style={{ width: `${total ? value / total * 100 : 0}%` }} />)}</div><ul className="analysis-composition">{parts.map(([label, value]) => <li key={label}><span>{label}</span><b>{format(value)}</b></li>)}</ul></>
}
function Hotspots({ rows, kind, onSelect }: { rows: AnalyticsHotspot[]; kind: HotspotKind; onSelect: (h: AnalyticsHotspot, workspace?: string) => void }) {
  if (!rows.length) return <Empty>{kind === 'agents' ? '暂无观测读取 · 自动加载未采集' : '暂无观测记录'}</Empty>
  return <div className="analysis-hotspots">{rows.map((h) => <details key={h.name}><summary><strong>{h.name}</strong><span>{kind === 'mcp' ? `${h.calls} 次调用 · ${h.failed} 次失败` : kind === 'skill' ? `${h.selected} 次显式选择 · ${h.reads} 次观测读取` : `${h.reads} 次观测读取`}<small>{h.sessions} 个会话 · {h.workspaces.filter((w) => w.workspace).length} 个工作区{h.workspaces.some((w) => !w.workspace) ? ' · 部分归属缺失' : ''}</small></span></summary><Table headers={['工作区', ...(kind === 'skill' ? ['显式选择', '观测读取'] : [kind === 'mcp' ? '调用' : '观测读取']), '会话']}>{h.workspaces.map((w) => <tr key={w.workspace}><td><button className="analysis-link" onClick={() => onSelect(h, w.workspace)}>{workspaceName(w.workspace)}</button><small className="analysis-path">{w.workspace}</small></td>{kind === 'skill' && <td>{w.selected}</td>}<td>{kind === 'mcp' ? w.calls : w.reads}</td><td>{w.sessions}</td></tr>)}</Table><button className="analysis-link" onClick={() => onSelect(h)}>查看相关会话 →</button></details>)}</div>
}
function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) {
  if (total <= 50) return null
  return <div className="analysis-pagination"><button type="button" aria-label="上一页" disabled={!offset} onClick={() => onChange(Math.max(0, offset - 50))}><ChevronLeft size={16} /></button><span>{offset + 1}–{Math.min(offset + 50, total)} / {total}</span><button type="button" aria-label="下一页" disabled={offset + 50 >= total} onClick={() => onChange(offset + 50)}><ChevronRight size={16} /></button></div>
}
function SessionDetail({ id, title, query, service, conversations, onClose }: { id: string; title: string; query: CodexAnalyticsQuery; service: CodexAnalyticsService; conversations: ConversationService; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [offset, setOffset] = useState(0)
  const [estimate, setEstimate] = useState<string | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const { snapshot, error, loading } = useAnalysis(service, { ...query, threadId: id, offset })
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => el?.close() }, [])
  return <dialog className="analysis-dialog" ref={dialog} onCancel={onClose}><header><h3>{title}</h3><button type="button" aria-label="关闭详情" onClick={onClose}><X size={18} /></button></header><div className="analysis-dialog-actions"><button type="button" onClick={() => { setOpenError(null); void conversations.openThread(id).then(onClose).catch((e: unknown) => setOpenError(e instanceof Error ? e.message : String(e))) }}>打开会话 ↗</button><span>{snapshot?.totalTurns ?? '—'} 轮</span></div>
    <div className="analysis-estimate"><button disabled={estimating} onClick={() => { setEstimating(true); void service.threadUsage(id).then((value) => setEstimate(value ? `${(value.estimatedUsageCreditsMicros / 1e6).toFixed(4)} credits${value.estimatedUsageUsdMicros === null ? '' : ` · $${(value.estimatedUsageUsdMicros / 1e6).toFixed(4)}`}（整个会话累计，不受日期筛选影响）` : '官方暂未返回此会话的估算额度')).catch(() => setEstimate('官方估算额度暂不可用')).finally(() => setEstimating(false)) }}>{estimating ? '查询中…' : '查询官方累计估算额度'}</button>{estimate && <p>{estimate}</p>}</div>
    {(error || openError) && <p role="alert">{error || openError}</p>}{loading && !snapshot && <Empty>正在读取…</Empty>}
    {snapshot?.turns.map((turn) => <details key={turn.turnId} className="analysis-turn"><summary><span>{new Date(turn.startedAt).toLocaleString()} · {turn.model ?? '未记录模型'}{turn.rerouted && <Badge>重路由</Badge>}{turn.incomplete && <Badge>不完整</Badge>}</span><b>{format(turn.actual.totalTokens)}</b></summary><small>{turn.source} · {turn.status}</small><Table headers={['内容', '选择 / 读取', '内容 Token ≈']}>{turn.content.map((c, index) => <tr key={`${c.kind}:${c.name}:${index}`}><td>{c.name}{c.kind === 'mcp' && <Badge>{c.status}</Badge>}</td><td>{c.kind === 'skill' ? `${c.selected} / ${c.reads}` : c.kind === 'agents' ? c.reads : '—'}</td><td>{c.kind === 'mcp' ? `${c.argumentTokens === null ? '—' : format(c.argumentTokens)} / ${c.resultTokens === null ? '—' : format(c.resultTokens)}` : c.tokens === null ? '—' : format(c.tokens)}</td></tr>)}</Table></details>)}
    {snapshot && <Pagination offset={offset} total={snapshot.totalTurns} onChange={setOffset} />}
  </dialog>
}
