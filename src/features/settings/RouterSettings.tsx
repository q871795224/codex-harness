import { useEffect, useId, useState } from 'react'
import { GitBranch, RefreshCw, Search, Clock3 } from 'lucide-react'
import { runtime } from '../../core/runtime/bridge'
import type { RouterSummary } from '../../core/workspace-router/types'
import { refreshRouterSummaries } from '../../core/workspace-router/summaries'
import type { CodexModel, Workspace } from '../../core/domain/codex'
import { DEFAULT_ROUTER_SETTINGS, loadRouterSettings, saveRouterSettings, type RouterSettings as Settings } from '../../core/workspace-router/settings'
import './RouterSettings.css'

const DAY = 24 * 60 * 60_000
export function routerNextCheck(summary: RouterSummary | undefined, now: number): string {
  if (summary?.updating) return '正在更新介绍'
  const next = summary?.nextCheckAt ?? (summary?.checkedAt ? summary.checkedAt + DAY : null)
  if (!next) return '等待首次检查'
  const minutes = Math.ceil((next - now) / 60_000)
  if (minutes <= 0) return '已到检查时间'
  const hours = Math.floor(minutes / 60), rest = minutes % 60
  return `${hours ? `${hours} 小时` : ''}${rest ? ` ${rest} 分钟` : ''}`.trim() + '后检查'
}
function cacheState(summary?: RouterSummary) {
  return summary?.updating ? '更新中' : summary?.error ? '更新失败' : summary?.description ? '已缓存' : summary?.checkedAt ? '无可用文档' : '待生成'
}
const date = (value?: number | null) => value ? new Date(value).toLocaleString() : '尚未检查'

