import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, Send, Square } from 'lucide-react'
import type { ThreadTokenUsage } from '../../core/domain/codex'

interface ComposerProps {
  disabled: boolean
  working: boolean
  foreignActive: boolean
  busy: boolean
  contextUsage: ThreadTokenUsage | null
  onSend: (text: string, mode: 'interject' | 'queue') => Promise<void> | void
  onStop: () => Promise<void> | void
}

export function Composer({ disabled, working, foreignActive, busy, contextUsage, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'interject' | 'queue'>('interject')
  const [modeOpen, setModeOpen] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [disabled])

  useLayoutEffect(() => {
    const textarea = ref.current
    if (!textarea) return
    // Five 24px lines, including the editor's padding, retains a compact composer.
    const maximumHeight = 124
    textarea.style.height = '0px'
    const nextHeight = Math.min(textarea.scrollHeight, maximumHeight)
    textarea.style.height = `${Math.max(28, nextHeight)}px`
    textarea.style.overflowY = textarea.scrollHeight > maximumHeight ? 'auto' : 'hidden'
  }, [text])

  const submit = async () => {
    const message = text.trim()
    if (!message || disabled || busy) return
    await onSend(message, mode)
    setText('')
    // Queue is deliberate and one-shot. The composer returns to Codex CLI's default steer path.
    setMode('interject')
  }

  return (
    <div className="composer-zone">
      {foreignActive && <div className="foreign-active-note">此会话由其他 Codex 客户端运行，当前只读。</div>}
      <div className={`composer-card ${disabled ? 'disabled' : ''}`} data-composer-card>
        <textarea
          ref={ref}
          value={text}
          disabled={disabled || busy}
          placeholder={foreignActive ? '等待其他客户端完成当前轮' : '给 Codex 发送消息'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
          rows={1}
        />
        <div className="composer-footer">
          {working && !foreignActive ? (
            <div className="send-mode-wrap">
              <button type="button" className="send-mode" onClick={() => setModeOpen((open) => !open)}>
                {mode === 'interject' ? '插话' : '排队'}<ChevronDown size={14} />
              </button>
              {modeOpen && (
                <div className="send-mode-menu">
                  <button type="button" className={mode === 'interject' ? 'selected' : ''} onClick={() => { setMode('interject'); setModeOpen(false) }}>
                    <strong>插话</strong><small>下一次工具调用时注入</small>
                  </button>
                  <button type="button" className={mode === 'queue' ? 'selected' : ''} onClick={() => { setMode('queue'); setModeOpen(false) }}>
                    <strong>排队</strong><small>保留为后续独立回合</small>
                  </button>
                </div>
              )}
            </div>
          ) : <span className="composer-hint">⌘↵ 发送</span>}
          <div className="composer-actions">
            {working && !foreignActive && (
              <button type="button" className="stop-button" onClick={() => void onStop()} title="停止当前轮">
                <Square size={13} /> 停止
              </button>
            )}
            <ContextRing usage={contextUsage} />
            <button type="button" className="send-button" disabled={disabled || busy || !text.trim()} onClick={() => void submit()} title="发送消息">
              <Send size={17} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ContextRing({ usage }: { usage: ThreadTokenUsage | null }) {
  const windowSize = usage?.modelContextWindow ?? null
  const used = usage?.last.totalTokens ?? null
  const percent = windowSize && used !== null ? Math.min(100, Math.max(0, (used / windowSize) * 100)) : 0
  const circumference = 2 * Math.PI * 9
  const dashOffset = circumference * (1 - percent / 100)
  const tone = percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : ''
  const label = windowSize && used !== null
    ? `上下文已使用 ${formatTokens(used)} / ${formatTokens(windowSize)} tokens（${Math.round(percent)}%）`
    : '等待 App Server 提供上下文窗口用量'

  return (
    <span className={`context-ring ${tone}`} title={label} aria-label={label}>
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle className="context-ring-track" cx="12" cy="12" r="9" />
        <circle
          className="context-ring-progress"
          cx="12"
          cy="12"
          r="9"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
    </span>
  )
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
