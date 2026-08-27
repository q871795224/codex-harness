import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, FileText, Image, Plus, Send, Square, X } from 'lucide-react'
import type { ApprovalPolicy, CodexModel, ThreadCodexSettings, ThreadTokenUsage, UserInput } from '../../core/domain/codex'
import { textInput } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'

interface ComposerProps {
  disabled: boolean
  working: boolean
  foreignActive: boolean
  busy: boolean
  contextUsage: ThreadTokenUsage | null
  models: CodexModel[]
  settings: ThreadCodexSettings
  settingsDisabled?: boolean
  onSettingsChange: (patch: Partial<ThreadCodexSettings>) => Promise<void> | void
  onSend: (input: UserInput[], mode: 'interject' | 'queue') => Promise<void> | void
  onStop: () => Promise<void> | void
}

interface ComposerAttachment {
  path: string
  name: string
  kind: 'image' | 'file'
}

export function Composer({ disabled, working, foreignActive, busy, contextUsage, models, settings, settingsDisabled, onSettingsChange, onSend, onStop }: ComposerProps) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [mode, setMode] = useState<'interject' | 'queue'>('interject')
  const [modeOpen, setModeOpen] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const selectedModel = models.find((model) => model.model === settings.model) ?? models[0] ?? null
  const imageUnsupported = attachments.some((item) => item.kind === 'image') && selectedModel !== null && !selectedModel.inputModalities.includes('image')
  const hasContent = Boolean(text.trim() || attachments.length)

  useEffect(() => { ref.current?.focus() }, [disabled])

  useLayoutEffect(() => {
    const textarea = ref.current
    if (!textarea) return
    const maximumHeight = 124
    textarea.style.height = '0px'
    const nextHeight = Math.min(textarea.scrollHeight, maximumHeight)
    textarea.style.height = `${Math.max(28, nextHeight)}px`
    textarea.style.overflowY = textarea.scrollHeight > maximumHeight ? 'auto' : 'hidden'
  }, [text])

  const inputs = useMemo<UserInput[]>(() => [
    ...(text.trim() ? [textInput(text.trim())] : []),
    ...attachments.map((attachment): UserInput => attachment.kind === 'image'
      ? { type: 'localImage', path: attachment.path }
      : { type: 'mention', name: attachment.name, path: attachment.path }),
  ], [attachments, text])

  const submit = async () => {
    if (!hasContent || disabled || busy || imageUnsupported) return
    await onSend(inputs, mode)
    setText('')
    setAttachments([])
    setMode('interject')
  }

  const addFiles = async () => {
    setAttachmentBusy(true)
    try {
      const paths = await runtime.chooseComposerFiles()
      setAttachments((current) => {
        const known = new Set(current.map((item) => item.path))
        return [...current, ...paths.filter((path) => !known.has(path)).map(attachmentFromPath)]
      })
    } finally {
      setAttachmentBusy(false)
    }
  }

  // App Server does not accept model/effort overrides on turn/steer. Keep the
  // controls stable until the active turn ends so their meaning stays truthful.
  const settingsLocked = disabled || busy || settingsDisabled || working
  const updateSettings = (patch: Partial<ThreadCodexSettings>) => {
    void Promise.resolve(onSettingsChange(patch)).catch(() => undefined)
  }

  return (
    <div className="composer-zone">
      {foreignActive && <div className="foreign-active-note">此会话由其他 Codex 客户端运行，当前只读。</div>}
      <div className={`composer-card ${disabled ? 'disabled' : ''}`} data-composer-card>
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <span key={attachment.path} title={attachment.path}>
                {attachment.kind === 'image' ? <Image size={13} /> : <FileText size={13} />}
                <span>{attachment.name}</span>
                <button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.path !== attachment.path))} aria-label={`移除 ${attachment.name}`}><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
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
        {imageUnsupported && <div className="composer-inline-error">当前模型不支持图片输入，请更换模型或移除图片。</div>}
        <div className="composer-footer">
          <div className="composer-left-actions">
            <button type="button" className="composer-icon-button" disabled={disabled || busy || attachmentBusy} onClick={() => void addFiles()} title="添加图片或文件" aria-label="添加图片或文件"><Plus size={17} /></button>
            <select className="approval-select" value={settings.approvalPolicy} disabled={settingsLocked} onChange={(event) => updateSettings({ approvalPolicy: event.target.value as ApprovalPolicy })} aria-label="审批模式" title="审批模式">
              <option value="on-request">On request</option>
              <option value="untrusted">Untrusted</option>
              <option value="never">Never</option>
            </select>
            {working && !foreignActive && (
              <div className="send-mode-wrap">
                <button type="button" className="send-mode" onClick={() => setModeOpen((open) => !open)}>{mode === 'interject' ? '插话' : '排队'}<ChevronDown size={14} /></button>
                {modeOpen && (
                  <div className="send-mode-menu">
                    <button type="button" className={mode === 'interject' ? 'selected' : ''} onClick={() => { setMode('interject'); setModeOpen(false) }}><strong>插话</strong><small>下一次工具调用时注入</small></button>
                    <button type="button" className={mode === 'queue' ? 'selected' : ''} onClick={() => { setMode('queue'); setModeOpen(false) }}><strong>排队</strong><small>保留为后续独立回合</small></button>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="composer-actions">
            <div className="model-effort-control">
              <select value={settings.model} disabled={settingsLocked || models.length === 0} onChange={(event) => updateSettings({ model: event.target.value })} aria-label="模型" title={selectedModel?.description ?? '模型'}>
                {models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
              </select>
              <select value={settings.effort} disabled={settingsLocked || !selectedModel} onChange={(event) => updateSettings({ effort: event.target.value })} aria-label="推理强度" title="推理强度">
                {(selectedModel?.supportedReasoningEfforts ?? []).map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
              </select>
            </div>
            {working && !foreignActive && <button type="button" className="stop-button" onClick={() => void onStop()} title="停止当前轮"><Square size={13} /> 停止</button>}
            <ContextRing usage={contextUsage} />
            <button type="button" className="send-button" disabled={disabled || busy || !hasContent || imageUnsupported} onClick={() => void submit()} title="发送消息"><Send size={17} /></button>
          </div>
        </div>
      </div>
    </div>
  )
}

function attachmentFromPath(path: string): ComposerAttachment {
  const name = path.split(/[\\/]/).pop() || path
  return { path, name, kind: /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(name) ? 'image' : 'file' }
}

function ContextRing({ usage }: { usage: ThreadTokenUsage | null }) {
  const windowSize = usage?.modelContextWindow ?? null
  const used = usage?.last.totalTokens ?? null
  const percent = windowSize && used !== null ? Math.min(100, Math.max(0, (used / windowSize) * 100)) : 0
  const circumference = 2 * Math.PI * 9
  const dashOffset = circumference * (1 - percent / 100)
  const tone = percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : ''
  const label = windowSize && used !== null ? `上下文已使用 ${formatTokens(used)} / ${formatTokens(windowSize)} tokens（${Math.round(percent)}%）` : '等待 App Server 提供上下文窗口用量'
  return <span className={`context-ring ${tone}`} title={label} aria-label={label}><svg viewBox="0 0 24 24" aria-hidden><circle className="context-ring-track" cx="12" cy="12" r="9" /><circle className="context-ring-progress" cx="12" cy="12" r="9" strokeDasharray={circumference} strokeDashoffset={dashOffset} /></svg></span>
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
