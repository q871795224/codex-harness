import { useEffect, useId, useState } from 'react'
import { GitBranch, RefreshCw, Search } from 'lucide-react'
import { runtime } from '../../core/runtime/bridge'
import type { RouterSummary } from '../../core/workspace-router/types'
import { refreshRouterSummaries } from '../../core/workspace-router/summaries'
import type { CodexModel, Workspace } from '../../core/domain/codex'
import { DEFAULT_ROUTER_SETTINGS, loadRouterSettings, saveRouterSettings, type RouterSettings as Settings } from '../../core/workspace-router/settings'
import { DECISION_ENDPOINT, DECISION_MODEL } from '../../core/workspace-router/service'
import { RouterPromptPanel } from '../router/RouterPromptPanel'
import { RouterFeedbackPanel } from '../router/RouterFeedbackPanel'
import './RouterSettings.css'

type RouterSection = 'workspaces' | 'prompt' | 'configuration' | 'feedback'
const SECTIONS: Array<{ id: RouterSection; label: string }> = [{ id: 'workspaces', label: '工作区' }, { id: 'prompt', label: '最终 Prompt' }, { id: 'feedback', label: '反馈' }, { id: 'configuration', label: '设置' }]
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
  models: CodexModel[]; workspaces: Workspace[]; initialSection?: RouterSection; standalone?: boolean
}) {
  const id = useId()
  const [section, setSection] = useState<RouterSection>(initialSection)
  const [visited, setVisited] = useState<Set<RouterSection>>(() => new Set([initialSection]))
  const selectSection = (next: RouterSection) => { setSection(next); setVisited(previous => new Set([...previous, next])) }
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
  const [settingsVersion, setSettingsVersion] = useState(0)
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
  const codex = draft.backend === 'codex'
  const busy = loading || saving || !loaded
  const workspace = workspaces.find(w => w.root === selectedRoot)
  const summary = summaries.find(s => s.root === selectedRoot)
  const filtered = workspaces.filter(w => `${w.name} ${w.root}`.toLowerCase().includes(query.toLowerCase()))
  const update = (patch: Partial<Settings>) => { setDraft(current => ({ ...current, ...patch })); setStatus('有未保存的修改'); setError(null) }
  const save = async () => {
    setSaving(true); setError(null)
    try { setDraft(await saveRouterSettings(draft)); setStatus('已保存，下次路由生效'); setSettingsVersion(value => value + 1) }
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
  const feedbackCount = draft.feedbackCount ?? 3
  const feedbackRule = draft.feedbackRule ?? 'relevant'
  const statusClass = (value?: RouterSummary) => value?.updating ? 'updating' : value?.error ? 'error' : value?.description ? 'ready' : 'pending'
  const messages = <>{status && <p role="status">{status}</p>}</>
  return <div className={`router-settings${standalone ? ' router-page' : ''}`}>
    <header className="router-page-head"><h2><GitBranch size={20} />工作区 Router</h2></header>
    <div className="router-sections" role="tablist" aria-label="Router 管理分区" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = SECTIONS.findIndex(item => item.id === section)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length
      selectSection(SECTIONS[index].id)
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus()
    }}>
      {SECTIONS.map(item => <button type="button" role="tab" key={item.id} id={`${id}-${item.id}-tab`} aria-controls={`${id}-${item.id}`} tabIndex={section === item.id ? 0 : -1} aria-selected={section === item.id} onClick={() => selectSection(item.id)}>{item.label}</button>)}
    </div>
    {error && <p role="alert">{error}</p>}
    <section id={`${id}-workspaces`} role="tabpanel" aria-labelledby={`${id}-workspaces-tab`} hidden={section !== 'workspaces'}>
      <div className="router-cache-toolbar"><label className="router-search"><Search size={14} /><input aria-label="搜索路由工作区" placeholder="搜索工作区" value={query} onChange={event => setQuery(event.target.value)} /></label><button type="button" disabled={busy || Boolean(refreshing) || !workspaces.length} onClick={() => void refresh(workspaces, 'all')}><RefreshCw size={14} />{refreshing === 'all' ? '正在检查全部…' : '更新全部'}</button></div>
      {cacheError && <p role="alert">无法读取简介缓存。</p>}
      {refreshStatus && <p className="router-update-message" role="status">{refreshStatus}</p>}
      {refreshError && <p className="router-update-message" role="alert">{refreshError}</p>}
      <div className="router-cache-layout">
        <aside className="router-workspace-list" aria-label="路由工作区">
          {filtered.map(w => <button type="button" key={w.root} aria-pressed={selectedRoot === w.root} onClick={() => setSelectedRoot(w.root)}><span className={`router-status-dot ${statusClass(summaries.find(s => s.root === w.root))}`} /><span>{w.name}</span></button>)}
          {!filtered.length && <p>{workspaces.length ? '没有匹配的工作区' : '暂无工作区'}</p>}
        </aside>
        {workspace && <article className="router-workspace-detail">
          <header><div className="router-workspace-heading"><span className={`router-status ${statusClass(summary)}`}>{cacheState(summary)}</span><h3>{workspace.name}</h3><span className="router-workspace-path" title={workspace.checkoutRoot}>{workspace.checkoutRoot}</span></div>
          <div className="router-detail-actions"><span className="router-next-check" title={`上次检查：${date(summary?.checkedAt)}\n介绍生成：${date(summary?.generatedAt)}\n下次检查：${date(summary?.nextCheckAt)}`}>{routerNextCheck(summary, now)}</span><button type="button" disabled={busy || Boolean(refreshing) || summary?.updating} onClick={() => void refresh([workspace], workspace.root)}><RefreshCw size={14} />{refreshing === workspace.root || summary?.updating ? '正在更新…' : '立即更新'}</button></div></header>
          <div className="router-description-body"><h4>介绍</h4><p>{summary?.description || '暂无介绍'}</p></div>
          {summary?.error && <p role="alert" className="router-update-message">更新失败，已保留原有介绍。</p>}
          <label className="router-supplement"><span>补充说明</span><textarea aria-label={`${workspace.name} 的路由用途`} maxLength={4000} rows={3} disabled={busy} value={draft.descriptions[workspace.root] ?? ''} onChange={event => update({ descriptions: { ...draft.descriptions, [workspace.root]: event.target.value } })} /></label>
          <footer className="router-settings-footer"><div>{section === 'workspaces' && messages}</div><button type="button" className="primary" disabled={busy} onClick={() => void save()}>{saving ? '保存中…' : '保存补充说明'}</button></footer>
        </article>}
      </div>
    </section>
    <section id={`${id}-prompt`} role="tabpanel" aria-labelledby={`${id}-prompt-tab`} hidden={section !== 'prompt'}>{visited.has('prompt') && <RouterPromptPanel workspaces={workspaces} settingsVersion={settingsVersion} active={section === 'prompt'} cacheVersion={summaries.map(s => `${s.root}:${s.generatedAt}:${s.description}`).join('|')} />}</section>
    <section id={`${id}-configuration`} role="tabpanel" aria-labelledby={`${id}-configuration-tab`} hidden={section !== 'configuration'} className="router-configuration">
      <div className={`router-backend ${codex ? 'active' : 'inactive'}`}><h3><label><input type="radio" name={`${id}-backend`} checked={codex} disabled={busy} onChange={() => update({ backend: 'codex' })} />Codex 临时会话</label></h3>
        <div className="router-setting-rows">
          <label><span>模型</span><select aria-label="Router 模型" value={draft.model} disabled={busy || !codex} onChange={event => { const model = models.find(item => item.model === event.target.value); update({ model: event.target.value, effort: !model || model.supportedReasoningEfforts.some(item => item.reasoningEffort === draft.effort) ? draft.effort : model.defaultReasoningEffort ?? '' }) }}>
            {!selected && <option value={draft.model}>{draft.model}（当前配置）</option>}{models.map(model => <option key={model.id} value={model.model}>{model.displayName}</option>)}
          </select></label>
          <label><span>推理强度</span><select aria-label="Router 推理强度" value={draft.effort} disabled={busy || !codex} onChange={event => update({ effort: event.target.value })}><option value="">模型默认</option>{draft.effort && !efforts.includes(draft.effort) && <option value={draft.effort}>{draft.effort}（当前配置）</option>}{efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>
        </div>
      </div>
      <div className={`router-backend ${!codex ? 'active' : 'inactive'}`}><h3><label><input type="radio" name={`${id}-backend`} checked={!codex} disabled={busy} onChange={() => update({ backend: 'decision2' })} />Chinese Decision 2B</label></h3><div className="router-setting-rows"><label><span>服务地址</span><input aria-label="Decision 服务地址" value={DECISION_ENDPOINT} readOnly disabled={busy || codex} /></label><label><span>模型</span><input aria-label="Decision 模型" value={DECISION_MODEL} readOnly disabled={busy || codex} /></label></div></div>
      <fieldset className="router-backend" disabled><h3><label><input type="radio" name={`${id}-backend`} />其他模型 API</label><span>未接入</span></h3><div className="router-setting-rows"><label><span>API 地址</span><input aria-label="其他模型 API 地址" /></label><label><span>模型</span><input aria-label="其他模型名称" /></label></div></fieldset>
      <div className="router-setting-rows router-common-settings">
        <label><span>路由文本预算</span><input aria-label="Router 文本预算" type="number" min={2048} max={32768} step={1024} value={draft.tokenBudget ?? 8192} disabled={busy} onChange={event => update({ tokenBudget: Number(event.target.value) })} /></label>
        <label><span>纠错引用上限</span><input aria-label="纠错引用上限" type="number" min={0} max={10} value={feedbackCount} disabled={busy} onChange={event => update({ feedbackCount: Number(event.target.value) })} /></label>
        <label><span>纠错选取规则</span><select aria-label="纠错选取规则" value={feedbackRule} disabled={busy} onChange={event => update({ feedbackRule: event.target.value as 'relevant' | 'recent' })}><option value="relevant">相关优先</option><option value="recent">最近优先</option></select></label>
      </div>
      <footer className="router-settings-footer"><div>{section === 'configuration' && messages}</div><div><button type="button" disabled={busy} onClick={() => update({ backend: DEFAULT_ROUTER_SETTINGS.backend, model: DEFAULT_ROUTER_SETTINGS.model, effort: DEFAULT_ROUTER_SETTINGS.effort })}>恢复默认模型</button><button type="button" className="primary" disabled={busy} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</button></div></footer>
    </section>
    <section id={`${id}-feedback`} role="tabpanel" aria-labelledby={`${id}-feedback-tab`} hidden={section !== 'feedback'}>{visited.has('feedback') && <RouterFeedbackPanel workspaces={workspaces} active={section === 'feedback'} />}</section>
  </div>
}
