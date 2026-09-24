import { useState } from 'react'
import { ChevronDown, ChevronRight, Globe, ImageIcon } from 'lucide-react'
import type { ThreadItem } from '../../core/domain/codex'
import { MarkdownImage } from '../markdown/MarkdownImage'
import { ToolCallDetails } from './ItemDetails'
import './BrowsingActivity.css'

const text = (value: unknown): string => typeof value === 'string' ? value : ''

export function webActivity(item: ThreadItem): { label: string; details: string[] } {
  const action = item.action && typeof item.action === 'object' && !Array.isArray(item.action)
    ? item.action as Record<string, unknown> : {}
  if (action.type === 'openPage') return { label: '打开网页', details: [text(action.url)].filter(Boolean) }
  if (action.type === 'findInPage') return { label: '页内查找', details: [text(action.pattern), text(action.url)].filter(Boolean) }
  const queries = Array.isArray(action.queries) ? action.queries.map(text).filter(Boolean) : []
  const details = [...new Set([text(action.query), ...queries].filter(Boolean))]
  if (!details.length && text(item.query)) details.push(text(item.query))
  return { label: action.type === 'search' || details.length ? '搜索网页' : '浏览网页', details }
}

export function WebSearchItem({ item }: { item: ThreadItem }) {
  const [open, setOpen] = useState(false)
  const { label, details } = webActivity(item)
  const status = item.status === 'inProgress' ? '进行中' : item.status === 'completed' ? '完成' : item.status === 'failed' ? '失败' : item.status ?? ''
  return <article className="tool-card browsing-activity">
    <button type="button" className="tool-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Globe size={14} />
      <strong>{label}</strong>
      <code title={details.join('\n')}>{details.join(' · ')}</code>
      <small>{status}</small>
      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
    {open && <div className="tool-card-body">
      <ul className="browsing-details">{details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
      <ToolCallDetails item={item} />
    </div>}
  </article>
}

export function ImageViewItem({ item, cwd }: { item: ThreadItem; cwd: string }) {
  const path = text(item.path)
  const name = path.split('/').pop() || path
  return <article className="tool-card browsing-activity image-view-activity">
    <div className="tool-card-head static-head"><ImageIcon size={14} /><strong>查看图片</strong><code title={path}>{name || '未提供路径'}</code></div>
    {path && <div className="tool-card-body">
      <code className="image-view-path">{path}</code>
      <MarkdownImage src={encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')} alt={name} title={path} cwd={cwd} />
    </div>}
  </article>
}
