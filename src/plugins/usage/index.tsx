import { useEffect, useMemo, useState } from 'react'
import { BarChart3, CircleAlert, DatabaseZap, RefreshCw } from 'lucide-react'
import type {
  UsagePeriod,
  UsageProvider,
  UsageProviderId,
  UsageRateWindow,
  UsageService,
  UsageSnapshot,
} from '../../core/usage/types'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'

type UsageRange = '7d' | '30d' | '90d' | 'month'
type UsageSection = 'overview' | UsageProviderId

const RANGE_LABELS: Record<UsageRange, string> = { '7d': '7 天', '30d': '30 天', '90d': '90 天', month: '本月' }
const PROVIDER_COLORS: Record<UsageProviderId, string> = {
  'codex-business': '#337a68',
  'codex-personal': '#5875b8',
  ais: '#b97935',
  claude: '#a85e45',
  opencode: '#6e5b98',
}

export const usagePlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.usage',
    name: '用量',
    description: '汇总 Codex、AIS 与本机 Agent 的额度、Token 和模型用量。',
    version: '1.0.0',
    engine: { codexHarness: '^0.4.17' },
    supportedScopes: ['global'],
    permissions: ['local:agent-usage', 'network:compass.llm.shopee.io'],
  },
  activate(ctx) {
    const usage = ctx.services.get<UsageService>('harness.usage')
    ctx.slots.conversationTabs.register({
      id: 'usage',
      label: '用量',
      order: 15,
      icon: BarChart3,
      render: () => <UsageTab service={usage} />,
    })
  },
}

export const usageDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.usage:default',
  pluginId: usagePlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

