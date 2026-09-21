import { Brain } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CodexModel } from '../../core/domain/codex'
import { DEFAULT_MEMORY_SETTINGS, loadMemorySettings, saveMemorySettings, type MemorySettings as Settings } from '../../core/memory/settings'

export function MemorySettings({ models }: { models: CodexModel[] }) {
  const [draft, setDraft] = useState<Settings>({ ...DEFAULT_MEMORY_SETTINGS })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  useEffect(() => {
    let disposed = false
    void loadMemorySettings().then((settings) => { if (!disposed) setDraft(settings) })
      .catch((next) => { if (!disposed) setError(String(next)) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [])
  const update = (patch: Partial<Settings>) => { setDraft((current) => ({ ...current, ...patch })); setStatus('有未保存的修改'); setError(null) }
  const selected = models.find((model) => model.model === draft.model)
  const efforts = selected?.supportedReasoningEfforts.map((item) => item.reasoningEffort) ?? ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const save = async () => {
    setSaving(true); setError(null); setStatus('')
    try { setDraft(await saveMemorySettings(draft)); setStatus('已保存，下次提炼生效') }
    catch (next) { setError(next instanceof Error ? next.message : String(next)) }
    finally { setSaving(false) }
  }
  const busy = loading || saving
  return <div className="settings-section codex-settings">
    <section className="codex-setting-card">
      <div className="settings-section-title"><Brain size={17} /><div><h3>记忆提炼</h3><p>控制“保存到记忆”使用的临时 Agent。修改在保存后对下一次提炼生效，已运行的任务沿用启动时设置。</p></div></div>
      <div className="settings-row-list">
        <label className="settings-row"><span>模型</span><select value={draft.model} disabled={busy} onChange={(event) => {
          const model = models.find((item) => item.model === event.target.value)
          update({ model: event.target.value, effort: !model || model.supportedReasoningEfforts.some((item) => item.reasoningEffort === draft.effort) ? draft.effort : model.defaultReasoningEffort ?? '' })
        }}>
          <option value="">跟随工作区默认模型</option>
          {draft.model && !selected && <option value={draft.model}>{draft.model}（当前配置）</option>}
          {models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
        </select></label>
        <label className="settings-row"><span>推理强度</span><select value={draft.effort} disabled={busy} onChange={(event) => update({ effort: event.target.value })}>
          <option value="">模型默认</option>
          {draft.effort && !efforts.includes(draft.effort) && <option value={draft.effort}>{draft.effort}（当前配置）</option>}
          {efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
        </select></label>
        <label className="settings-row"><span>上下文轮数<small>取最近 N 轮；0 表示全部。先选轮次，再按预算截断。</small></span><input type="number" min={0} max={10000} step={1} aria-label="上下文轮数" value={Number.isNaN(draft.maxTurns) ? '' : draft.maxTurns} disabled={busy} onChange={(event) => update({ maxTurns: event.target.valueAsNumber })} /></label>
        <label className="settings-row"><span>上下文预算（%）<small>占有效上下文窗口的比例；超限保留首尾。</small></span><input type="number" min={1} max={100} step={1} aria-label="上下文预算（%）" value={Number.isNaN(draft.budgetPercent) ? '' : draft.budgetPercent} disabled={busy} onChange={(event) => update({ budgetPercent: event.target.valueAsNumber })} /></label>
        <label className="settings-row"><span>上下文窗口（token）<small>0 跟随工作区配置，未配置时用 150,000；切换模型时可指定其窗口大小。</small></span><input type="number" min={0} max={10000000} step={1} aria-label="上下文窗口（token）" value={Number.isNaN(draft.contextWindowTokens) ? '' : draft.contextWindowTokens} disabled={busy} onChange={(event) => update({ contextWindowTokens: event.target.valueAsNumber })} /></label>
      </div>
      <p className="settings-shortcut-note">预算按 UTF-8 字节 / 4 估算，并预留提示词和输出格式的空间。默认读取全部轮次，使用有效窗口的 70%。</p>
      <label className="title-prompt-field"><span>提炼提示词</span><textarea aria-label="提炼提示词" value={draft.prompt} disabled={busy} onChange={(event) => update({ prompt: event.target.value })} spellCheck={false} /></label>
      <div className="title-prompt-actions">
        <button type="button" disabled={busy} onClick={() => { setDraft({ ...DEFAULT_MEMORY_SETTINGS }); setError(null); setStatus('已填入默认值，点击保存设置后生效') }}>恢复默认</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{saving ? '保存中…' : '保存设置'}</button>
      </div>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  </div>
}
