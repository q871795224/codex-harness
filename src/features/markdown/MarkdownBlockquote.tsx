import { useEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { Check, Copy } from 'lucide-react'
import { toText } from 'hast-util-to-text'
import type { ExtraProps } from 'react-markdown'
import { writeClipboard } from './clipboard'

export function MarkdownBlockquote({ node, children, ...props }: ComponentPropsWithoutRef<'blockquote'> & ExtraProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const resetTimer = useRef<ReturnType<typeof window.setTimeout>>()

  useEffect(() => () => window.clearTimeout(resetTimer.current), [])

  const copy = async () => {
    if (!node) return
    try {
      await writeClipboard(toText(node).replace(/\n$/, ''))
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
    window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(() => setCopyState('idle'), 1_500)
  }

  return (
    <blockquote className="markdown-blockquote" {...props}>
      {children}
      <button type="button" className={copyState} onClick={() => void copy()} aria-label="复制引用" title={copyState === 'failed' ? '复制失败' : '复制引用'}>
        {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '失败' : '复制'}
      </button>
    </blockquote>
  )
}
