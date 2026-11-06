import { useEffect, useRef, useState } from 'react'
import { textInput, type Workspace } from '../../core/domain/codex'
import { loadRouterSettings } from '../../core/workspace-router/settings'
import { prepareRouterPreview, routingCandidates } from '../../core/workspace-router/service'

export function RouterPromptPanel({ workspaces, settingsVersion, active = true, cacheVersion = '' }: {
  workspaces: Workspace[]; settingsVersion: number; active?: boolean; cacheVersion?: string
}) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const latest = useRef(workspaces); latest.current = workspaces
  const workspaceKey = JSON.stringify(workspaces.map(w => [w.root, w.checkoutRoot, w.name]))
  useEffect(() => {
    if (!active) return
    let disposed = false
    setPrompt(''); setError('')
    if (!latest.current.length) { setBusy(false); return }
    setBusy(true)
    void (async () => {
      try {
        const settings = await loadRouterSettings()
        const candidates = await routingCandidates(latest.current, settings)
        const prepared = await prepareRouterPreview([textInput('{{用户输入}}')], candidates, settings)
        if (!disposed) setPrompt(prepared)
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)) }
      finally { if (!disposed) setBusy(false) }
    })()
    return () => { disposed = true }
  }, [active, settingsVersion, workspaceKey, cacheVersion])
  return <div className="router-prompt-panel">
    {busy && <p role="status">加载中…</p>}
    {!workspaces.length && <p>暂无工作区</p>}
    {error && <p role="alert">{error}</p>}
    {prompt && <pre aria-label="最终 Prompt">{prompt}</pre>}
  </div>
}
