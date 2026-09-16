import { useRef, useState, type ComponentPropsWithoutRef } from 'react'
import { Check, Copy } from 'lucide-react'
import { writeClipboard } from './clipboard'

export function MarkdownCodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    const text = preRef.current?.textContent ?? ''
    if (!text) return
    try {
      await writeClipboard(text.replace(/\n$/, ''))
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 1_500)
    } catch {
      setCopyState('failed')
      window.setTimeout(() => setCopyState('idle'), 1_500)
    }
  }

  return (
    <div className="markdown-code-block">
      <pre ref={preRef} {...props}>{children}</pre>
      <button type="button" className={copyState} onClick={() => void copy()} aria-label="复制代码" title={copyState === 'failed' ? '复制失败' : '复制代码'}>
        {copyState === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '失败' : '复制'}
      </button>
    </div>
  )
}
