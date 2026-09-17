import { isValidElement, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'
import { MarkdownLink } from './MarkdownLink'
import { MermaidBlock } from './MermaidBlock'
import { remarkRepairCjkAutolink } from './remarkRepairCjkAutolink'

export function Markdown({ text, cwd }: { text: string; cwd?: string }) {
  const components: Components = {
    pre: MarkdownPre,
    ...(cwd === undefined ? {} : { a: (props: ComponentPropsWithoutRef<'a'>) => <MarkdownLink {...props} cwd={cwd} /> }),
  }
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkRepairCjkAutolink]} components={components}>{text}</ReactMarkdown>
}

function MarkdownPre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const mermaidCode = extractMermaidCode(children)
  if (mermaidCode !== null) return <MermaidBlock code={mermaidCode} />
  return <MarkdownCodeBlock {...props}>{children}</MarkdownCodeBlock>
}

function extractMermaidCode(children: ReactNode): string | null {
  if (!isValidElement<{ className?: unknown; children?: ReactNode }>(children)) return null
  if (children.type !== 'code') return null
  const { className, children: codeChildren } = children.props
  if (typeof className !== 'string') return null
  if (!className.split(/\s+/).includes('language-mermaid')) return null
  return flattenText(codeChildren).replace(/\n$/, '')
}

function flattenText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  return ''
}
