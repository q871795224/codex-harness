import { useEffect, useRef, useState } from 'react'
import { parseReplacement } from '../../core/input-correction/engine'
import { loadCorrectionSettings, saveCorrectionSettings, useCorrectionSettings } from '../../core/input-correction/settings'

export function InputCorrectionSettings() {
  const settings = useCorrectionSettings()
  const [dictionary, setDictionary] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; void loadCorrectionSettings().catch((e) => setError(String(e))).finally(() => { if (mounted.current) setLoading(false) }); return () => { mounted.current = false } }, [])
  const savedDictionary = settings.rules.map((rule) => `${rule.from} → ${rule.to}`).join('\n')
  useEffect(() => { setDictionary(savedDictionary) }, [savedDictionary])
  const save = async () => {
    setBusy(true); setError('')
    try {
      const rules = dictionary.split('\n').filter((line) => line.trim()).map(parseReplacement)
      await saveCorrectionSettings({ ...settings, rules })
      setStatus('词库已保存')
    } catch (e) { setError(String(e)) }
    finally { setBusy(false) }
  }
  const toggle = async (patch: { enabled?: boolean; quotes?: boolean }) => {
    setError('')
    try { await saveCorrectionSettings({ ...settings, ...patch }) } catch (e) { setError(String(e)) }
  }
  return <div className="settings-section codex-settings"><section className="codex-setting-card">
    <div className="settings-section-title"><div><h3>输入自动纠正</h3><p>日常输入只使用本地词库。暂停输入后替换关键词，并可一次撤回全部纠正。</p></div></div>
    <div className="settings-row-list">
      <label className="settings-row"><span>自动替换关键词</span><input type="checkbox" checked={settings.enabled} disabled={busy || loading} onChange={(event) => void toggle({ enabled: event.target.checked })} /></label>
      <label className="settings-row"><span>中文正文引号配对<small>修正双引号的方向与中文样式，代码和路径保持原样。</small></span><input type="checkbox" checked={settings.quotes} disabled={busy || loading} onChange={(event) => void toggle({ quotes: event.target.checked })} /></label>
    </div>
    <label className="title-prompt-field"><span>替换词库（每行：原词 → 替换词）</span><textarea aria-label="替换词库" value={dictionary} disabled={busy || loading} onChange={(event) => setDictionary(event.target.value)} spellCheck={false} placeholder="绘画 → 会话" /></label>
    <p>词库存储在本机，不随 Git 同步。每行一条规则；添加、修改或删除对应行后保存。</p>
    <div className="title-prompt-actions">
      <button type="button" className="primary" disabled={busy || loading} onClick={() => void save()}>保存词库</button>
    </div>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </section></div>
}
