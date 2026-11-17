import { MarkdownImage, imageSource } from './MarkdownImage'
import { createContext, useContext, isValidElement, useMemo, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MarkdownCodeBlock } from './MarkdownCodeBlock'
import { JsonBlock } from './JsonBlock'
import { MarkdownLink } from './MarkdownLink'
import { MermaidBlock } from './MermaidBlock'
import { remarkRepairCjkAutolink } from './remarkRepairCjkAutolink'
import { MarkdownTable } from './MarkdownTable'

export const MarkdownLocalFilesContext = createContext(true)

export function Markdown({ text, cwd, collapsibleJson = false }: { text: string; cwd?: string; collapsibleJson?: boolean }) {
  const localFiles = useContext(MarkdownLocalFilesContext)
  const components: Components = useMemo(() => ({
    table: ({ node: _node, ...props }) => <MarkdownTable {...props} />,
    img: ({ src, alt, title }) => !localFiles && imageSource(src ?? '')?.kind === 'local'
      ? <span>{alt || '图片'}（在云端查看）</span>
      : <MarkdownImage key={`${cwd ?? ''}:${src}`} src={src} alt={alt} title={title} cwd={cwd} />,
    pre: collapsibleJson ? ConversationPre : MarkdownPre,
    a: (props: ComponentPropsWithoutRef<'a'>) => <MarkdownLink {...props} cwd={localFiles ? cwd : undefined} />,
  }), [cwd, collapsibleJson, localFiles])
  return <ReactMarkdown remarkPlugins={[remarkGfm, remarkRepairCjkAutolink]} components={components} urlTransform={(url, key, node) => key === 'src' && node.tagName === 'img' && imageSource(url) ? url : defaultUrlTransform(url)}>{text}</ReactMarkdown>
}

function ConversationPre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const jsonCode = extractCode(children, 'json')
  if (jsonCode !== null) return <JsonBlock code={jsonCode} />
  return <MarkdownPre {...props}>{children}</MarkdownPre>
}

function MarkdownPre({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const mermaidCode = extractCode(children, 'mermaid')
  if (mermaidCode !== null) return <MermaidBlock code={mermaidCode} />
  return <MarkdownCodeBlock {...props}>{children}</MarkdownCodeBlock>
}

function extractCode(children: ReactNode, language: string): string | null {
  if (!isValidElement<{ className?: unknown; children?: ReactNode }>(children)) return null
  if (children.type !== 'code') return null
  const { className, children: codeChildren } = children.props
  if (typeof className !== 'string') return null
  if (!className.split(/\s+/).includes(`language-${language}`)) return null
  return flattenText(codeChildren).replace(/\n$/, '')
}

function flattenText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  return ''
}
