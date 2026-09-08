import { useEffect, useState } from 'react'
import type { UsageService, UsageSnapshot } from '../../core/usage/types'
import { formatTokens } from './format'

export function SourceCards({ service, since, until, revision }: { service: UsageService; since: string; until: string; revision: number }) {
  const key = `${since}:${until}`
  const [result, setResult] = useState<{ key: string; data: UsageSnapshot } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    setError(null); setLoading(true)
    void (async () => {
      try {
        const cached = await service.cachedSnapshot(since, until)
        if (!cancelled && cached) setResult({ key, data: cached })
        const data = await service.refreshSnapshot(since, until)
        if (!cancelled) setResult({ key, data })
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) }
      finally { if (!cancelled) setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [service, since, until, revision])
  const snapshot = result?.key === key ? result.data : null
  return <section aria-label="账号用量" className="analysis-sources">
    {([['codex-business', 'Codex'], ['codex-personal', 'Codex Personal'], ['ais', 'AIS']] as const).map(([id, label]) => {
      const provider = snapshot?.providers.find((p) => p.id === id)
      const available = provider?.status === 'ready'
      return <article key={id} className={`analysis-source ${id}`}>
        <header><h3>{label}</h3><span>{loading ? '更新中…' : available ? '已更新' : '暂不可用'}</span></header>
        {id === 'ais' ? <><strong>{provider?.budget ? `$${provider.budget.usedUsd.toFixed(2)}` : '—'}</strong><p>本月已用{provider?.budget ? ` / $${provider.budget.totalUsd.toFixed(2)}` : ''}</p></> : <><strong title={provider?.totals.totalTokens.toLocaleString()}>{provider && (available || provider.totals.totalTokens > 0) ? formatTokens(provider.totals.totalTokens) : '—'} <small>Token</small></strong><p>{since} — {until} · 本机历史</p></>}
        {id !== 'ais' && <div className="analysis-source-quota">{provider?.quota.length ? provider.quota.map((q) => <span key={q.label} title={q.resetsAt ? `重置于 ${new Date(q.resetsAt * 1000).toLocaleString()}` : undefined}>{q.label} · 剩余 {Math.round(q.remainingPercent)}%</span>) : <span>当前额度 · 暂不可用</span>}</div>}
        {(error || provider?.message) && <small className="analysis-source-error" title={error || provider?.message || undefined}>{error || provider?.message}</small>}
      </article>
    })}
  </section>
}
