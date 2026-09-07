import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw, X } from 'lucide-react'
import type { AnalyticsHotspot, CodexAnalyticsQuery, CodexAnalyticsService, CodexAnalyticsSnapshot, HotspotKind } from '../../core/codex-analytics/types'
import type { ConversationService } from '../../core/conversations/types'
import { threadTitle, type Thread } from '../../core/domain/codex'
import type { UsageService } from '../../core/usage/types'
import { UsageHistory } from './history'
import './analysis.css'

type View = 'overview' | 'models' | 'hotspots' | 'sessions'
const VIEWS: Array<[View, string]> = [['overview', '总览'], ['models', '模型'], ['hotspots', '热点'], ['sessions', '会话']]
const KINDS: Array<[HotspotKind, string]> = [['skill', 'Skill'], ['mcp', 'MCP'], ['agents', 'AGENTS.md']]
const format = (value: number) => Math.round(value).toLocaleString('en-US')
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
  const today = localDate(new Date())
  const [since, setSince] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 29); return localDate(d) })
  const [until, setUntil] = useState(today)
  const [model, setModel] = useState<string | undefined>()
  const [view, setView] = useState<View>('overview')
  const [kind, setKind] = useState<HotspotKind>('skill')
  const [hotspot, setHotspot] = useState<AnalyticsHotspot | null>(null)
  const [sort, setSort] = useState<'tokensDesc' | 'tokensAsc' | 'recent'>('tokensDesc')
  const [offset, setOffset] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  const bounds = dateBounds(since, until)
  const query = useMemo(() => bounds ? { ...bounds, model, kind: hotspot?.kind, name: hotspot?.name, sort: view === 'overview' ? 'tokensDesc' as const : sort, offset } : null, [bounds?.since, bounds?.until, model, hotspot?.kind, hotspot?.name, offset, sort, view])
  const { snapshot, error, loading, refresh } = useAnalysis(service, query)
  const labels = useMemo(() => new Map(threads.map((t) => [t.id, threadTitle(t)])), [threads])
  const name = useCallback((id: string) => labels.get(id) ?? `会话 ${id.slice(0, 8)}`, [labels])
  const chooseView = (next: View) => { setView(next); setOffset(0); setHotspot(null) }
  const filteredDate = (date: string) => { setSince(date); setUntil(date); setOffset(0); setView('sessions') }
  const selectModel = (value: string | null) => { setModel(value ?? ''); setOffset(0); setView('sessions') }
  const selectHotspot = (value: AnalyticsHotspot) => { setHotspot(value); setOffset(0); setView('sessions') }
  const total = snapshot?.summary.actual.totalTokens ?? 0
  return <div className="analysis-scroll"><div className="analysis-page">
    <header className="analysis-heading"><h2>用量分析</h2><div><span>Harness · Codex</span><button type="button" onClick={refresh} disabled={loading || !bounds} aria-label="刷新分析"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button></div></header>
    <div className="analysis-filters">
      <label>时间 <input type="date" aria-label="开始日期" value={since} max={until} onChange={(e) => { setSince(e.target.value); setOffset(0) }} /></label><span>—</span>
      <input type="date" aria-label="结束日期" value={until} max={today} min={since} onChange={(e) => { setUntil(e.target.value); setOffset(0) }} />
      <button type="button" onClick={() => { setSince(''); setUntil(today); setOffset(0) }}>全部</button>
      <label>模型 <select aria-label="模型筛选" value={model === undefined ? '__all' : model} onChange={(e) => { setModel(e.target.value === '__all' ? undefined : e.target.value); setOffset(0) }}><option value="__all">全部模型</option><option value="">未记录模型</option>{[...new Set([...(snapshot?.availableModels ?? []), ...(model ? [model] : [])])].map((m) => <option key={m} value={m}>{m}</option>)}</select></label>
    </div>
    <nav className="analysis-nav" aria-label="分析视图">{VIEWS.map(([id, label]) => <button type="button" key={id} aria-pressed={view === id} onClick={() => chooseView(id)}>{label}</button>)}</nav>
    {hotspot && <div className="analysis-filter-tag"><span>{hotspot.name}</span><button type="button" aria-label="清除热点筛选" onClick={() => { setHotspot(null); setOffset(0) }}><X size={14} /></button></div>}
    {!bounds && <p role="alert">请选择有效的时间范围</p>}
    {error && <p className="analysis-error" role="alert">{error}</p>}
    {loading && !snapshot && <Empty>正在读取…</Empty>}
    {snapshot && <>
      {(snapshot.droppedEvents > 0 || snapshot.writeErrors > 0 || snapshot.summary.incompleteTurns > 0) && <div className="analysis-warning" title={`丢弃事件 ${snapshot.droppedEvents} · 写入失败 ${snapshot.writeErrors} · 用量异常轮次 ${snapshot.summary.incompleteTurns}`}>部分统计不完整</div>}
      {view === 'overview' && <>
        <div className="analysis-metrics"><Metric label="实际 Token" value={format(total)} title="输入与输出之和，缓存输入不重复相加" /><Metric label="缓存命中输入" value={format(snapshot.summary.actual.cachedInputTokens)} title="已包含在输入 Token 中" /><Metric label="会话 / 轮次" value={`${snapshot.summary.sessions} / ${snapshot.summary.turns}`} /><Metric label="用户输入内容 ≈" value={snapshot.summary.inputContentIncomplete && !snapshot.summary.inputContentTokens ? '—' : `${format(snapshot.summary.inputContentTokens)}${snapshot.summary.inputContentIncomplete ? ' *' : ''}`} title={snapshot.summary.inputContentIncomplete ? '部分输入未计数' : '已观测用户文本的独立计数，不等于完整输入消耗'} /></div>
        <div className="analysis-columns"><Panel title="每日消耗"><Trend snapshot={snapshot} onDay={filteredDate} /></Panel><Panel title="输入与输出"><Composition snapshot={snapshot} /></Panel></div>
        <Panel title="高消耗会话" action={<button className="analysis-link" type="button" onClick={() => chooseView('sessions')}>查看会话 →</button>}><Sessions rows={snapshot.sessions.slice(0, 5)} name={name} onSelect={setDetailId} /></Panel>
      </>}
      {view === 'models' && <Panel title="模型用量"><Table headers={['配置模型', '会话', '轮次', '实际 Token', '占比', '输出']}>{snapshot.models.map((m) => <tr key={m.model ?? ''}><td><button className="analysis-link" type="button" onClick={() => selectModel(m.model)}>{m.model ?? '未记录模型'}</button>{m.reroutedTurns > 0 && <Badge title="部分轮次发生重路由，无法将整轮消耗精确拆给实际模型">重路由</Badge>}</td><td>{m.sessions}</td><td>{m.turns}</td><td>{format(m.actual.totalTokens)}</td><td>{total ? `${(m.actual.totalTokens / total * 100).toFixed(1)}%` : '—'}</td><td>{format(m.actual.outputTokens)}</td></tr>)}</Table>{!snapshot.models.length && <Empty />}</Panel>}
      {view === 'hotspots' && <><div className="analysis-subnav">{KINDS.map(([id, label]) => <button key={id} type="button" aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>)}</div><Panel title={kind === 'skill' ? 'Skill 使用' : kind === 'mcp' ? 'MCP 调用' : '指令文件读取'}><Hotspots rows={snapshot.hotspots.filter((h) => h.kind === kind)} kind={kind} onSelect={selectHotspot} /></Panel></>}
      {view === 'sessions' && <Panel title="会话消耗" action={<label>{snapshot.totalSessions} 个会话 <select aria-label="会话排序" value={sort} onChange={(e) => { setSort(e.target.value as typeof sort); setOffset(0) }}><option value="tokensDesc">Token 从高到低</option><option value="tokensAsc">Token 从低到高</option><option value="recent">最近执行</option></select></label>}><Sessions rows={snapshot.sessions} name={name} onSelect={setDetailId} /><Pagination offset={offset} total={snapshot.totalSessions} onChange={setOffset} /></Panel>}

    </>}
    {view === 'overview' && <details className="analysis-history" open={history} onToggle={(e) => setHistory(e.currentTarget.open)}><summary>账号额度与历史用量</summary>{history && <UsageHistory service={usage} />}</details>}
    {snapshot && <footer className="analysis-footer"><span>采集起点 · {new Date(snapshot.capturedSince).toLocaleDateString()}</span><details><summary>统计口径</summary><p>仅统计 Harness 执行期记录。缓存输入包含在输入中，推理包含在输出中。≈ 为内容计数，不等同实际消耗；Skill 的选择与读取分别计数。AGENTS.md 自动加载未采集。模型展示执行时配置，重路由单独标记。历史用量独立展示，不与此处相加。</p><p>计数器：{snapshot.counter.mode === 'official' ? '官方接口' : '本地'}{snapshot.officialFallbacks > 0 ? ` · 回退 ${snapshot.officialFallbacks} 次` : ''}</p></details></footer>}
    {detailId && query && <SessionDetail id={detailId} title={name(detailId)} query={query} service={service} conversations={conversations} onClose={() => setDetailId(null)} />}
  </div></div>
}
function Metric({ label, value, title }: { label: string; value: string; title?: string }) { return <div title={title}><span>{label}</span><strong>{value}</strong></div> }
function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) { return <section className="analysis-panel"><div className="analysis-panel-heading"><h3>{title}</h3>{action}</div>{children}</section> }
function Table({ headers, children }: { headers: string[]; children: ReactNode }) { return <div className="analysis-table"><table><thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div> }
function Empty({ children = '暂无记录' }: { children?: ReactNode }) { return <div className="analysis-empty">{children}</div> }
function Badge({ children, title }: { children: ReactNode; title?: string }) { return <span className="analysis-badge" title={title}>{children}</span> }
function Sessions({ rows, name, onSelect }: { rows: CodexAnalyticsSnapshot['sessions']; name: (id: string) => string; onSelect: (id: string) => void }) {
  if (!rows.length) return <Empty />
  return <Table headers={['会话', '项目', '轮次', '实际 Token']}>{rows.map((s) => <tr key={s.threadId}><td><button type="button" className="analysis-link" onClick={() => onSelect(s.threadId)}>{name(s.threadId)}</button>{s.incomplete && <Badge>不完整</Badge>}{s.rerouted && <Badge>重路由</Badge>}</td><td>{s.project || '—'}</td><td>{s.turns}</td><td>{format(s.actual.totalTokens)}</td></tr>)}</Table>
}
function Trend({ snapshot, onDay }: { snapshot: CodexAnalyticsSnapshot; onDay: (date: string) => void }) {
  if (!snapshot.daily.length) return <Empty />
  const max = Math.max(1, ...snapshot.daily.map((d) => d.actual.totalTokens))
  return <div className="analysis-trend">{snapshot.daily.map((d) => <button type="button" key={d.date} onClick={() => onDay(d.date)} title={`${d.date} · ${format(d.actual.totalTokens)} Token`} aria-label={`${d.date} · ${format(d.actual.totalTokens)} Token`}><i style={{ height: `${Math.max(1, d.actual.totalTokens / max * 130)}px` }} /><span>{d.date.slice(5)}</span></button>)}</div>
}
function Composition({ snapshot }: { snapshot: CodexAnalyticsSnapshot }) {
  const t = snapshot.summary.actual
  const parts: Array<[string, number]> = [['缓存命中输入', t.cachedInputTokens], ['未缓存输入', Math.max(0, t.inputTokens - t.cachedInputTokens)], ['输出（含推理）', t.outputTokens]]
  const total = parts.reduce((n, p) => n + p[1], 0)
  return <><div className="analysis-stack">{parts.map(([label, value]) => <i key={label} title={`${label} ${format(value)}`} style={{ width: `${total ? value / total * 100 : 0}%` }} />)}</div><ul className="analysis-composition">{parts.map(([label, value]) => <li key={label}><span>{label}</span><b>{format(value)}</b></li>)}</ul></>
}
function Hotspots({ rows, kind, onSelect }: { rows: AnalyticsHotspot[]; kind: HotspotKind; onSelect: (h: AnalyticsHotspot) => void }) {
  if (!rows.length) return <Empty>{kind === 'agents' ? '暂无观测读取 · 自动加载未采集' : '暂无记录'}</Empty>
  const headers = kind === 'mcp' ? ['服务 / 工具', '调用', '失败', '会话', '参数 Token ≈', '返回 Token ≈'] : kind === 'skill' ? ['Skill', '显式选择', '观测读取', '会话', '内容 Token ≈'] : ['指令文件', '观测读取', '会话', '内容 Token ≈', '自动加载']
  const count = (row: AnalyticsHotspot, value: number) => <span title={row.missingCounts ? `${row.missingCounts} 条内容计数缺失` : undefined}>{row.missingCounts && !value ? '—' : format(value)}{row.missingCounts > 0 && value > 0 && <Badge>部分</Badge>}</span>
  return <Table headers={headers}>{rows.map((h) => <tr key={h.name}><td><button className="analysis-link" type="button" onClick={() => onSelect(h)}>{h.name}</button></td>{kind === 'mcp' ? <><td>{h.calls}</td><td>{h.failed}</td><td>{h.sessions}</td><td>{count(h, h.argumentTokens)}</td><td>{count(h, h.resultTokens)}</td></> : <>{kind === 'skill' && <td>{h.selected}</td>}<td>{h.reads}</td><td>{h.sessions}</td><td>{count(h, h.tokens)}</td>{kind === 'agents' && <td><Badge>未采集</Badge></td>}</>}</tr>)}</Table>
}
function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) {
  if (total <= 50) return null
  return <div className="analysis-pagination"><button type="button" aria-label="上一页" disabled={!offset} onClick={() => onChange(Math.max(0, offset - 50))}><ChevronLeft size={16} /></button><span>{offset + 1}–{Math.min(offset + 50, total)} / {total}</span><button type="button" aria-label="下一页" disabled={offset + 50 >= total} onClick={() => onChange(offset + 50)}><ChevronRight size={16} /></button></div>
}
function SessionDetail({ id, title, query, service, conversations, onClose }: { id: string; title: string; query: CodexAnalyticsQuery; service: CodexAnalyticsService; conversations: ConversationService; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [offset, setOffset] = useState(0)
  const [openError, setOpenError] = useState<string | null>(null)
  const { snapshot, error, loading } = useAnalysis(service, { ...query, threadId: id, offset })
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => el?.close() }, [])
  return <dialog className="analysis-dialog" ref={dialog} onCancel={onClose}><header><h3>{title}</h3><button type="button" aria-label="关闭详情" onClick={onClose}><X size={18} /></button></header><div className="analysis-dialog-actions"><button type="button" onClick={() => { setOpenError(null); void conversations.openThread(id).then(onClose).catch((e: unknown) => setOpenError(e instanceof Error ? e.message : String(e))) }}>打开会话 ↗</button><span>{snapshot?.totalTurns ?? '—'} 轮</span></div>
    {(error || openError) && <p role="alert">{error || openError}</p>}{loading && !snapshot && <Empty>正在读取…</Empty>}
    {snapshot?.turns.map((turn) => <details key={turn.turnId} className="analysis-turn"><summary><span>{new Date(turn.startedAt).toLocaleString()} · {turn.model ?? '未记录模型'}{turn.rerouted && <Badge>重路由</Badge>}{turn.incomplete && <Badge>不完整</Badge>}</span><b>{format(turn.actual.totalTokens)}</b></summary><small>{turn.source} · {turn.status}</small><Table headers={['内容', '选择 / 读取', '内容 Token ≈']}>{turn.content.map((c, index) => <tr key={`${c.kind}:${c.name}:${index}`}><td>{c.name}{c.kind === 'mcp' && <Badge>{c.status}</Badge>}</td><td>{c.kind === 'skill' ? `${c.selected} / ${c.reads}` : c.kind === 'agents' ? c.reads : '—'}</td><td>{c.kind === 'mcp' ? `${c.argumentTokens === null ? '—' : format(c.argumentTokens)} / ${c.resultTokens === null ? '—' : format(c.resultTokens)}` : c.tokens === null ? '—' : format(c.tokens)}</td></tr>)}</Table></details>)}
    {snapshot && <Pagination offset={offset} total={snapshot.totalTurns} onChange={setOffset} />}
  </dialog>
}