export function RouterSettings({ models, workspaces, initialSection = 'configuration', standalone = false }: {
  models: CodexModel[]; workspaces: Workspace[]; initialSection?: 'workspaces' | 'configuration'; standalone?: boolean
}) {
  const id = useId()
  const materialsId = `${id}-materials`, configurationId = `${id}-configuration`
  const [section, setSection] = useState(initialSection)
  const [selectedRoot, setSelectedRoot] = useState(workspaces[0]?.root ?? '')
  const [query, setQuery] = useState('')
  const [now, setNow] = useState(Date.now())
  const [summaries, setSummaries] = useState<RouterSummary[]>([])
  const [cacheError, setCacheError] = useState(false)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [refreshStatus, setRefreshStatus] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [draft, setDraft] = useState<Settings>({ ...DEFAULT_ROUTER_SETTINGS })
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  useEffect(() => {
    let disposed = false
    void loadRouterSettings().then(value => { if (!disposed) { setDraft(value); setLoaded(true) } })
      .catch(next => { if (!disposed) setError(String(next)) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [])
  const roots = workspaces.map(w => w.root).join('\n')
  useEffect(() => {
    if (!workspaces.some(w => w.root === selectedRoot)) setSelectedRoot(workspaces[0]?.root ?? '')
  }, [roots, selectedRoot, workspaces])
  useEffect(() => {
    let disposed = false, sequence = 0
    const load = () => {
      const request = ++sequence
      void runtime.routerSummaries(roots ? roots.split('\n') : []).then(value => {
        if (!disposed && request === sequence) { setSummaries(value); setCacheError(false) }
      }).catch(() => { if (!disposed && request === sequence) setCacheError(true) })
    }
    load()
    const timer = window.setInterval(load, refreshing ? 1000 : 15_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [roots, refreshing])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer) }, [])
  const selected = models.find(model => model.model === draft.model)
  const efforts = selected?.supportedReasoningEfforts.map(item => item.reasoningEffort) ?? ['low', 'medium', 'high', 'xhigh', 'max']
  const busy = loading || saving || !loaded
  const workspace = workspaces.find(w => w.root === selectedRoot)
  const summary = summaries.find(s => s.root === selectedRoot)
  const filtered = workspaces.filter(w => `${w.name} ${w.root}`.toLowerCase().includes(query.toLowerCase()))
  const update = (patch: Partial<Settings>) => { setDraft(current => ({ ...current, ...patch })); setStatus('有未保存的修改'); setError(null) }
  const save = async () => {
    setSaving(true); setError(null)
    try { setDraft(await saveRouterSettings(draft)); setStatus('已保存，下次路由生效') }
    catch (next) { setError(next instanceof Error ? next.message : String(next)) }
    finally { setSaving(false) }
  }
  const refresh = async (targets: Workspace[], key: string) => {
    setRefreshing(key); setRefreshStatus(''); setRefreshError('')
    try {
      const results = await refreshRouterSummaries(targets, () => false, true)
      const failed = results.filter(r => r.failed).length
      if (failed) setRefreshError(`${failed} 个工作区更新失败，已保留原有介绍，可重试。`)
      else setRefreshStatus('检查完成，最新状态已显示。')
      setSummaries(await runtime.routerSummaries(workspaces.map(w => w.root))); setCacheError(false); setNow(Date.now())
    } catch { setRefreshError('暂时无法完成更新，请重试。'); setCacheError(true) }
    finally { setRefreshing(null) }
  }
  return <div className={`router-settings${standalone ? ' router-page' : ''}`}>
    <header className="router-page-head"><div><h2><GitBranch size={20} />工作区 Router</h2><p>查看路由使用的介绍，管理更新与判断设置。配置适用于所有工作区。</p></div><span className="router-engine">Codex · {draft.model}</span></header>
    <div className="router-sections" role="tablist" aria-label="Router 管理分区" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : section === 'workspaces' ? 1 : 0
      setSection(index === 0 ? 'workspaces' : 'configuration')
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
    }}>
      <button type="button" role="tab" id={`${materialsId}-tab`} aria-controls={materialsId} tabIndex={section === 'workspaces' ? 0 : -1} aria-selected={section === 'workspaces'} onClick={() => setSection('workspaces')}>工作区介绍<span>{workspaces.length}</span></button>
      <button type="button" role="tab" id={`${configurationId}-tab`} aria-controls={configurationId} tabIndex={section === 'configuration' ? 0 : -1} aria-selected={section === 'configuration'} onClick={() => setSection('configuration')}>判断设置</button>
    </div>
    <section id={materialsId} role="tabpanel" aria-labelledby={`${materialsId}-tab`} hidden={section !== 'workspaces'}>
      <div className="router-cache-toolbar"><p><Clock3 size={14} />每 24 小时检查，文档变化才重新生成</p><button type="button" disabled={busy || Boolean(refreshing) || workspaces.length === 0} onClick={() => void refresh(workspaces, 'all')}><RefreshCw size={14} />{refreshing === 'all' ? '正在检查全部…' : '更新全部'}</button></div>
      {cacheError && <p role="alert">无法读取简介缓存，路由仍可使用工作区名称和手填说明。</p>}
      {refreshStatus && <p className="router-update-message" role="status">{refreshStatus}</p>}
      {refreshError && <p className="router-update-message" role="alert">{refreshError}</p>}
      <div className="router-cache-layout">
        <aside className="router-workspace-list" aria-label="路由工作区"><label className="router-search"><Search size={14} /><input aria-label="搜索路由工作区" placeholder="搜索工作区" value={query} onChange={event => setQuery(event.target.value)} /></label>
          {filtered.map(w => <button type="button" key={w.root} aria-pressed={selectedRoot === w.root} onClick={() => setSelectedRoot(w.root)}><span>{w.name}<small>{w.root}</small></span><em>{cacheState(summaries.find(s => s.root === w.root))}</em></button>)}
          {!filtered.length && <p>{workspaces.length ? '没有匹配的工作区' : '添加工作区后，介绍会显示在这里。'}</p>}
        </aside>
        {workspace && <article className="router-workspace-detail">
          <header><div><h3>{workspace.name}</h3><p>{workspace.checkoutRoot}</p></div><button type="button" disabled={busy || Boolean(refreshing) || summary?.updating} onClick={() => void refresh([workspace], workspace.root)}><RefreshCw size={14} />{refreshing === workspace.root || summary?.updating ? '正在更新…' : '立即更新'}</button></header>
          <div className="router-update-facts"><div><span>当前状态</span><strong>{cacheState(summary)}</strong></div><div><span>下次检查</span><strong title={date(summary?.nextCheckAt)}>{routerNextCheck(summary, now)}</strong></div></div>
          <div className="router-description-body"><h4>自动介绍</h4><p>{summary?.description || '尚无自动介绍。点击“立即更新”检查 AGENTS.md 和 README；缺少文档时仍可使用下方补充说明。'}</p></div>
          <dl className="router-update-dates"><div><dt>上次检查</dt><dd>{date(summary?.checkedAt)}</dd></div><div><dt>介绍生成</dt><dd>{summary?.generatedAt ? date(summary.generatedAt) : '尚未生成'}</dd></div></dl>
          {summary?.error && <p role="alert" className="router-update-message">上次更新失败，当前仍使用已有介绍。可以点击“立即更新”重试。</p>}
          <label className="router-supplement"><span>补充说明</span><small>可补充职责边界；与自动介绍一起用于路由。</small><textarea aria-label={`${workspace.name} 的路由用途`} maxLength={4000} rows={3} disabled={busy} value={draft.descriptions[workspace.root] ?? ''} placeholder="例如：管理侧接口在这里，解析节点程序位于 dns-agent。" onChange={event => update({ descriptions: { ...draft.descriptions, [workspace.root]: event.target.value } })} /></label>
          <p className="router-note">立即更新会跳过等待时间；文档未变化时复用缓存。应用关闭或休眠期间暂停检查。</p>
        </article>}
      </div>
    </section>
    <section id={configurationId} role="tabpanel" aria-labelledby={`${configurationId}-tab`} hidden={section !== 'configuration'} className="router-configuration">
      <h3>第二步：判断工作区</h3><p>当前通过 Codex 临时会话选择工作区，可单独设置模型与推理强度。</p>
      <div className="router-setting-rows">
        <label><span>判断后端</span><strong>Codex</strong></label>
        <label><span>Router 模型</span><select aria-label="Router 模型" value={draft.model} disabled={busy} onChange={event => { const model = models.find(item => item.model === event.target.value); update({ model: event.target.value, effort: !model || model.supportedReasoningEfforts.some(item => item.reasoningEffort === draft.effort) ? draft.effort : model.defaultReasoningEffort ?? '' }) }}>
          {!selected && <option value={draft.model}>{draft.model}（当前配置）</option>}{models.map(model => <option key={model.id} value={model.model}>{model.displayName}</option>)}
        </select></label>
        <label><span>推理强度</span><select aria-label="Router 推理强度" value={draft.effort} disabled={busy} onChange={event => update({ effort: event.target.value })}><option value="">模型默认</option>{draft.effort && !efforts.includes(draft.effort) && <option value={draft.effort}>{draft.effort}（当前配置）</option>}{efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
        <label><span>路由文本预算</span><input aria-label="Router 文本预算" type="number" min={2048} max={32768} step={1024} value={draft.tokenBudget ?? 8192} disabled={busy} onChange={event => update({ tokenBudget: Number(event.target.value) })} /></label>
      </div><p className="router-note">预算包含原始需求、工作区介绍和纠错案例。超限先减少案例和介绍，保留原始需求与工作区列表；图片及系统背景另计。</p><p className="router-note">介绍需要重新生成时也使用这里的模型设置；更换模型不会自动重建已有缓存。</p>
    </section>
    <footer className="router-settings-footer"><div>{status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}</div><div>{section === 'configuration' && <button type="button" disabled={busy} onClick={() => update({ model: DEFAULT_ROUTER_SETTINGS.model, effort: DEFAULT_ROUTER_SETTINGS.effort })}>恢复默认模型</button>}<button type="button" className="primary" disabled={busy} onClick={() => void save()}>{saving ? '保存中…' : section === 'workspaces' ? '保存补充说明' : '保存设置'}</button></div></footer>
  </div>
}
