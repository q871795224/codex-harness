import { useEffect, useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import { DEFAULT_HISTORY_SETTINGS, loadHistorySettings, saveHistorySettings, type HistorySettings as Settings } from '../../core/runtime/historySettings'

export function HistorySettings() {
  const [draft, setDraft] = useState<Settings>({ ...DEFAULT_HISTORY_SETTINGS })
  const [busy, setBusy] = useState(true)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    void loadHistorySettings().then((value) => { if (!disposed) setDraft(value) })
      .catch((error) => { if (!disposed) setError(String(error)) })
      .finally(() => { if (!disposed) setBusy(false) })
    return () => { disposed = true }
  }, [])
  const update = (patch: Partial<Settings>) => { setDraft((value) => ({ ...value, ...patch })); setStatus('有未保存的修改'); setError(null) }
  const save = async () => {
    setBusy(true); setError(null); setStatus('')
    try { setDraft(await saveHistorySettings(draft)); setStatus('已保存。加载方式在下次打开会话时生效；修改响应上限后请重启 Harness。') }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div className="settings-section codex-settings">
    <section className="codex-setting-card">
      <div className="settings-section-title"><MessageSquareText size={17} /><div><h3>Codex 会话历史</h3>
        <p>按需加载先显示对话正文，展开执行过程时再分批读取工具记录，点击图片后显示预览。一次性加载会同时读取当前历史页的正文、工具记录和图片。</p>
      </div></div>
      <div className="settings-row-list">
        <label className="settings-row"><span>历史加载方式</span>
          <select aria-label="历史加载方式" value={draft.loading} disabled={busy} onChange={(event) => update({ loading: event.target.value as Settings['loading'] })}>
            <option value="on-demand">按需加载</option><option value="eager">一次性加载</option>
          </select>
        </label>
        <label className="settings-row"><span>响应上限（MiB）</span>
          <input aria-label="响应上限（MiB）" type="number" min={16} max={1024} step={1} value={Number.isNaN(draft.maxResponseMiB) ? '' : draft.maxResponseMiB} disabled={busy} onChange={(event) => update({ maxResponseMiB: event.target.valueAsNumber })} />
        </label>
      </div>
      <p className="settings-shortcut-note">默认 256 MiB，同时限制单帧和整条响应。较大的响应会占用更多内存；超过上限时停止自动恢复。修改上限后重启 Harness 生效。</p>
      <div className="title-prompt-actions">
        <button type="button" disabled={busy} onClick={() => update(DEFAULT_HISTORY_SETTINGS)}>恢复默认</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>保存设置</button>
      </div>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  </div>
}
