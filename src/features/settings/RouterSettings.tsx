import { useEffect, useState } from 'react'
import { runtime } from '../../core/runtime/bridge'
import type { RouterSummary } from '../../core/workspace-router/types'
import { GitBranch } from 'lucide-react'
import type { CodexModel, Workspace } from '../../core/domain/codex'
import { DEFAULT_ROUTER_SETTINGS, loadRouterSettings, saveRouterSettings, type RouterSettings as Settings } from '../../core/workspace-router/settings'

export function RouterSettings({ models, workspaces }: { models: CodexModel[]; workspaces: Workspace[] }) {
  const [summaries, setSummaries] = useState<RouterSummary[]>([])
  const [cacheError, setCacheError] = useState(false)
  const [draft, setDraft] = useState<Settings>({ ...DEFAULT_ROUTER_SETTINGS })
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  useEffect(() => {
    let disposed = false
    void loadRouterSettings().then((value) => { if (!disposed) { setDraft(value); setLoaded(true) } })
      .catch((next) => { if (!disposed) setError(String(next)) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [])
  useEffect(() => {
    let disposed = false
    const load = () => { void runtime.routerSummaries(workspaces.map(w => w.root)).then(value => { if (!disposed) { setSummaries(value); setCacheError(false) } }).catch(() => { if (!disposed) setCacheError(true) }) }
    load()
    const timer = window.setInterval(load, 30_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [workspaces])
  const selected = models.find((model) => model.model === draft.model)
  const efforts = selected?.supportedReasoningEfforts.map((item) => item.reasoningEffort) ?? ['low', 'medium', 'high', 'xhigh', 'max']
  const busy = loading || saving || !loaded
  const update = (patch: Partial<Settings>) => { setDraft((current) => ({ ...current, ...patch })); setStatus('有未保存的修改'); setError(null) }
  const save = async () => {
    setSaving(true); setError(null)
    try { setDraft(await saveRouterSettings(draft)); setStatus('已保存，下次路由生效') }
    catch (next) { setError(next instanceof Error ? next.message : String(next)) }
    finally { setSaving(false) }
  }
  return <div className="settings-section codex-settings">
    <section className="codex-setting-card">
      <div className="settings-section-title"><GitBranch size={17} /><div><h3>工作区 Router</h3><p>新 Codex 会话未手动选择工作区时，发送后自动选择并开始工作。人工纠错会用于后续路由；当前轮结束后可保存并切换工作区，不自动重做已有操作。</p></div></div>
      <div className="settings-row-list">
        <label className="settings-row"><span>Router 模型</span><select aria-label="Router 模型" value={draft.model} disabled={busy} onChange={(event) => {
          const model = models.find((item) => item.model === event.target.value)
          update({ model: event.target.value, effort: !model || model.supportedReasoningEfforts.some((item) => item.reasoningEffort === draft.effort) ? draft.effort : model.defaultReasoningEffort ?? '' })
        }}>
          {!selected && <option value={draft.model}>{draft.model}（当前配置）</option>}
          {models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
        </select></label>
        <label className="settings-row"><span>推理强度</span><select aria-label="Router 推理强度" value={draft.effort} disabled={busy} onChange={(event) => update({ effort: event.target.value })}>
          <option value="">模型默认</option>
          {draft.effort && !efforts.includes(draft.effort) && <option value={draft.effort}>{draft.effort}（当前配置）</option>}
          {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select></label>
        <label className="settings-row"><span>路由文本预算</span><input aria-label="Router 文本预算" type="number" min={2048} max={32768} step={1024} value={draft.tokenBudget ?? 8192} disabled={busy} onChange={event => update({ tokenBudget: Number(event.target.value) })} /></label>
      </div>
      <p>默认 8,192 tokens，包含原始需求、工作区介绍和纠错案例。超限时先减少案例和介绍，保留你的原始需求和工作区列表；图片及系统背景另计。</p>
    </section>
    <section className="codex-setting-card">
      <div className="settings-section-title"><div><h3>工作区用途</h3><p>后台每24小时检查根目录 AGENTS.md 和 README，仅内容变化时生成并保存简介。可在下方补充职责边界；更新失败时继续使用旧简介。</p></div></div>
      {cacheError && <p role="alert">无法读取简介缓存，路由仍可使用工作区名称和手填说明。</p>}
      {workspaces.map((workspace) => <label className="title-prompt-field router-description" key={workspace.root}><span>{workspace.name}<small>{workspace.root}</small></span>
        <small>{summaries.find(s => s.root === workspace.root)?.description || '尚无自动简介，后台检查后生成；缺少文档时使用名称和手填说明。'}</small>
        {summaries.find(s => s.root === workspace.root)?.generatedAt && <small>简介生成于 {new Date(summaries.find(s => s.root === workspace.root)!.generatedAt!).toLocaleString()}</small>}
        {summaries.find(s => s.root === workspace.root)?.error && <small>上次更新失败，保留已有简介，下次定时检查重试。</small>}
        <textarea aria-label={`${workspace.name} 的路由用途`} maxLength={4000} rows={3} disabled={busy} value={draft.descriptions[workspace.root] ?? ''} placeholder="例如：DNS 服务端代码、配置变更与故障排查；客户端位于另一工作区。" onChange={(event) => update({ descriptions: { ...draft.descriptions, [workspace.root]: event.target.value } })} />
      </label>)}
      {workspaces.length === 0 && <p>添加工作区后可在这里填写用途。</p>}
    </section>
    <div className="title-prompt-actions"><button type="button" disabled={busy} onClick={() => update({ model: DEFAULT_ROUTER_SETTINGS.model, effort: DEFAULT_ROUTER_SETTINGS.effort })}>恢复默认模型</button><button type="button" className="primary" disabled={busy} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</button></div>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </div>
}
