import type { ComponentPropsWithoutRef } from 'react'
import { diagnosticErrorCode, runtime } from '../../core/runtime/bridge'

function recordLinkOpenDiagnostic(kind: 'external' | 'local', href: string, error: unknown): void {
  void runtime.recordClientDiagnostic({
    level: 'error',
    area: 'frontend',
    event: 'markdown-link.open-failed',
    context: { kind, href },
    errorCode: diagnosticErrorCode(error),
    reason: error instanceof Error ? error.message : String(error),
  }).catch(() => undefined)
}

export function MarkdownLink({ href, children, cwd, ...props }: ComponentPropsWithoutRef<'a'> & { cwd: string }) {
  const local = href ? parseLocalFileReference(href) : null
  if (local) return (
    <button
      type="button"
      className="local-link"
      title={`在 GoLand 中打开 ${local.path}${local.line ? `:${local.line}` : ''}`}
      onClick={() => void runtime.openWorkspacePath('goland', cwd, local.path, local.line).catch((error) => recordLinkOpenDiagnostic('local', href ?? local.path, error))}
    >
      {children}
    </button>
  )
  if (!href || !isOpenableExternalUrl(href)) return <span className="local-link-label" title={href}>{children || href}</span>
  const showDestination = markdownLinkLabel(children) !== decodeHrefForCompare(href)
  return (
    <a
      href={href}
      {...props}
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault()
        void runtime.openExternalUrl(href).catch((error) => recordLinkOpenDiagnostic('external', href, error))
      }}
    >
      {children}{showDestination && <span className="link-destination"> ({href})</span>}
    </a>
  )
}

export interface LocalFileReference {
  path: string
  line?: number
}

export function parseLocalFileReference(value: string): LocalFileReference | null {
  let decoded: string
  try {
    decoded = decodeURI(value)
  } catch {
    return null
  }
  if (decoded.startsWith('file://')) {
    try {
      const url = new URL(decoded)
      decoded = decodeURIComponent(url.pathname) + url.hash
    } catch {
      return null
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null
  const hashLine = decoded.match(/^(.*)#L(\d+)$/)
  if (hashLine) return { path: hashLine[1], line: positiveLine(hashLine[2]) }
  const suffixLine = decoded.match(/^(.*?):(\d+)(?::\d+)?$/)
  if (suffixLine) return { path: suffixLine[1], line: positiveLine(suffixLine[2]) }
  if (decoded.startsWith('/') || decoded.startsWith('./') || decoded.startsWith('../') || /^[\w@.-]+\//.test(decoded)) {
    return { path: decoded }
  }
  if (/^(?=.*\w)[\w@.-]+$/.test(decoded)) {
    return { path: decoded }
  }
  return null
}

function positiveLine(value: string): number | undefined {
  const line = Number(value)
  return Number.isSafeInteger(line) && line > 0 ? line : undefined
}

function markdownLinkLabel(children: ComponentPropsWithoutRef<'a'>['children']): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(markdownLinkLabel).join('')
  return ''
}

// hast 会把 href 里的非 ASCII 字符 percent-encode（如全角括号、中文路径），
// 与显示文本比较前先解码，避免 autolink 被误判为「label ≠ 目标」而多显示一段目的地提示。
function decodeHrefForCompare(href: string): string {
  try {
    return decodeURI(href)
  } catch {
    return href
  }
}

const OPENABLE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

export function isOpenableExternalUrl(value: string): boolean {
  try {
    return OPENABLE_EXTERNAL_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}
