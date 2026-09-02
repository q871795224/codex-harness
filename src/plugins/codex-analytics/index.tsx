import { useCallback, useEffect, useState } from 'react'
import { Activity, Database, RefreshCw } from 'lucide-react'
import type {
  CodexAnalyticsRange,
  CodexAnalyticsService,
  CodexAnalyticsSnapshot,
} from '../../core/codex-analytics/types'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'

const RANGE_LABELS: Record<CodexAnalyticsRange, string> = {
  '7d': '7 天',
  '30d': '30 天',
  all: '全部',
}

export const codexAnalyticsPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.codex-analytics',
    name: 'Codex 分析',
    description: '按会话和 turn 分析 Codex、Skill、MCP 与 Harness 插件的 Token 去向。',
    version: '1.0.0',
    engine: { codexHarness: '^0.7.1' },
    supportedScopes: ['global'],
    supportedProviders: ['codex'],
    permissions: ['local:codex-analytics'],
  },
  activate(ctx) {
    const service = ctx.services.get<CodexAnalyticsService>('harness.codexAnalytics')
    ctx.slots.conversationTabs.register({
      id: 'codex-analytics',
      label: 'Codex 分析',
      order: 16,
      icon: Activity,
      render: () => <CodexAnalyticsTab service={service} />,
    })
  },
}

export const codexAnalyticsDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.codex-analytics:default',
  pluginId: codexAnalyticsPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

function CodexAnalyticsTab({ service }: { service: CodexAnalyticsService }) {
  const [range, setRange] = useState<CodexAnalyticsRange>('30d')
  const [snapshot, setSnapshot] = useState<CodexAnalyticsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await service.snapshot(range))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError))
    } finally {
      setLoading(false)
    }
  }, [range, service])

  useEffect(() => { void load() }, [load])

  return (
    <div className="codex-analytics-scroll">
      <div className="codex-analytics-page">
        <header className="codex-analytics-heading">
          <div>
            <span>CODEX EXECUTION LEDGER</span>
            <h2>Token 去向分析</h2>
            <p>真实 usage 来自 App Server；用户输入、Skill 与 MCP 使用本地估算，二者不会混算。</p>
          </div>
          <div className="codex-analytics-toolbar">
            <div className="codex-analytics-range" role="group" aria-label="分析时间范围">
              {(Object.keys(RANGE_LABELS) as CodexAnalyticsRange[]).map((value) => (
                <button key={value} type="button" className={range === value ? 'selected' : ''} onClick={() => setRange(value)}>{RANGE_LABELS[value]}</button>
              ))}
            </div>
            <button type="button" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} size={14} />刷新</button>
          </div>
        </header>

        {error ? <div className="codex-analytics-error">{error}</div> : null}
        {!snapshot && loading ? <div className="codex-analytics-empty">正在读取本地分析数据…</div> : null}
        {snapshot ? <AnalyticsContent snapshot={snapshot} /> : null}
      </div>
    </div>
  )
}

function AnalyticsContent({ snapshot }: { snapshot: CodexAnalyticsSnapshot }) {
  const estimatedAttributed = snapshot.summary.estimatedUserTokens
    + snapshot.summary.estimatedSkillTokens
    + snapshot.summary.estimatedMcpTokens
  return (
    <main className="codex-analytics-content">
      {snapshot.summary.droppedEvents > 0 || snapshot.summary.writeErrors > 0 ? (
        <div className="codex-analytics-error">采集器已降级：丢弃 {snapshot.summary.droppedEvents} 个事件，写入失败 {snapshot.summary.writeErrors} 次。Codex 主流程未受影响。</div>
      ) : null}
      <section className="codex-analytics-metrics">
        <Metric label="官方 Token" value={formatTokens(snapshot.summary.actual.totalTokens)} detail={`${snapshot.summary.usageUpdates} 次增量上报`} />
        <Metric label="会话 / Turn" value={`${snapshot.summary.sessions} / ${snapshot.summary.turns}`} detail="按本机 Codex 会话统计" />
        <Metric label="输入估算" value={formatTokens(snapshot.summary.estimatedUserTokens)} detail={`${formatNumber(snapshot.summary.userChars)} 字符`} />
        <Metric label="可归因估算" value={formatTokens(estimatedAttributed)} detail="用户 + Skill + MCP，不等同官方总量" />
      </section>

      <section className="codex-analytics-panel codex-analytics-trend-panel">
        <PanelTitle title="每日真实 Token" detail="所有 thread/tokenUsage/updated.last 增量之和" />
        <TokenTrend snapshot={snapshot} />
      </section>

      <div className="codex-analytics-grid">
        <section className="codex-analytics-panel">
          <PanelTitle title="来源归因" detail="Harness 与插件发起的 turn" />
          <RankRows rows={snapshot.sources.map((item) => ({ key: item.id, label: item.label, meta: `${item.turns} turns`, value: item.actualTotalTokens }))} />
        </section>
        <section className="codex-analytics-panel">
          <PanelTitle title="模型分布" detail="按官方 Token 排序" />
          <RankRows rows={snapshot.models.map((item) => ({ key: item.model, label: item.model, meta: `${item.turns} turns`, value: item.actualTotalTokens }))} />
        </section>
      </div>

      <div className="codex-analytics-grid">
        <section className="codex-analytics-panel">
          <PanelTitle title="Skill" detail={`本地估算 · ${snapshot.estimatorVersion}`} />
          <RankRows rows={snapshot.skills.map((item) => ({ key: item.name, label: item.name, meta: `${item.calls} 次 · ${formatNumber(item.chars)} 字符`, value: item.estimatedTokens }))} estimated />
        </section>
        <section className="codex-analytics-panel">
          <PanelTitle title="MCP" detail="参数与结果仅计字符数，不保存正文" />
          <RankRows rows={snapshot.mcpTools.map((item) => ({ key: `${item.server}/${item.tool}`, label: `${item.server} / ${item.tool}`, meta: `${item.calls} 次 · ${formatNumber(item.argumentChars + item.resultChars)} 字符`, value: item.estimatedTokens }))} estimated />
        </section>
      </div>

      <section className="codex-analytics-panel">
        <PanelTitle title="最近 Turn" detail="仅保留低敏元信息和计数" />
        <RecentTurns snapshot={snapshot} />
      </section>

      <footer className="codex-analytics-foot">
        <span><Database size={13} />永久保存在 ~/.codex-harness/state.sqlite</span>
        <span>生成于 {new Date(snapshot.generatedAt).toLocaleString('zh-CN')}</span>
      </footer>
    </main>
  )
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <article><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>
}