function UsageTab({ service }: { service: UsageService }) {
  const [range, setRange] = useState<UsageRange>('30d')
  const [section, setSection] = useState<UsageSection>('overview')
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const dates = useMemo(() => usageDateRange(range), [range])

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await service.snapshot(dates.since, dates.until))
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [dates.since, dates.until])

  const selected = section === 'overview'
    ? null
    : snapshot?.providers.find((provider) => provider.id === section) ?? null

  return (
    <div className="usage-scroll">
      <div className="usage-page">
        <header className="usage-heading">
          <div>
            <span className="usage-eyebrow">LOCAL AGENT TELEMETRY</span>
            <h2>用量总览</h2>
            <p>额度来自官方服务，Token 与模型分布来自本机日志。</p>
          </div>
          <div className="usage-toolbar">
            <div className="usage-range" role="group" aria-label="用量时间范围">
              {(Object.keys(RANGE_LABELS) as UsageRange[]).map((value) => (
                <button key={value} type="button" className={range === value ? 'selected' : ''} onClick={() => setRange(value)}>{RANGE_LABELS[value]}</button>
              ))}
            </div>
            <button className="usage-refresh" type="button" onClick={() => void load()} disabled={loading} title="刷新所有用量来源">
              <RefreshCw className={loading ? 'spin' : ''} size={14} />刷新
            </button>
          </div>
        </header>

        <nav className="usage-source-tabs" aria-label="用量来源">
          <button type="button" className={section === 'overview' ? 'selected' : ''} onClick={() => setSection('overview')}>
            <DatabaseZap size={14} />总览
          </button>
          {(snapshot?.providers ?? []).map((provider) => (
            <button key={provider.id} type="button" className={section === provider.id ? 'selected' : ''} onClick={() => setSection(provider.id)}>
              <i style={{ background: PROVIDER_COLORS[provider.id] }} />{provider.label}<StatusDot provider={provider} />
            </button>
          ))}
        </nav>

        {error ? <div className="usage-error"><CircleAlert size={16} />{error}</div> : null}
        {!snapshot && loading ? <UsageSkeleton /> : snapshot && section === 'overview' ? (
          <Overview snapshot={snapshot} />
        ) : selected ? (
          <ProviderDetail provider={selected} />
        ) : null}

        {snapshot && (
          <footer className="usage-foot">
            <span>{snapshot.since} — {snapshot.until}</span>
            <span>更新于 {new Date(snapshot.fetchedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          </footer>
        )}
      </div>
    </div>
  )
}

function Overview({ snapshot }: { snapshot: UsageSnapshot }) {
  const tokenProviders = snapshot.providers.filter((provider) => provider.sourceKind !== 'ais')
  const totalTokens = tokenProviders.reduce((total, provider) => total + provider.totals.totalTokens, 0)
  const todayTokens = tokenProviders.reduce((total, provider) => total + (provider.periods.at(-1)?.date === snapshot.until ? provider.periods.at(-1)?.totalTokens ?? 0 : 0), 0)
  const readySources = snapshot.providers.filter((provider) => provider.status === 'ready').length
  const weakest = weakestQuota(snapshot.providers)
  const ais = snapshot.providers.find((provider) => provider.id === 'ais')

  return (
    <main className="usage-content">
      <section className="usage-metrics" aria-label="关键用量指标">
        <MetricCard label="期间 Token" value={formatTokens(totalTokens)} note={`${tokenProviders.filter((provider) => provider.totals.totalTokens > 0).length} 个活跃 Agent`} />
        <MetricCard label="今日 Token" value={formatTokens(todayTokens)} note={snapshot.until} />
        <MetricCard label="可用来源" value={`${readySources} / ${snapshot.providers.length}`} note={readySources === snapshot.providers.length ? '所有采集器正常' : '部分来源需要检查'} tone={readySources === snapshot.providers.length ? 'good' : 'warn'} />
        <MetricCard label="最低剩余额度" value={weakest ? `${Math.round(weakest.window.remainingPercent)}%` : '—'} note={weakest ? `${weakest.provider.label} · ${weakest.window.label}` : '暂无额度数据'} tone={weakest && weakest.window.remainingPercent < 20 ? 'danger' : weakest && weakest.window.remainingPercent < 40 ? 'warn' : 'good'} />
      </section>

      <section className="usage-panel usage-trend-panel">
        <PanelHeading title="每日 Token 趋势" detail="不同来源的本机日志用量；AIS 金额不参与 Token 汇总。" />
        <TrendChart providers={tokenProviders} />
      </section>

      <div className="usage-two-column">
        <section className="usage-panel">
          <PanelHeading title="来源构成" detail="按所选时间范围累计" />
          <ProviderBreakdown providers={tokenProviders} />
        </section>
        <section className="usage-panel">
          <PanelHeading title="额度状态" detail="官方接口的最新快照" />
          <QuotaSummary providers={snapshot.providers} />
          {ais?.budget && <BudgetBar budget={ais.budget} />}
        </section>
      </div>
    </main>
  )
}

function ProviderDetail({ provider }: { provider: UsageProvider }) {
  const quota = provider.quota[0]
  const budgetRemaining = provider.budget ? Math.max(0, provider.budget.totalUsd - provider.budget.usedUsd) : null
  return (
    <main className="usage-content">
      <section className="usage-provider-title">
        <div className="usage-provider-mark" style={{ background: PROVIDER_COLORS[provider.id] }} />
        <div><h3>{provider.label}</h3><p>{providerDescription(provider)}</p></div>
        <span className={`usage-status ${provider.status}`}>{statusLabel(provider.status)}</span>
      </section>
      {provider.message && <div className="usage-notice">{provider.message}</div>}
      <section className="usage-metrics">
        {provider.budget ? (
          <>
            <MetricCard label="本月已用" value={formatUsd(provider.budget.usedUsd)} note={`额度 ${formatUsd(provider.budget.totalUsd)}`} />
            <MetricCard label="本月剩余" value={formatUsd(budgetRemaining ?? 0)} note={`${budgetPercent(provider.budget).toFixed(0)}% 已使用`} tone={budgetPercent(provider.budget) > 80 ? 'danger' : 'good'} />
          </>
        ) : (
          <>
            <MetricCard label="期间 Token" value={formatTokens(provider.totals.totalTokens)} note={`${provider.periods.length} 个活跃日`} />
            <MetricCard label="输入 / 输出" value={`${formatTokens(provider.totals.inputTokens)} / ${formatTokens(provider.totals.outputTokens)}`} note="不含缓存读取" />
          </>
        )}
        <MetricCard label="缓存读取" value={provider.sourceKind === 'ais' ? '—' : formatTokens(provider.totals.cacheReadTokens)} note={provider.sourceKind === 'ais' ? 'AIS 不提供 Token 明细' : cacheRatio(provider).toFixed(0) + '% 总 Token'} />
        <MetricCard label={quota ? `${quota.label}剩余` : '估算费用'} value={quota ? `${Math.round(quota.remainingPercent)}%` : provider.totals.costUsd > 0 ? formatUsd(provider.totals.costUsd) : '—'} note={quota ? resetCopy(quota) : '仅在 ccusage 有价格数据时显示'} tone={quota && quota.remainingPercent < 20 ? 'danger' : 'good'} />
      </section>

      {provider.budget ? (
        <section className="usage-panel"><PanelHeading title="月度额度" detail="AIS Switch 当前项目" /><BudgetBar budget={provider.budget} large /></section>
      ) : (
        <section className="usage-panel usage-trend-panel"><PanelHeading title="Token 组成" detail="每日输入、输出和缓存读取" /><TokenStackChart periods={provider.periods} /></section>
      )}

      <div className="usage-two-column">
        <section className="usage-panel"><PanelHeading title="额度窗口" detail="最新官方快照" /><QuotaList provider={provider} /></section>
        <section className="usage-panel"><PanelHeading title="模型分布" detail="按 Token 总量排序" /><ModelBreakdown provider={provider} /></section>
      </div>
    </main>
  )
}

function TrendChart({ providers }: { providers: UsageProvider[] }) {
  const dates = [...new Set(providers.flatMap((provider) => provider.periods.map((period) => period.date)))].sort()
  if (dates.length === 0) return <EmptyChart copy="所选时间内没有本机 Token 记录" />
  const width = 760
  const height = 220
  const pad = { left: 48, right: 18, top: 18, bottom: 30 }
  const max = Math.max(1, ...providers.flatMap((provider) => provider.periods.map((period) => period.totalTokens)))
  const x = (index: number) => pad.left + index * ((width - pad.left - pad.right) / Math.max(1, dates.length - 1))
  const y = (value: number) => pad.top + (height - pad.top - pad.bottom) * (1 - value / max)
  return (
    <div className="usage-chart-wrap">
      <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日 Token 趋势图">
        {[0, .25, .5, .75, 1].map((ratio) => <line key={ratio} x1={pad.left} x2={width - pad.right} y1={y(max * ratio)} y2={y(max * ratio)} className="usage-grid-line" />)}
        {[0, Math.floor((dates.length - 1) / 2), dates.length - 1].filter((value, index, list) => list.indexOf(value) === index).map((index) => <text key={index} x={x(index)} y={height - 8} textAnchor={index === 0 ? 'start' : index === dates.length - 1 ? 'end' : 'middle'}>{shortDate(dates[index])}</text>)}
        {providers.map((provider) => {
          const values = new Map(provider.periods.map((period) => [period.date, period.totalTokens]))
          const points = dates.map((date, index) => `${x(index)},${y(values.get(date) ?? 0)}`).join(' ')
          return <polyline key={provider.id} points={points} fill="none" stroke={PROVIDER_COLORS[provider.id]} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        })}
      </svg>
      <div className="usage-chart-legend">{providers.map((provider) => <span key={provider.id}><i style={{ background: PROVIDER_COLORS[provider.id] }} />{provider.label}</span>)}</div>
    </div>
  )
}

function TokenStackChart({ periods }: { periods: UsagePeriod[] }) {
  if (periods.length === 0) return <EmptyChart copy="所选时间内没有 Token 记录" />
  const visible = periods.slice(-45)
  const width = 760
  const height = 220
  const pad = { left: 46, right: 16, top: 18, bottom: 30 }
  const max = Math.max(1, ...visible.map((period) => period.inputTokens + period.outputTokens + period.cacheReadTokens + period.cacheCreationTokens))
  const plotHeight = height - pad.top - pad.bottom
  const slot = (width - pad.left - pad.right) / visible.length
  const barWidth = Math.max(2, Math.min(13, slot * .62))
  return (
    <div className="usage-chart-wrap">
      <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日 Token 组成图">
        {[0, .25, .5, .75, 1].map((ratio) => <line key={ratio} x1={pad.left} x2={width - pad.right} y1={pad.top + plotHeight * (1 - ratio)} y2={pad.top + plotHeight * (1 - ratio)} className="usage-grid-line" />)}
        {visible.map((period, index) => {
          const x = pad.left + slot * index + (slot - barWidth) / 2
          let bottom = pad.top + plotHeight
          const segments = [
            { value: period.cacheReadTokens + period.cacheCreationTokens, className: 'cache' },
            { value: period.inputTokens, className: 'input' },
            { value: period.outputTokens, className: 'output' },
          ]
          return <g key={period.date}>{segments.map((segment) => {
            const segmentHeight = plotHeight * segment.value / max
            bottom -= segmentHeight
            return <rect key={segment.className} x={x} y={bottom} width={barWidth} height={Math.max(0, segmentHeight)} className={`usage-bar-${segment.className}`} rx="1.5" />
          })}</g>
        })}
        <text x={pad.left} y={height - 8}>{shortDate(visible[0].date)}</text><text x={width - pad.right} y={height - 8} textAnchor="end">{shortDate(visible.at(-1)!.date)}</text>
      </svg>
      <div className="usage-chart-legend"><span><i className="cache" />缓存</span><span><i className="input" />输入</span><span><i className="output" />输出</span></div>
    </div>
  )
}

function ProviderBreakdown({ providers }: { providers: UsageProvider[] }) {
  const total = providers.reduce((sum, provider) => sum + provider.totals.totalTokens, 0)
  if (total === 0) return <EmptyChart copy="暂无来源构成数据" compact />
  return <div className="usage-breakdown">{providers.filter((provider) => provider.totals.totalTokens > 0).sort((a, b) => b.totals.totalTokens - a.totals.totalTokens).map((provider) => {
    const percent = provider.totals.totalTokens / total * 100
    return <div key={provider.id} className="usage-breakdown-row"><div><span><i style={{ background: PROVIDER_COLORS[provider.id] }} />{provider.label}</span><strong>{formatTokens(provider.totals.totalTokens)}</strong></div><div className="usage-track"><i style={{ width: `${percent}%`, background: PROVIDER_COLORS[provider.id] }} /></div><small>{percent.toFixed(1)}%</small></div>
  })}</div>
}

function QuotaSummary({ providers }: { providers: UsageProvider[] }) {
  const rows = providers.flatMap((provider) => provider.quota.map((window) => ({ provider, window })))
  if (rows.length === 0) return <EmptyChart copy="暂无官方额度数据" compact />
  return <div className="usage-quota-summary">{rows.map(({ provider, window }) => <div key={`${provider.id}:${window.label}`}><span>{provider.label} · {window.label}</span><strong>{Math.round(window.remainingPercent)}%</strong><div className="usage-track"><i style={{ width: `${window.remainingPercent}%`, background: quotaColor(window.remainingPercent) }} /></div></div>)}</div>
}

function QuotaList({ provider }: { provider: UsageProvider }) {
  if (provider.quota.length === 0) return <EmptyChart copy={provider.sourceKind === 'codex' ? '额度接口暂未返回窗口' : '该来源不提供额度窗口'} compact />
  return <div className="usage-quota-list">{provider.quota.map((window) => <div key={window.label}><div><span>{window.label}</span><strong>{Math.round(window.remainingPercent)}% 剩余</strong></div><div className="usage-track"><i style={{ width: `${window.remainingPercent}%`, background: quotaColor(window.remainingPercent) }} /></div><small>{resetCopy(window)}</small></div>)}</div>
}

function ModelBreakdown({ provider }: { provider: UsageProvider }) {
  const models = [...provider.models].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 7)
  const max = models[0]?.totalTokens ?? 0
  if (models.length === 0 || max === 0) return <EmptyChart copy={provider.sourceKind === 'ais' ? 'AIS 不提供模型明细' : '暂无模型明细'} compact />
  return <div className="usage-models">{models.map((model) => <div key={model.model}><div><span title={model.model}>{model.model}</span><strong>{formatTokens(model.totalTokens)}</strong></div><div className="usage-track"><i style={{ width: `${model.totalTokens / max * 100}%`, background: PROVIDER_COLORS[provider.id] }} /></div></div>)}</div>
}

