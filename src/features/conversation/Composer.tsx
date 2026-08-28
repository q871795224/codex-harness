import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, FileText, Image, Plus, Send, Sparkles, Square, X } from 'lucide-react'
import type { ApprovalPolicy, CodexModel, CodexSkill, FollowUpMode, SendShortcut, ThreadCodexSettings, ThreadTokenUsage, UserInput } from '../../core/domain/codex'
import { textInput } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import {
  absoluteMentionPath,
  activeComposerTrigger,
  expandCollapsedPastes,
  hasSkillMarker,
  insertCollapsedPaste,
  insertComposerPrompt,
  matchesSendShortcut,
  reconcileCollapsedPastes,
  reasoningEffortTone,
  replaceComposerTrigger,
  shouldCollapsePaste,
  type CollapsedPaste,
} from './composerInput'
import { parseComposerCommand, type ComposerCommand } from './composerCommands'

interface ComposerProps {
  initialDraft?: ComposerDraft
  disabled: boolean
  working: boolean
  foreignActive: boolean
  busy: boolean
  contextUsage: ThreadTokenUsage | null
  workspaceRoot: string | null
  sendShortcut: SendShortcut
  models: CodexModel[]
  settings: ThreadCodexSettings
  rawMode: boolean
  followUpMode: FollowUpMode
  settingsDisabled?: boolean
  onSettingsChange: (patch: Partial<ThreadCodexSettings>) => Promise<void> | void
  onFollowUpModeChange: (mode: FollowUpMode) => void
  onSend: (input: UserInput[], mode: 'interject' | 'queue') => Promise<void> | void
  onCommand: (command: ComposerCommand) => Promise<void> | void
  onStop: () => Promise<void> | void
  onDraftChange?: (draft: ComposerDraft, hasContent: boolean) => void
  actions?: (api: ComposerActionApi) => ReactNode
}

export interface ComposerActionApi {
  disabled: boolean
  insertSkillPrompt(skillName: string, prompt: string): Promise<boolean>
}

export interface ComposerAttachment {
  path: string
  name: string
  kind: 'image' | 'file' | 'skill'
}

export interface ComposerDraft {
  text: string
  collapsedPastes: CollapsedPaste[]
  attachments: ComposerAttachment[]
}

interface FuzzyFileSearchResult {
  root: string
  path: string
  match_type: 'file' | 'directory'
  file_name: string
}

interface ComposerSuggestion {
  kind: 'file' | 'skill'
  name: string
  path: string
  detail: string
}

