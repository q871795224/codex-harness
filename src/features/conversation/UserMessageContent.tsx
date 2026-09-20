import { Fragment, useEffect, useState, type ReactNode } from 'react'
import type { MessageReference, ThreadItem } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { loadMessageReferences } from './messageReferences'

export function UserMessageContent({ item, text, cwd, raw = false }: { item: ThreadItem; text: string; cwd: string | null; raw?: boolean }) {
  const [resolved, setResolved] = useState<{ clientId: string; text: string; references: MessageReference[] } | null>(null)
  const clientId = typeof item.clientId === 'string' ? item.clientId : null
  useEffect(() => {
    if (!clientId) return
    let disposed = false
    void loadMessageReferences(clientId, text).then((references) => {
      if (!disposed) setResolved({ clientId, text, references })
    }).catch(() => { if (!disposed) setResolved(null) })
    return () => { disposed = true }
  }, [clientId, text])
  const references = !raw && resolved?.clientId === clientId && resolved?.text === text ? resolved.references : []
  const parts: ReactNode[] = []
  let cursor = 0
  for (const reference of references) {
    parts.push(text.slice(cursor, reference.start))
    const content = text.slice(reference.start, reference.end)
    parts.push(reference.kind === 'paste'
      ? <details className="message-paste" key={reference.start}><summary className="reference-chip" title={`${Array.from(content).length} 字符，点击展开`}>[Pasted Content {Array.from(content).length} chars]</summary><div>{content}</div></details>
      : <ReferenceLink key={reference.start} path={reference.path!} cwd={cwd} label={reference.kind === 'skill' ? content : `[${fileName(reference.path!)}]`} />)
    cursor = reference.end
  }
  parts.push(text.slice(cursor))
  const imageReferences = references.filter((reference) => reference.kind === 'image')
  let imageIndex = 0
  const attachments = (item.content ?? []).filter((content) => content.type === 'localImage' || content.type === 'image' || content.type === 'mention')
  return <>
    {text && (raw ? <pre className="raw-response">{text}</pre> : <div>{parts}</div>)}
    {attachments.length > 0 && <div className="user-attachments">{attachments.map((attachment, index) => {
      const path = attachment.type === 'image' ? attachment.url : attachment.path
      if (attachment.type === 'image' || attachment.type === 'localImage') {
        const reference = imageReferences[imageIndex++]
        if (reference && (attachment.type === 'image' || reference.path === path)) return null
      }
      return <Fragment key={`${path}:${index}`}>
        {attachment.type === 'image'
          ? <span className="reference-chip" title="图片">[图片]</span>
          : <ReferenceLink path={path} cwd={cwd} label={`[${attachment.type === 'mention' ? attachment.name : fileName(path)}]`} />}
      </Fragment>
    })}</div>}
  </>
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function ReferenceLink({ path, cwd, label }: { path: string; cwd: string | null; label: string }) {
  const [error, setError] = useState<string | null>(null)
  return <>
    <button type="button" className="reference-chip" title={path} onClick={() => {
      setError(null)
      void runtime.openWorkspacePath('goland', cwd ?? '/', path).catch((reason) => setError(String(reason)))
    }}>{label}</button>
    {error && <span role="alert" className="reference-open-error">无法打开文件：{error}</span>}
  </>
}
