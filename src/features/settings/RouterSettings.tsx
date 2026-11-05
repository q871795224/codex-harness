import { useEffect, useState } from 'react'
import { GitBranch } from 'lucide-react'
import type { CodexModel, Workspace } from '../../core/domain/codex'
import { DEFAULT_ROUTER_SETTINGS, loadRouterSettings, saveRouterSettings, type RouterSettings as Settings } from '../../core/workspace-router/settings'

export function RouterSettings({ models, workspaces }: { models: CodexModel[]; workspaces: Workspace[] }) {
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
      <div className="settings-section-title"><GitBranch size={17} /><div><h3>工作区 Router</h3><p>新 Codex 会话未手动选择工作区时，发送后自动选择并开始工作。反馈只用于记录，不会切换或中断执行。</p></div></div>
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
      </div>
    </section>
    <section className="codex-setting-card">
      <div className="settings-section-title"><div><h3>工作区用途</h3><p>说明适合在这里处理的任务及关联项目。Router 使用名称、路径和用途选择工作区。</p></div></div>
      {workspaces.map((workspace) => <label className="title-prompt-field router-description" key={workspace.root}><span>{workspace.name}<small>{workspace.root}</small></span>
        <textarea aria-label={`${workspace.name} 的路由用途`} maxLength={4000} rows={3} disabled={busy} value={draft.descriptions[workspace.root] ?? ''} placeholder="例如：DNS 服务端代码、配置变更与故障排查；客户端位于另一工作区。" onChange={(event) => update({ descriptions: { ...draft.descriptions, [workspace.root]: event.target.value } })} />
      </label>)}
      {workspaces.length === 0 && <p>添加工作区后可在这里填写用途。</p>}
    </section>
    <div className="title-prompt-actions"><button type="button" disabled={busy} onClick={() => update({ model: DEFAULT_ROUTER_SETTINGS.model, effort: DEFAULT_ROUTER_SETTINGS.effort })}>恢复默认模型</button><button type="button" className="primary" disabled={busy} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</button></div>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </div>
}
