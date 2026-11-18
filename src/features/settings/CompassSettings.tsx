import { useEffect, useState } from 'react'
import { runtime } from '../../core/runtime/bridge'

export function CompassSettings() {
  const [savedModel, setSavedModel] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(true)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    void Promise.allSettled([runtime.getAppState('compass.model'), runtime.compassHasKey()]).then(([model, key]) => {
      if (disposed) return
      if (model.status === 'fulfilled') {
        setSavedModel(model.value ?? '')
        setModel(model.value ?? '')
      }
      if (key.status === 'fulfilled') setHasKey(key.value)
      if (model.status === 'rejected') setError(String(model.reason))
      else if (key.status === 'rejected') setError(String(key.reason))
      setBusy(false)
    })
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

  const dirty = model.trim() !== savedModel
  return <div className="settings-section codex-settings">
    <section className="codex-setting-card">
      <div className="settings-section-title">
        <div><h3>公司 Compass 网关</h3>
          <p>Base URL <code>https://compass.llm.shopee.io/compass-api/v1</code></p>
        </div>
      </div>
      <form onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          await runtime.saveCompassKey(apiKey)
          setApiKey('')
          setHasKey(true)
        }, '已保存 Compass API Key')
      }}>
        <div className="settings-row-list">
          <label className="settings-row"><span>API Key</span>
            <input type="password" autoComplete="off" value={apiKey} disabled={busy}
              placeholder={hasKey ? '已保存，输入新密钥可替换' : '输入 Compass API Key'}
              onChange={(event) => { setApiKey(event.target.value); setStatus('') }} />
          </label>
        </div>
        <div className="title-prompt-actions">
          <button type="submit" disabled={busy || !apiKey.trim()}>保存密钥</button>
        </div>
      </form>
      <p className="settings-shortcut-note">密钥保存在 <code>~/.codex-harness/secrets</code>，测试连接只发送一条固定测试消息。</p>
      <form onSubmit={(event) => {
        event.preventDefault()
        void run(async () => {
          const saved = await runtime.saveCompassModel(model)
          setSavedModel(saved)
          setModel(saved)
        }, '已保存 Compass 模型')
      }}>
        <div className="settings-row-list">
          <label className="settings-row"><span>模型名</span>
            <input value={model} disabled={busy} onChange={(event) => { setModel(event.target.value); setStatus('') }} />
          </label>
        </div>
        <div className="title-prompt-actions">
          <button type="submit" className="primary" disabled={busy || !dirty || !model.trim()}>保存模型</button>
          <button type="button" disabled={busy || dirty || !savedModel || Boolean(apiKey.trim())}
            onClick={() => void run(async () => {
              setHasKey(await runtime.compassHasKey())
              await runtime.probeCompass()
            }, 'Compass 连通性测试通过')}>测试连接</button>
        </div>
      </form>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  </div>
}
