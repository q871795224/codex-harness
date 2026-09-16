import { useEffect, useState } from 'react'
import { Check, Copy, Maximize2, X } from 'lucide-react'
import { writeClipboard } from './clipboard'
import { useAppTheme } from './useAppTheme'

type RenderState =
  | { status: 'loading' }
  | { status: 'ok'; svg: string }
  | { status: 'error'; message: string }

let mermaidRenderSeq = 0

export function MermaidBlock({ code }: { code: string }) {
  const theme = useAppTheme()
  const [view, setView] = useState<'chart' | 'code'>('chart')
  const [render, setRender] = useState<RenderState>({ status: 'loading' })
  const [expanded, setExpanded] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${++mermaidRenderSeq}`
    setRender({ status: 'loading' })
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
        })
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) setRender({ status: 'ok', svg })
      } catch (error) {
        document.getElementById(`d${id}`)?.remove()
        if (!cancelled) {
          setRender({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          setView('code')
        }
      }
    })()
    return () => { cancelled = true }
  }, [code, theme])

  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [expanded])

  const copy = async () => {
    try {
      await writeClipboard(code)
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1_500)
    } catch {
      setCopyState('failed')
      window.setTimeout(() => setCopyState('idle'), 1_500)
    }
  }

  return (
    <div className="mermaid-block">
      <header className="mermaid-block-toolbar">
        <span className="mermaid-view-toggle">
          <button type="button" className={view === 'chart' ? 'selected' : ''} onClick={() => setView('chart')}>图表</button>
          <button type="button" className={view === 'code' ? 'selected' : ''} onClick={() => setView('code')}>代码</button>
        </span>
        <button type="button" className={copyState} onClick={() => void copy()} aria-label="复制代码" title={copyState === 'failed' ? '复制失败' : '复制代码'}>
          {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
          {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '失败' : '复制'}
        </button>
        <button type="button" aria-label="放大图表" title="放大图表" disabled={render.status !== 'ok'} onClick={() => setExpanded(true)}>
          <Maximize2 size={13} />
        </button>
      </header>
      {render.status === 'error' && <p className="mermaid-block-error" role="alert">图表渲染失败：{render.message}</p>}
      {view === 'code' ? (
        <pre className="mermaid-block-code"><code>{code}</code></pre>
      ) : render.status === 'ok' ? (
        <div className="mermaid-block-diagram" dangerouslySetInnerHTML={{ __html: render.svg }} />
      ) : render.status === 'loading' ? (
        <p className="mermaid-block-loading">渲染中…</p>
      ) : null}
      {expanded && render.status === 'ok' && (
        <div className="mermaid-modal-backdrop" role="presentation" onMouseDown={() => setExpanded(false)}>
          <section className="mermaid-modal" role="dialog" aria-modal="true" aria-label="查看图表" onMouseDown={(event) => event.stopPropagation()}>
            <button type="button" className="mermaid-modal-close" onClick={() => setExpanded(false)} aria-label="关闭"><X size={16} /></button>
            <div className="mermaid-modal-body" dangerouslySetInnerHTML={{ __html: render.svg }} />
          </section>
        </div>
      )}
    </div>
  )
}