function BudgetBar({ budget, large = false }: { budget: { usedUsd: number; totalUsd: number }; large?: boolean }) {
  const percent = budgetPercent(budget)
  return <div className={`usage-budget ${large ? 'large' : ''}`}><div><span>AIS 本月额度</span><strong>{formatUsd(budget.usedUsd)} <small>/ {formatUsd(budget.totalUsd)}</small></strong></div><div className="usage-track"><i style={{ width: `${percent}%`, background: quotaColor(100 - percent) }} /></div><small>{Math.max(0, 100 - percent).toFixed(0)}% 剩余</small></div>
}

function MetricCard({ label, value, note, tone = 'neutral' }: { label: string; value: string; note: string; tone?: string }) {
  return <article className={`usage-metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>
}

function PanelHeading({ title, detail }: { title: string; detail: string }) {
  return <header className="usage-panel-heading"><h3>{title}</h3><span>{detail}</span></header>
}

function EmptyChart({ copy, compact = false }: { copy: string; compact?: boolean }) {
  return <div className={`usage-empty-chart ${compact ? 'compact' : ''}`}><BarChart3 size={18} />{copy}</div>
}

function UsageSkeleton() {
  return <div className="usage-skeleton"><div /><div /><div /><div /><section /></div>
}

function StatusDot({ provider }: { provider: UsageProvider }) {
  return <span className={`usage-source-status ${provider.status}`} title={provider.message ?? statusLabel(provider.status)} />
}

export function usageDateRange(range: UsageRange, now = new Date()): { since: string; until: string } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = range === 'month'
    ? new Date(end.getFullYear(), end.getMonth(), 1)
    : new Date(end.getFullYear(), end.getMonth(), end.getDate() - Number.parseInt(range, 10) + 1)
  return { since: localIsoDate(start), until: localIsoDate(end) }
}

export function weakestQuota(providers: UsageProvider[]): { provider: UsageProvider; window: UsageRateWindow } | null {
  return providers
    .flatMap((provider) => provider.quota.map((window) => ({ provider, window })))
    .sort((left, right) => left.window.remainingPercent - right.window.remainingPercent)[0] ?? null
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function shortDate(date: string): string {
  return date.slice(5).replace('-', '/')
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 1 : 2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K`
  return value.toLocaleString('zh-CN')
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value)
}

function budgetPercent(budget: { usedUsd: number; totalUsd: number }): number {
  return budget.totalUsd > 0 ? Math.min(100, Math.max(0, budget.usedUsd / budget.totalUsd * 100)) : 0
}

function cacheRatio(provider: UsageProvider): number {
  return provider.totals.totalTokens > 0 ? provider.totals.cacheReadTokens / provider.totals.totalTokens * 100 : 0
}

function quotaColor(remaining: number): string {
  if (remaining < 20) return '#c65f59'
  if (remaining < 40) return '#c08a3b'
  return '#438b72'
}

function resetCopy(window: UsageRateWindow): string {
  if (!window.resetsAt) return '重置时间未知'
  return `${new Date(window.resetsAt * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置`
}

function providerDescription(provider: UsageProvider): string {
  if (provider.id === 'ais') return 'Compass 月度项目额度'
  if (provider.id === 'codex-business') return '企业账号额度与本机 Codex 日志'
  if (provider.id === 'codex-personal') return '个人账号限流窗口与本机 Codex 日志'
  return `本机 ${provider.label} 日志`
}

function statusLabel(status: UsageProvider['status']): string {
  if (status === 'ready') return '正常'
  if (status === 'error') return '错误'
  return '未配置'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
