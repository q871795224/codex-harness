import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImageIcon, Maximize2, X } from 'lucide-react'
import { runtime } from '../../core/runtime/bridge'

export function imageSource(src: string): { kind: 'local' | 'remote'; value: string } | null {
  if (!src || /[\u0000-\u001f]/.test(src)) return null
  if (/^https?:\/\//i.test(src)) return { kind: 'remote', value: src }
  if (src.startsWith('//')) return { kind: 'remote', value: `https:${src}` }
  try {
    if (/^file:/i.test(src)) {
      const url = new URL(src)
      if (url.hostname && url.hostname !== 'localhost') return null
      return { kind: 'local', value: decodeURIComponent(url.pathname) }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null
    const path = decodeURIComponent(src)
    if (/[\u0000-\u001f]/.test(path)) return null
    return { kind: 'local', value: path }
  } catch {
    return null
  }
}

export function MarkdownImage({ src = '', alt = '', title, cwd }: { src?: string; alt?: string; title?: string; cwd?: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const previewRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const label = alt || '图片'

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | undefined
    setUrl(null)
    setLoaded(false)
    setError(null)
    setExpanded(false)
    const source = imageSource(src)
    if (!source) {
      setError('不支持此图片地址')
      return
    }
    if (source.kind === 'remote') setUrl(source.value)
    else {
      void runtime.readMarkdownImage(source.value, cwd).then((bytes) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(new Blob([bytes]))
        setUrl(objectUrl)
      }).catch((error) => {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error))
      })
    }
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src, cwd])

  useEffect(() => {
    if (!expanded) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        setExpanded(false)
      } else if (event.key === 'Tab') {
        event.preventDefault()
        closeRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      previousFocus?.focus()
    }
  }, [expanded])

  return <span className="mermaid-block markdown-image-block">
    <span className="mermaid-block-toolbar markdown-image-toolbar">
      <ImageIcon size={14} aria-hidden />
      <span title={title || label}>{label}</span>
      <button type="button" disabled={!loaded || Boolean(error)} aria-label={`放大图片：${label}`} onClick={() => setExpanded(true)}><Maximize2 size={13} />放大</button>
    </span>
    {error ? <span className="markdown-image-error" role="status">图片加载失败：{error}</span> : <>
      {!loaded && <span className="markdown-image-loading">图片加载中…</span>}
      {url && <button type="button" ref={previewRef} className="markdown-image-preview" disabled={!loaded} aria-label={`查看大图：${label}`} onClick={() => setExpanded(true)}>
        <img src={url} alt={alt} title={title} decoding="async" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => { setError('图片不存在、无法解码或当前无法访问'); setExpanded(false) }} />
      </button>}
    </>}
    {expanded && url && !error && createPortal(
      <div className="mermaid-modal-backdrop" role="presentation" onMouseDown={() => setExpanded(false)}>
        <section className="mermaid-modal markdown-image-modal" role="dialog" aria-modal="true" aria-label={`查看图片：${label}`} onMouseDown={(event) => event.stopPropagation()}>
          <button type="button" ref={closeRef} className="mermaid-modal-close" onClick={() => setExpanded(false)} aria-label="关闭图片"><X size={16} /></button>
          <div className="mermaid-modal-body"><img src={url} alt={label} referrerPolicy="no-referrer" /></div>
        </section>
      </div>,
      previewRef.current?.closest('.app-shell') ?? document.body,
    )}
  </span>
}
