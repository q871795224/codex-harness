import { useEffect, useState } from 'react'
import { runtime } from '../../core/runtime/bridge'

export function CompassSettings() {
  const [supported, setSupported] = useState(true)
  const [savedModel, setSavedModel] = useState<string | null>(null)
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(true)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    void runtime.compassStatus().then((value) => {
      if (disposed) return
      setSupported(value.supported)
      setSavedModel(value.model)
      setModel(value.model ?? '')
    }).catch((error) => { if (!disposed) setError(String(error)) })
      .finally(() => { if (!disposed) setBusy(false) })
    return () => { disposed = true }
  }, [])

  const run = async (action: () => Promise<void>, message: string) => {
    setBusy(true)
    setStatus('')
    setError('')
    try {
      await action()
      setStatus(message)
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }

  const dirty = model.trim() !== (savedModel ?? '') || Boolean(apiKey.trim())
  return <div className="settings-section codex-settings">
    <section className="codex-setting-card">
      <div className="settings-section-title">
        <div><h3>公司 Compass 网关</h3><p>连通性测试向所选模型发送一条固定测试消息。配置保存在 macOS 钥匙串。</p></div>
      </div>
      {supported ? <form onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          const value = await runtime.saveCompass(model, apiKey.trim() || null)
          setSavedModel(value.model)
          setModel(value.model ?? '')
          setApiKey('')
        }, '已保存 Compass 配置')
      }}>
        <div className="settings-row-list">
          <label className="settings-row"><span>模型名</span>
            <input value={model} disabled={busy} onChange={(event) => { setModel(event.target.value); setStatus('') }} />
          </label>
          <label className="settings-row"><span>API Key</span>
            <input type="password" autoComplete="off" value={apiKey} disabled={busy}
              placeholder={savedModel ? '已保存，留空沿用' : '输入 Compass API Key'}
              onChange={(event) => { setApiKey(event.target.value); setStatus('') }} />
          </label>
        </div>
        <div className="title-prompt-actions">
          <button type="submit" className="primary" disabled={busy || !dirty || !model.trim() || (!savedModel && !apiKey.trim())}>保存配置</button>
          <button type="button" disabled={busy || dirty || !savedModel}
            onClick={() => void run(runtime.probeCompass, 'Compass 连通性测试通过')}>测试连接</button>
          <button type="button" disabled={busy || !savedModel} onClick={() => void run(async () => {
            await runtime.removeCompass()
            setSavedModel(null)
            setModel('')
            setApiKey('')
          }, '已清除 Compass 配置')}>清除配置</button>
        </div>
      </form> : <p>Compass 配置目前支持 macOS。</p>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  </div>
}
