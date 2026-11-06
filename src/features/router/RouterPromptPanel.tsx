import { useEffect, useRef, useState } from 'react'
import { textInput, type Workspace } from '../../core/domain/codex'
import { loadRouterSettings } from '../../core/workspace-router/settings'
import { prepareRouterPrompt, routingCandidates } from '../../core/workspace-router/service'

export function RouterPromptPanel({ workspaces, settingsVersion }: { workspaces: Workspace[]; settingsVersion: number }) {
  const [input, setInput] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  useEffect(() => { sequence.current++; setPrompt(''); setBusy(false); return () => { sequence.current++ } }, [settingsVersion])
  const prepare = async () => {
    const request = ++sequence.current
    setBusy(true); setError(''); setPrompt('')
    try {
      const settings = await loadRouterSettings()
      const candidates = await routingCandidates(workspaces, settings)
      const prepared = await prepareRouterPrompt([textInput(input || '{{用户输入}}')], candidates, settings)
      if (request === sequence.current) setPrompt([`developerInstructions\n${prepared.developerInstructions}`, ...prepared.input.map((item, index) => `input[${index}]\n${item.type === 'text' ? item.text : JSON.stringify(item)}`), `outputSchema\n${JSON.stringify(prepared.outputSchema, null, 2)}`].join('\n\n'))
    } catch (e) { if (request === sequence.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (request === sequence.current) setBusy(false) }
  }
  return <div className="router-prompt-panel">
    <label>用户输入<textarea aria-label="Prompt 预览用户输入" rows={3} disabled={busy} value={input} onChange={event => { setInput(event.target.value); setPrompt(''); setError('') }} placeholder="{{用户输入}}" /></label>
    <div className="router-panel-actions"><button type="button" disabled={busy || !workspaces.length} onClick={() => void prepare()}>{busy ? '生成中…' : '按已保存设置生成'}</button></div>
    {error && <p role="alert">{error}</p>}
    {prompt && <pre aria-label="最终 Prompt">{prompt}</pre>}
  </div>
}
