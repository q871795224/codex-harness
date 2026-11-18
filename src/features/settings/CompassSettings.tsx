import { useEffect, useState } from 'react'
import { runtime } from '../../core/runtime/bridge'

export function CompassSettings() {
  const [savedModel, setSavedModel] = useState('')
  const [model, setModel] = useState('')
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
          <p>在 <code>~/.codex-harness/secrets</code> 中设置 <code>COMPASS_EXTERNAL_API_KEY</code>。测试连接会重新读取文件并发送一条固定测试消息。</p>
        </div>
      </div>
      {hasKey !== null && <p className="settings-shortcut-note">{hasKey ? '已检测到 Compass API Key' : '尚未配置 Compass API Key'}</p>}
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
          <button type="button" disabled={busy || dirty || !savedModel}
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
