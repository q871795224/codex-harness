import { useEffect, useState } from 'react'
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
type TokenChartMode = 'composition' | 'models'

const RANGE_LABELS: Record<UsageRange, string> = { '7d': '7 天', '30d': '30 天', '90d': '90 天', month: '本月' }
const USAGE_REFRESH_INTERVAL_MS = 15 * 60 * 1_000
const PROVIDER_COLORS: Record<UsageProviderId, string> = {
  'codex-business': '#337a68',
  'codex-personal': '#5875b8',
  claude: '#9a668f',
  ais: '#b97935',
}
const MODEL_COLORS = ['#4f7f72', '#5f77ad', '#b87843', '#8a6699', '#9a8b65', '#aeb5bb']

export const usagePlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.usage',
    name: '用量',
    description: '汇总 Codex、Claude、AIS 与本机 Agent 的额度、Token 和模型用量。',
    version: '1.2.0',
    engine: { codexHarness: '^0.4.17' },
    supportedScopes: ['global'],
    permissions: ['local:agent-usage', 'network:compass.llm.shopee.io'],
  },
  activate(ctx) {
    const usage = ctx.services.get<UsageService>('harness.usage')
    const refreshDefaultRange = () => {
      const dates = usageDateRange('30d')
      void usage.refreshSnapshot(dates.since, dates.until).catch(() => undefined)
    }
    refreshDefaultRange()
    const refreshTimer = globalThis.setInterval(refreshDefaultRange, USAGE_REFRESH_INTERVAL_MS)
    ctx.effect(() => globalThis.clearInterval(refreshTimer))
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
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dates = usageDateRange(range)

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      setSnapshot(await service.refreshSnapshot(dates.since, dates.until))
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError(null)
    void service.cachedSnapshot(dates.since, dates.until)
      .then(async (cached) => {
        if (disposed) return
        if (cached) setSnapshot(cached)
        setLoading(false)
        if (!cached || Date.now() - cached.fetchedAt >= USAGE_REFRESH_INTERVAL_MS) {
          setRefreshing(true)
          try {
            const fresh = await service.refreshSnapshot(dates.since, dates.until)
            if (!disposed) setSnapshot(fresh)
          } catch (nextError) {
            if (!disposed) setError(messageOf(nextError))
          } finally {
            if (!disposed) setRefreshing(false)
          }
        }
      })
      .catch((nextError) => {
        if (!disposed) {
          setLoading(false)
          setError(messageOf(nextError))
        }
      })
    const timer = window.setInterval(() => { if (!disposed) void refresh() }, USAGE_REFRESH_INTERVAL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [dates.since, dates.until, service])

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
            <button className="usage-refresh" type="button" onClick={() => void refresh()} disabled={loading || refreshing} title="刷新所有用量来源">
              <RefreshCw className={loading || refreshing ? 'spin' : ''} size={14} />刷新
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
        ) : selected && snapshot ? (
          <ProviderDetail provider={selected} todayDate={snapshot.until} />
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
  const totalCache = tokenProviders.reduce((total, provider) => total + provider.totals.cacheReadTokens + provider.totals.cacheCreationTokens, 0)
  const todayPeriods = tokenProviders.map((provider) => provider.periods.find((period) => period.date === snapshot.until)).filter((period): period is UsagePeriod => Boolean(period))
  const todayTokens = todayPeriods.reduce((total, period) => total + period.totalTokens, 0)
  const todayCache = todayPeriods.reduce((total, period) => total + period.cacheReadTokens + period.cacheCreationTokens, 0)
  const readySources = snapshot.providers.filter((provider) => provider.status === 'ready').length
  const weakest = weakestQuota(snapshot.providers)
  const ais = snapshot.providers.find((provider) => provider.id === 'ais')

  return (
    <main className="usage-content">
      <section className="usage-metrics" aria-label="关键用量指标">
        <MetricCard label="Token 总量" value={formatTokens(totalTokens)} subvalue={`缓存 ${formatTokens(totalCache)}`} note={`${tokenProviders.filter((provider) => provider.totals.totalTokens > 0).length} 个活跃账号`} />
        <MetricCard label="今日 Token" value={formatTokens(todayTokens)} subvalue={`缓存 ${formatTokens(todayCache)}`} note={snapshot.until} />
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

function ProviderDetail({ provider, todayDate }: { provider: UsageProvider; todayDate: string }) {
  const [chartMode, setChartMode] = useState<TokenChartMode>('composition')
  const quota = provider.quota[0]
  const budgetRemaining = provider.budget ? Math.max(0, provider.budget.totalUsd - provider.budget.usedUsd) : null
  const today = provider.periods.find((period) => period.date === todayDate)
  const totalCache = provider.totals.cacheReadTokens + provider.totals.cacheCreationTokens
  const todayCache = (today?.cacheReadTokens ?? 0) + (today?.cacheCreationTokens ?? 0)
  return (
    <main className="usage-content">
      <section className="usage-provider-title">
        <div className="usage-provider-mark" style={{ background: PROVIDER_COLORS[provider.id] }} />
        <div><h3>{provider.label}</h3><p>{providerDescription(provider)}</p></div>
        <span className={`usage-status ${provider.status}`}>{statusLabel(provider.status)}</span>
      </section>
      {provider.message && <div className="usage-notice">{provider.message}</div>}
      <section className={`usage-metrics ${provider.budget ? 'ais' : ''}`}>
        {provider.budget ? (
          <>
            <MetricCard label="本月已用" value={formatUsd(provider.budget.usedUsd)} note={`额度 ${formatUsd(provider.budget.totalUsd)}`} />
            <MetricCard label="本月剩余" value={formatUsd(budgetRemaining ?? 0)} note={`${budgetPercent(provider.budget).toFixed(0)}% 已使用`} tone={budgetPercent(provider.budget) > 80 ? 'danger' : 'good'} />
            <MetricCard label="额度使用率" value={`${budgetPercent(provider.budget).toFixed(0)}%`} note="当前 AIS 项目" tone={budgetPercent(provider.budget) > 80 ? 'danger' : 'good'} />
          </>
        ) : (
          <>
            <MetricCard label="Token 总量" value={formatTokens(provider.totals.totalTokens)} subvalue={`缓存 ${formatTokens(totalCache)}`} note={`${provider.periods.length} 个活跃日`} />
            <MetricCard label="今日 Token" value={formatTokens(today?.totalTokens ?? 0)} subvalue={`缓存 ${formatTokens(todayCache)}`} note={today ? todayDate : `${todayDate} 暂无记录`} />
            <MetricCard label="输入 / 输出" value={`${formatTokens(provider.totals.inputTokens)} / ${formatTokens(provider.totals.outputTokens)}`} note="不含缓存读取" />
            <MetricCard label={quota?.label ?? '估算费用'} value={quota ? `${Math.round(quota.remainingPercent)}%` : provider.totals.costUsd > 0 ? formatUsd(provider.totals.costUsd) : '—'} note={quota ? resetCopy(quota) : '仅在 ccusage 有价格数据时显示'} tone={quota && quota.remainingPercent < 20 ? 'danger' : 'good'} />
          </>
        )}
      </section>

      {provider.budget ? (
        <section className="usage-panel"><PanelHeading title="月度额度" detail="AIS Switch 当前项目" /><BudgetBar budget={provider.budget} large /></section>
      ) : (
        <section className="usage-panel usage-trend-panel">
          <header className="usage-panel-heading usage-chart-heading">
            <div><h3>{chartMode === 'composition' ? 'Token 组成' : '模型用量'}</h3><span>{chartMode === 'composition' ? '每日输入、输出和缓存读取' : '每日不同模型的 Token 用量'}</span></div>
            <div className="usage-chart-switch" role="group" aria-label="Token 图表模式">
              <button type="button" className={chartMode === 'composition' ? 'selected' : ''} onClick={() => setChartMode('composition')}>组成</button>
              <button type="button" className={chartMode === 'models' ? 'selected' : ''} onClick={() => setChartMode('models')}>模型</button>
            </div>
          </header>
          {chartMode === 'composition' ? <TokenStackChart periods={provider.periods} /> : <ModelStackChart provider={provider} />}
        </section>
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
  const pad = { left: 62, right: 18, top: 14, bottom: 38 }
  const max = Math.max(1, ...providers.flatMap((provider) => provider.periods.map((period) => period.totalTokens)))
  const x = (index: number) => pad.left + index * ((width - pad.left - pad.right) / Math.max(1, dates.length - 1))
  const y = (value: number) => pad.top + (height - pad.top - pad.bottom) * (1 - value / max)
  return (
    <div className="usage-chart-wrap">
      <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日 Token 趋势图">
        {[0, .25, .5, .75, 1].map((ratio) => <g key={ratio}><line x1={pad.left} x2={width - pad.right} y1={y(max * ratio)} y2={y(max * ratio)} className="usage-grid-line" /><text x={pad.left - 8} y={y(max * ratio) + 3} textAnchor="end">{formatAxisTokens(max * ratio)}</text></g>)}
        {dateTickIndexes(dates.length).map((index) => <text key={index} x={x(index)} y={height - 16} textAnchor={index === 0 ? 'start' : index === dates.length - 1 ? 'end' : 'middle'}>{shortDate(dates[index])}</text>)}
        <text x="13" y={height / 2} transform={`rotate(-90 13 ${height / 2})`} textAnchor="middle" className="usage-axis-label">TOKEN</text><text x={width - pad.right} y={height - 3} textAnchor="end" className="usage-axis-label">日期</text>
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
  const pad = { left: 62, right: 18, top: 14, bottom: 38 }
  const max = Math.max(1, ...visible.map((period) => period.inputTokens + period.outputTokens + period.cacheReadTokens + period.cacheCreationTokens))
  const plotHeight = height - pad.top - pad.bottom
  const slot = (width - pad.left - pad.right) / visible.length
  const barWidth = Math.max(2, Math.min(13, slot * .62))
  return (
    <div className="usage-chart-wrap">
      <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日 Token 组成图">
        {[0, .25, .5, .75, 1].map((ratio) => {
          const tickY = pad.top + plotHeight * (1 - ratio)
          return <g key={ratio}><line x1={pad.left} x2={width - pad.right} y1={tickY} y2={tickY} className="usage-grid-line" /><text x={pad.left - 8} y={tickY + 3} textAnchor="end">{formatAxisTokens(max * ratio)}</text></g>
        })}
        {visible.map((period, index) => {
          const x = pad.left + slot * index + (slot - barWidth) / 2
          let bottom = pad.top + plotHeight
          const segments = [
            { value: period.cacheReadTokens + period.cacheCreationTokens, className: 'cache' },
            { value: period.inputTokens, className: 'input' },
            { value: period.outputTokens, className: 'output' },
          ]
          return <g key={period.date}><title>{period.date} · {formatTokens(period.totalTokens)}</title>{segments.map((segment) => {
            const segmentHeight = plotHeight * segment.value / max
            bottom -= segmentHeight
            return <rect key={segment.className} x={x} y={bottom} width={barWidth} height={Math.max(0, segmentHeight)} className={`usage-bar-${segment.className}`} rx="1.5" />
          })}</g>
        })}
        {dateTickIndexes(visible.length).map((index) => <text key={index} x={pad.left + slot * index + slot / 2} y={height - 16} textAnchor={index === 0 ? 'start' : index === visible.length - 1 ? 'end' : 'middle'}>{shortDate(visible[index].date)}</text>)}
        <text x="13" y={height / 2} transform={`rotate(-90 13 ${height / 2})`} textAnchor="middle" className="usage-axis-label">TOKEN</text><text x={width - pad.right} y={height - 3} textAnchor="end" className="usage-axis-label">日期</text>
      </svg>
      <div className="usage-chart-legend"><span><i className="cache" />缓存</span><span><i className="input" />输入</span><span><i className="output" />输出</span></div>
    </div>
  )
}

function ModelStackChart({ provider }: { provider: UsageProvider }) {
  const visible = provider.periods.slice(-45)
  const modelNames = [...provider.models]
    .sort((left, right) => right.totalTokens - left.totalTokens)
    .slice(0, 5)
    .map((model) => model.model)
  if (visible.length === 0 || modelNames.length === 0) return <EmptyChart copy="所选时间内没有模型用量记录" />
  const width = 760
  const height = 220
  const pad = { left: 62, right: 18, top: 14, bottom: 38 }
  const plotHeight = height - pad.top - pad.bottom
  const max = Math.max(1, ...visible.map((period) => period.totalTokens))
  const slot = (width - pad.left - pad.right) / visible.length
  const barWidth = Math.max(2, Math.min(13, slot * .62))
  return (
    <div className="usage-chart-wrap">
      <svg className="usage-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="每日模型 Token 用量图">
        {[0, .25, .5, .75, 1].map((ratio) => {
          const tickY = pad.top + plotHeight * (1 - ratio)
          return <g key={ratio}><line x1={pad.left} x2={width - pad.right} y1={tickY} y2={tickY} className="usage-grid-line" /><text x={pad.left - 8} y={tickY + 3} textAnchor="end">{formatAxisTokens(max * ratio)}</text></g>
        })}
        {visible.map((period, periodIndex) => {
          const byModel = new Map(period.models.map((model) => [model.model, model.totalTokens]))
          const namedTotal = modelNames.reduce((total, name) => total + (byModel.get(name) ?? 0), 0)
          const segments = [...modelNames.map((name, index) => ({ name, value: byModel.get(name) ?? 0, color: MODEL_COLORS[index] })), {
            name: '其他', value: Math.max(0, period.totalTokens - namedTotal), color: MODEL_COLORS[5],
          }]
          const x = pad.left + slot * periodIndex + (slot - barWidth) / 2
          let bottom = pad.top + plotHeight
          return <g key={period.date}><title>{period.date} · {segments.filter((segment) => segment.value > 0).map((segment) => `${segment.name} ${formatTokens(segment.value)}`).join(' · ')}</title>{segments.map((segment) => {
            const segmentHeight = plotHeight * segment.value / max
            bottom -= segmentHeight
            return <rect key={segment.name} x={x} y={bottom} width={barWidth} height={Math.max(0, segmentHeight)} fill={segment.color} rx="1.5" />
          })}</g>
        })}
        {dateTickIndexes(visible.length).map((index) => <text key={index} x={pad.left + slot * index + slot / 2} y={height - 16} textAnchor={index === 0 ? 'start' : index === visible.length - 1 ? 'end' : 'middle'}>{shortDate(visible[index].date)}</text>)}
        <text x="13" y={height / 2} transform={`rotate(-90 13 ${height / 2})`} textAnchor="middle" className="usage-axis-label">TOKEN</text><text x={width - pad.right} y={height - 3} textAnchor="end" className="usage-axis-label">日期</text>
      </svg>
      <div className="usage-chart-legend">{modelNames.map((name, index) => <span key={name} title={name}><i style={{ background: MODEL_COLORS[index] }} />{shortModelName(name)}</span>)}<span><i style={{ background: MODEL_COLORS[5] }} />其他</span></div>
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

function MetricCard({ label, value, subvalue, note, tone = 'neutral' }: { label: string; value: string; subvalue?: string; note: string; tone?: string }) {
  return <article className={`usage-metric ${tone}`}><span>{label}</span><div className="usage-metric-value"><strong>{value}</strong>{subvalue && <em>({subvalue})</em>}</div><small>{note}</small></article>
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

function dateTickIndexes(length: number): number[] {
  return [0, Math.floor((length - 1) / 2), length - 1].filter((value, index, values) => value >= 0 && values.indexOf(value) === index)
}

function formatAxisTokens(value: number): string {
  if (value === 0) return '0'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`
  return Math.round(value).toString()
}

function shortModelName(model: string): string {
  const name = model.split('/').at(-1) ?? model
  return name.length > 22 ? `${name.slice(0, 20)}…` : name
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
  if (provider.id === 'claude') return 'Claude Code 本机日志与模型用量'
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
