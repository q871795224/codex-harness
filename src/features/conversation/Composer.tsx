import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Send, Square } from 'lucide-react'

interface ComposerProps {
  disabled: boolean
  working: boolean
  foreignActive: boolean
  busy: boolean
  onSend: (text: string, mode: 'interject' | 'queue') => Promise<void> | void
  onStop: () => Promise<void> | void
}

export function Composer({ disabled, working, foreignActive, busy, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'interject' | 'queue'>('interject')
  const [modeOpen, setModeOpen] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [disabled])

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
          rows={2}
        />
        <div className="composer-footer">
          {working && !foreignActive ? (
            <div className="send-mode-wrap">
              <button type="button" className="send-mode" onClick={() => setModeOpen((open) => !open)}>
                {mode === 'interject' ? '插话' : '排队'}<ChevronDown size={13} />
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
            <button type="button" className="send-button" disabled={disabled || busy || !text.trim()} onClick={() => void submit()} title="发送消息">
              <Send size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