export function Composer({ initialDraft, disabled, working, foreignActive, busy, contextUsage, workspaceRoot, sendShortcut, models, settings, rawMode, followUpMode, settingsDisabled, onSettingsChange, onFollowUpModeChange, onSend, onCommand, onStop, onDraftChange, actions }: ComposerProps) {
  const [text, setText] = useState(initialDraft?.text ?? '')
  const [collapsedPastes, setCollapsedPastes] = useState<CollapsedPaste[]>(initialDraft?.collapsedPastes ?? [])
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(initialDraft?.attachments ?? [])
  const [modeOpen, setModeOpen] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [cursor, setCursor] = useState<number | null>(0)
  const [fileMatches, setFileMatches] = useState<FuzzyFileSearchResult[]>([])
  const [skills, setSkills] = useState<CodexSkill[]>([])
  const [loadedSkillsRoot, setLoadedSkillsRoot] = useState<string | null>(null)
  const [suggestionBusy, setSuggestionBusy] = useState(false)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0)
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const onDraftChangeRef = useRef(onDraftChange)
  const selectedModel = models.find((model) => model.model === settings.model) ?? models[0] ?? null
  const imageUnsupported = attachments.some((item) => item.kind === 'image') && selectedModel !== null && !selectedModel.inputModalities.includes('image')
  const expandedText = useMemo(() => expandCollapsedPastes(text, collapsedPastes), [collapsedPastes, text])
  const hasContent = Boolean(expandedText.trim() || attachments.length)
  const trigger = useMemo(() => activeComposerTrigger(text, cursor), [cursor, text])
  const triggerKind = trigger?.kind ?? null
  const triggerQuery = trigger?.query ?? ''

  const suggestions = useMemo<ComposerSuggestion[]>(() => {
    if (!trigger || suggestionsDismissed) return []
    if (trigger.kind === 'file') {
      return fileMatches
        .filter((match) => match.match_type === 'file')
        .slice(0, 8)
        .map((match) => ({
          kind: 'file',
          name: match.file_name || match.path.split(/[\\/]/).pop() || match.path,
          path: absoluteMentionPath(match.root, match.path),
          detail: match.path,
        }))
    }
    const query = trigger.query.toLocaleLowerCase()
    return skills
      .filter((skill) => skill.enabled && (!query || skill.name.toLocaleLowerCase().includes(query) || skill.description.toLocaleLowerCase().includes(query)))
      .slice(0, 8)
      .map((skill) => ({ kind: 'skill', name: skill.name, path: skill.path, detail: skill.description }))
  }, [fileMatches, skills, suggestionsDismissed, trigger])
  const suggestionsOpen = Boolean(trigger && !suggestionsDismissed)

  useEffect(() => { onDraftChangeRef.current = onDraftChange }, [onDraftChange])

  useEffect(() => {
    onDraftChangeRef.current?.({ text, collapsedPastes, attachments }, hasContent)
  }, [attachments, collapsedPastes, hasContent, text])

  useEffect(() => { ref.current?.focus() }, [disabled])

  useEffect(() => {
    if (!working) setModeOpen(false)
  }, [working])

  useLayoutEffect(() => {
    const textarea = ref.current
    if (!textarea) return
    const maximumHeight = 124
    textarea.style.height = '0px'
    const nextHeight = Math.min(textarea.scrollHeight, maximumHeight)
    textarea.style.height = `${Math.max(28, nextHeight)}px`
    textarea.style.overflowY = textarea.scrollHeight > maximumHeight ? 'auto' : 'hidden'
  }, [text])

  useEffect(() => {
    setSkills([])
    setLoadedSkillsRoot(null)
  }, [workspaceRoot])

  useEffect(() => {
    if (triggerKind !== 'skill' || !workspaceRoot || loadedSkillsRoot === workspaceRoot) return
    let disposed = false
    setSuggestionBusy(true)
    setSuggestionError(null)
    void runtime.request<{ data: Array<{ skills: CodexSkill[] }> }>('skills/list', { cwds: [workspaceRoot] })
      .then((result) => {
        if (disposed) return
        setSkills(result.data.flatMap((entry) => entry.skills))
        setLoadedSkillsRoot(workspaceRoot)
      })
      .catch((error) => { if (!disposed) setSuggestionError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!disposed) setSuggestionBusy(false) })
    return () => { disposed = true }
  }, [loadedSkillsRoot, triggerKind, workspaceRoot])

  useEffect(() => {
    if (triggerKind !== 'file' || !workspaceRoot) {
      setFileMatches([])
      return undefined
    }
    let disposed = false
    setFileMatches([])
    const timeout = window.setTimeout(() => {
      setSuggestionBusy(true)
      setSuggestionError(null)
      void runtime.request<{ files: FuzzyFileSearchResult[] }>('fuzzyFileSearch', {
        query: triggerQuery,
        roots: [workspaceRoot],
        cancellationToken: crypto.randomUUID(),
      }).then((result) => {
        if (!disposed) setFileMatches(result.files)
      }).catch((error) => {
        if (!disposed) setSuggestionError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (!disposed) setSuggestionBusy(false)
      })
    }, 100)
    return () => {
      disposed = true
      window.clearTimeout(timeout)
    }
  }, [triggerKind, triggerQuery, workspaceRoot])

  useEffect(() => { setHighlightedSuggestion(0) }, [triggerKind, triggerQuery])

  const inputs = useMemo<UserInput[]>(() => [
    ...(expandedText.trim() ? [textInput(collapsedPastes.length > 0 ? expandedText : expandedText.trim())] : []),
    ...attachments.map((attachment): UserInput => attachment.kind === 'image'
      ? { type: 'localImage', path: attachment.path }
      : attachment.kind === 'skill'
        ? { type: 'skill', name: attachment.name, path: attachment.path }
      : { type: 'mention', name: attachment.name, path: attachment.path }),
  ], [attachments, collapsedPastes.length, expandedText])

  const submit = async () => {
    if (!hasContent || disabled || busy || imageUnsupported) return
    const command = parseComposerCommand(expandedText, attachments.length > 0)
    if (command) await onCommand(command)
    else await onSend(inputs, followUpMode)
    setText('')
    setCollapsedPastes([])
    setAttachments([])
    setFileMatches([])
    setCursor(0)
    setSuggestionsDismissed(false)
  }

  const runPrimaryAction = () => working && !hasContent ? onStop() : submit()

  const chooseSuggestion = (suggestion: ComposerSuggestion) => {
    if (!trigger) return
    const replacement = suggestion.kind === 'skill' ? `$${suggestion.name}` : ''
    const next = replaceComposerTrigger(text, trigger, replacement)
    setCollapsedPastes((current) => reconcileCollapsedPastes(text, next.text, current))
    setText(next.text)
    setCursor(next.cursor)
    setAttachments((current) => current.some((item) => item.kind === suggestion.kind && item.path === suggestion.path)
      ? current
      : [...current, { kind: suggestion.kind, name: suggestion.name, path: suggestion.path }])
    setFileMatches([])
    setSuggestionsDismissed(false)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(next.cursor, next.cursor)
    })
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

  const insertSkillPrompt = async (skillName: string, prompt: string): Promise<boolean> => {
    if (!workspaceRoot) {
      setActionError('当前会话没有 workspace，无法加载 Skill。')
      return false
    }
    setActionError(null)
    try {
      const result = await runtime.request<{ data: Array<{ skills: CodexSkill[] }> }>('skills/list', { cwds: [workspaceRoot] })
      const skill = result.data.flatMap((entry) => entry.skills)
        .find((candidate) => candidate.enabled && candidate.name === skillName)
      if (!skill) {
        setActionError(`Skill ${skillName} 未启用或不可用。`)
        return false
      }
      const nextText = insertComposerPrompt(text, prompt)
      const offset = text.trim() ? prompt.trim().length + 2 : 0
      setCollapsedPastes((current) => current.map((paste) => ({
        ...paste,
        start: paste.start + offset,
        end: paste.end + offset,
      })))
      setText(nextText)
      setCursor(nextText.length)
      setAttachments((current) => current.some((item) => item.kind === 'skill' && item.name === skill.name)
        ? current
        : [...current, { kind: 'skill', name: skill.name, path: skill.path }])
      requestAnimationFrame(() => {
        ref.current?.focus()
        ref.current?.setSelectionRange(nextText.length, nextText.length)
      })
      return true
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      return false
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
                {attachment.kind === 'image' ? <Image size={13} /> : attachment.kind === 'skill' ? <Sparkles size={13} /> : <FileText size={13} />}
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
          onChange={(event) => {
            const nextText = event.target.value
            setActionError(null)
            setCollapsedPastes((current) => reconcileCollapsedPastes(text, nextText, current))
            setText(nextText)
            setCursor(event.target.selectionStart)
            setSuggestionsDismissed(false)
            setAttachments((current) => current.filter((item) => item.kind !== 'skill' || hasSkillMarker(nextText, item.name)))
          }}
          onPaste={(event) => {
            const content = event.clipboardData.getData('text/plain')
            if (!shouldCollapsePaste(content)) return
            event.preventDefault()
            const textarea = event.currentTarget
            const next = insertCollapsedPaste(text, textarea.selectionStart, textarea.selectionEnd, content, collapsedPastes)
            setText(next.text)
            setCollapsedPastes(next.pastes)
            setCursor(next.cursor)
            setSuggestionsDismissed(false)
            setAttachments((current) => current.filter((item) => item.kind !== 'skill' || hasSkillMarker(next.text, item.name)))
            requestAnimationFrame(() => {
              ref.current?.focus()
              ref.current?.setSelectionRange(next.cursor, next.cursor)
            })
          }}
          onClick={(event) => setCursor(event.currentTarget.selectionStart)}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (suggestionsOpen && suggestions.length > 0 && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const direction = event.key === 'ArrowDown' ? 1 : -1
                setHighlightedSuggestion((current) => (current + direction + suggestions.length) % suggestions.length)
                return
              }
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                chooseSuggestion(suggestions[highlightedSuggestion] ?? suggestions[0])
                return
              }
            }
            if (suggestionsOpen && event.key === 'Escape') {
              event.preventDefault()
              setSuggestionsDismissed(true)
              return
            }
            if (matchesSendShortcut({
              key: event.key,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              shiftKey: event.shiftKey,
              altKey: event.altKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode,
            }, sendShortcut)) {
              event.preventDefault()
              void submit()
            }
          }}
          rows={1}
          wrap="soft"
        />
        {suggestionsOpen && (
          <div className="composer-suggestions" role="listbox" aria-label={triggerKind === 'file' ? '文件建议' : '技能建议'}>
            <div className="composer-suggestions-label">{triggerKind === 'file' ? '@ 文件' : '$ Skill'}</div>
            {suggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.kind}:${suggestion.path}`}
                type="button"
                role="option"
                aria-selected={index === highlightedSuggestion}
                className={index === highlightedSuggestion ? 'selected' : ''}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSuggestion(suggestion)}
              >
                {suggestion.kind === 'skill' ? <Sparkles size={14} /> : <FileText size={14} />}
                <span><strong>{suggestion.name}</strong><small>{suggestion.detail}</small></span>
              </button>
            ))}
            {suggestionBusy && suggestions.length === 0 && <div className="composer-suggestions-state">正在搜索…</div>}
            {!suggestionBusy && !suggestionError && suggestions.length === 0 && <div className="composer-suggestions-state">没有匹配项</div>}
            {suggestionError && <div className="composer-suggestions-state error">{suggestionError}</div>}
          </div>
        )}
        {imageUnsupported && <div className="composer-inline-error">当前模型不支持图片输入，请更换模型或移除图片。</div>}
        {actionError && <div className="composer-inline-error">{actionError}</div>}
        <div className="composer-footer">
          <div className="composer-left-actions">
            <button type="button" className="composer-icon-button" disabled={disabled || busy || attachmentBusy} onClick={() => void addFiles()} title="添加图片或文件" aria-label="添加图片或文件"><Plus size={17} /></button>
            <select className="approval-select" value={settings.approvalPolicy} disabled={settingsLocked} onChange={(event) => updateSettings({ approvalPolicy: event.target.value as ApprovalPolicy })} aria-label="审批模式" title="审批模式">
              <option value="on-request">On request</option>
              <option value="untrusted">Untrusted</option>
              <option value="never">Never</option>
            </select>
          </div>
          <div className="composer-actions">
            {rawMode && <span className="composer-raw-mode" title="输入 /raw 返回渲染视图">RAW</span>}
            {actions?.({ disabled: disabled || busy, insertSkillPrompt })}
            <div className="model-effort-control">
              <select value={settings.model} disabled={settingsLocked || models.length === 0} onChange={(event) => updateSettings({ model: event.target.value })} aria-label="模型" title={selectedModel?.description ?? '模型'}>
                {models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
              </select>
              <select className="effort-select" data-effort={reasoningEffortTone(settings.effort)} value={settings.effort} disabled={settingsLocked || !selectedModel} onChange={(event) => updateSettings({ effort: event.target.value })} aria-label="推理强度" title={`推理强度：${settings.effort}`}>
                {(selectedModel?.supportedReasoningEfforts ?? []).map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
              </select>
            </div>
            <ContextRing usage={contextUsage} />
            <div className="send-control">
              <button
                type="button"
                className={`send-button${working && !hasContent ? ' stop' : ''}`}
                disabled={disabled || busy || (!working && !hasContent) || (hasContent && imageUnsupported)}
                onClick={() => void runPrimaryAction()}
                title={working && !hasContent ? '停止当前回合' : working ? (followUpMode === 'queue' ? '排队' : '插话') : '发送消息'}
                aria-label={working && !hasContent ? '停止当前回合' : working ? (followUpMode === 'queue' ? '排队消息' : '插话') : '发送消息'}
              >
                {working && !hasContent ? <Square size={13} fill="currentColor" /> : <Send size={17} />}
              </button>
              {working && !foreignActive && (
                <button type="button" className="follow-up-toggle" disabled={busy} onClick={() => setModeOpen((open) => !open)} title={`默认：${followUpMode === 'queue' ? '排队' : '插话'}`} aria-label="选择后续消息默认行为"><ChevronDown size={13} /></button>
              )}
              {working && !foreignActive && modeOpen && (
                <div className="follow-up-menu">
                  <button type="button" className={followUpMode === 'queue' ? 'selected' : ''} onClick={() => { onFollowUpModeChange('queue'); setModeOpen(false) }}><strong>默认排队</strong><small>当前回合完成后，开始新的回合</small></button>
                  <button type="button" className={followUpMode === 'interject' ? 'selected' : ''} onClick={() => { onFollowUpModeChange('interject'); setModeOpen(false) }}><strong>默认插话</strong><small>不停止当前回合，追加新的方向</small></button>
                </div>
              )}
            </div>
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