function PanelTitle({ title, detail }: { title: string; detail: string }) {
  return <header className="codex-analytics-panel-title"><h3>{title}</h3><span>{detail}</span></header>
}

function TokenTrend({ snapshot }: { snapshot: CodexAnalyticsSnapshot }) {
  if (snapshot.daily.length === 0) return <Empty />
  const days = snapshot.daily.slice(-45)
  const width = 760
  const height = 190
  const padding = { left: 54, right: 12, top: 12, bottom: 30 }
  const max = Math.max(1, ...days.map((day) => day.actualTotalTokens))
  const slot = (width - padding.left - padding.right) / days.length
  const plotHeight = height - padding.top - padding.bottom
  return (
    <div className="codex-analytics-chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日真实 Token 柱状图">
        {[0, .5, 1].map((ratio) => {
          const y = padding.top + plotHeight * (1 - ratio)
          return <g key={ratio}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} /><text x={padding.left - 7} y={y + 3} textAnchor="end">{formatTokens(max * ratio)}</text></g>
        })}
        {days.map((day, index) => {
          const barHeight = Math.max(1, plotHeight * day.actualTotalTokens / max)
          const x = padding.left + slot * index + slot * .18
          return <rect key={day.date} x={x} y={padding.top + plotHeight - barHeight} width={Math.max(2, slot * .64)} height={barHeight} rx="2" />
        })}
        {tickIndexes(days.length).map((index) => <text key={index} x={padding.left + slot * (index + .5)} y={height - 9} textAnchor="middle">{days[index].date.slice(5)}</text>)}
      </svg>
    </div>
  )
}

function RankRows({ rows, estimated = false }: { rows: Array<{ key: string; label: string; meta: string; value: number }>; estimated?: boolean }) {
  if (rows.length === 0) return <Empty />
  const max = Math.max(1, ...rows.map((row) => row.value))
  return <div className="codex-analytics-ranks">{rows.slice(0, 10).map((row) => (
    <div key={row.key} className="codex-analytics-rank">
      <div><strong title={row.label}>{row.label}</strong><span>{row.meta}</span></div>
      <b>{estimated ? '≈ ' : ''}{formatTokens(row.value)}</b>
      <i><span style={{ width: `${Math.max(2, row.value / max * 100)}%` }} /></i>
    </div>
  ))}</div>
}

function RecentTurns({ snapshot }: { snapshot: CodexAnalyticsSnapshot }) {
  if (snapshot.recentTurns.length === 0) return <Empty />
  return <div className="codex-analytics-table-wrap"><table><thead><tr><th>时间</th><th>来源</th><th>模型</th><th>用户输入</th><th>官方 Token</th></tr></thead><tbody>
    {snapshot.recentTurns.slice(0, 20).map((turn) => <tr key={turn.turnId}>
      <td>{new Date(turn.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
      <td>{turn.source}</td><td>{turn.model ?? '—'}</td>
      <td>{formatNumber(turn.userChars)} 字 / ≈ {formatTokens(turn.estimatedUserTokens)}</td>
      <td>{formatTokens(turn.actualTotalTokens)}</td>
    </tr>)}
  </tbody></table></div>
}

function Empty() {
  return <div className="codex-analytics-empty">所选范围内暂无数据</div>
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`
  return Math.round(value).toLocaleString('en-US')
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function tickIndexes(length: number): number[] {
  if (length <= 1) return [0]
  return [...new Set([0, Math.floor((length - 1) / 2), length - 1])]
}
