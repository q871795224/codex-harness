import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, FileText, Image, Plus, Send, ShieldOff, Sparkles, Square, Terminal, X, Zap } from 'lucide-react'
import type { ClaudeModel, ClaudeSessionSettings } from '../../core/claude/types'
import type { ApprovalPolicy, CodexModel, CodexSkill, FollowUpMode, SendShortcut, ThreadCodexSettings, ThreadTokenUsage, UserInput } from '../../core/domain/codex'
import { textInput } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { appServer, type FuzzyFileSearchResult } from '../../core/runtime/appServerClient'
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
import { fastServiceTier, fastServiceTierTooltip } from '../codex/serviceTier'
import { isYoloMode, yoloModeSettings } from '../codex/yoloMode'

interface ComposerProps {
  provider?: 'codex' | 'claude'
  initialDraft?: ComposerDraft
  disabled: boolean
  working: boolean
  foreignActive: boolean
  busy: boolean
  contextUsage: ThreadTokenUsage | null
  workspaceRoot: string | null
  sendShortcut: SendShortcut
  focusRequest: number
  autoFocus?: boolean
  models: CodexModel[]
  settings: ThreadCodexSettings
  claudeModels?: ClaudeModel[]
  claudeSettings?: ClaudeSessionSettings
  rawMode: boolean
  followUpMode: FollowUpMode
  settingsDisabled?: boolean
  onSettingsChange: (patch: Partial<ThreadCodexSettings>) => Promise<void> | void
  onClaudeSettingsChange?: (patch: Partial<ClaudeSessionSettings>) => Promise<void> | void
  onFollowUpModeChange: (mode: FollowUpMode) => void
  onSend: (input: UserInput[], mode: 'interject' | 'queue') => Promise<void> | void
  onCommand: (command: ComposerCommand) => Promise<void> | void
  onStop: () => Promise<void> | void
  onDraftChange?: (draft: ComposerDraft, hasContent: boolean) => void
  onCollapse?: () => void
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

interface ComposerSuggestion {
  kind: 'file' | 'skill' | 'command'
  name: string
  path?: string
  detail: string
  replacement?: string
  complete?: boolean
}

export function Composer({ provider = 'codex', initialDraft, disabled, working, foreignActive, busy, contextUsage, workspaceRoot, sendShortcut, focusRequest, autoFocus = true, models, settings, claudeModels = [], claudeSettings, rawMode, followUpMode, settingsDisabled, onSettingsChange, onClaudeSettingsChange, onFollowUpModeChange, onSend, onCommand, onStop, onDraftChange, onCollapse, actions }: ComposerProps) {
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
  const [composing, setComposing] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const previousFocusRequestRef = useRef(focusRequest)
  const onDraftChangeRef = useRef(onDraftChange)
  const selectedModel = models.find((model) => model.model === settings.model) ?? models[0] ?? null
  const selectedClaudeModel = claudeModels.find((model) => model.value === claudeSettings?.model) ?? claudeModels[0] ?? null
  const fastTier = fastServiceTier(selectedModel)
  const fastEnabled = fastTier?.id === settings.serviceTier
  const yoloEnabled = provider === 'claude'
    ? claudeSettings?.permissionMode === 'bypassPermissions'
    : isYoloMode(settings)
  const imageUnsupported = attachments.some((item) => item.kind === 'image') && selectedModel !== null && !selectedModel.inputModalities.includes('image')
  const expandedText = useMemo(() => expandCollapsedPastes(text, collapsedPastes), [collapsedPastes, text])
  const hasContent = Boolean(expandedText.trim() || attachments.length)
  const trigger = useMemo(() => activeComposerTrigger(text, cursor), [cursor, text])
  const triggerKind = trigger?.kind ?? null
  const triggerQuery = trigger?.query ?? ''

  const suggestions = useMemo<ComposerSuggestion[]>(() => {
    if (!trigger || suggestionsDismissed) return []
    if (trigger.kind === 'file') {
      if (provider === 'claude') return []
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
    if (trigger.kind === 'command') return attachments.length > 0 ? [] : commandSuggestions(trigger.query, models, selectedModel, claudeModels, selectedClaudeModel, provider)
    if (provider === 'claude') return []
    const query = trigger.query.toLocaleLowerCase()
    return skills
      .filter((skill) => skill.enabled && (!query || skill.name.toLocaleLowerCase().includes(query) || skill.description.toLocaleLowerCase().includes(query)))
      .slice(0, 8)
      .map((skill) => ({ kind: 'skill', name: skill.name, path: skill.path, detail: skill.description }))
  }, [attachments.length, claudeModels, fileMatches, models, provider, selectedClaudeModel, selectedModel, skills, suggestionsDismissed, trigger])
  const suggestionsOpen = Boolean(trigger && !suggestionsDismissed && !(trigger.kind === 'command' && attachments.length > 0))

  useLayoutEffect(() => { onDraftChangeRef.current = onDraftChange }, [onDraftChange])

  useLayoutEffect(() => {
    onDraftChangeRef.current?.({ text, collapsedPastes, attachments }, hasContent)
  }, [attachments, collapsedPastes, hasContent, text])

  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus, disabled])
  useEffect(() => {
    const explicitlyRequested = focusRequest !== previousFocusRequestRef.current
    previousFocusRequestRef.current = focusRequest
    if (autoFocus || explicitlyRequested) ref.current?.focus()
  }, [autoFocus, focusRequest])

  useEffect(() => {
    if (!working) setModeOpen(false)
  }, [working])

  useLayoutEffect(() => {
    const textarea = ref.current
    if (!textarea || composing) return
    const maximumHeight = 124
    textarea.style.height = '0px'
    const nextHeight = Math.min(textarea.scrollHeight, maximumHeight)
    textarea.style.height = `${Math.max(28, nextHeight)}px`
    textarea.style.overflowY = textarea.scrollHeight > maximumHeight ? 'auto' : 'hidden'
  }, [composing, text])

  useEffect(() => {
    setSkills([])
    setLoadedSkillsRoot(null)
  }, [workspaceRoot])

  useEffect(() => {
    if (provider === 'claude' || triggerKind !== 'skill' || !workspaceRoot || loadedSkillsRoot === workspaceRoot) return
    let disposed = false
    setSuggestionBusy(true)
    setSuggestionError(null)
    void appServer.listSkills(workspaceRoot)
      .then((result) => {
        if (disposed) return
        setSkills(result.data.flatMap((entry) => entry.skills))
        setLoadedSkillsRoot(workspaceRoot)
      })
      .catch((error) => { if (!disposed) setSuggestionError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!disposed) setSuggestionBusy(false) })
    return () => { disposed = true }
  }, [loadedSkillsRoot, provider, triggerKind, workspaceRoot])

  useEffect(() => {
    if (provider === 'claude' || triggerKind !== 'file' || !workspaceRoot) {
      setFileMatches([])
      return undefined
    }
    let disposed = false
    setFileMatches([])
    const timeout = window.setTimeout(() => {
      setSuggestionBusy(true)
      setSuggestionError(null)
      void appServer.fuzzyFileSearch(triggerQuery, [workspaceRoot], crypto.randomUUID()).then((result) => {
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
  }, [provider, triggerKind, triggerQuery, workspaceRoot])

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
    if (command) {
      if (settingsLocked && ['model', 'reasoning', 'permissions'].includes(command.name)) {
        setActionError('请等待当前回合结束后再修改会话设置。')
        return
      }
      if (command.name === 'model' && (provider === 'claude'
        ? !claudeModels.some((model) => model.value === command.model)
        : !models.some((model) => model.model === command.model))) {
        setActionError(`${provider === 'claude' ? 'Claude' : 'App Server'} 不支持模型 ${command.model}。`)
        return
      }
      if (command.name === 'reasoning' && provider === 'codex' && !selectedModel?.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === command.effort)) {
        setActionError(`当前模型不支持推理强度 ${command.effort}。`)
        return
      }
      await onCommand(command)
    }
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
    const replacement = suggestion.kind === 'skill' ? `$${suggestion.name}` : suggestion.kind === 'command' ? suggestion.replacement ?? `/${suggestion.name}` : ''
    const next = replaceComposerTrigger(text, trigger, replacement)
    setCollapsedPastes((current) => reconcileCollapsedPastes(text, next.text, current))
    setText(next.text)
    setCursor(next.cursor)
    setAttachments((current) => suggestion.kind === 'command' || current.some((item) => item.kind === suggestion.kind && item.path === suggestion.path)
      ? current
      : [...current, { kind: suggestion.kind, name: suggestion.name, path: suggestion.path! }])
    setFileMatches([])
    setSuggestionsDismissed(suggestion.kind === 'command' && Boolean(suggestion.complete))
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
      const result = await appServer.listSkills(workspaceRoot)
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
  const updateClaudeSettings = (patch: Partial<ClaudeSessionSettings>) => {
    void Promise.resolve(onClaudeSettingsChange?.(patch)).catch(() => undefined)
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
          placeholder={foreignActive ? '等待其他客户端完成当前轮' : provider === 'claude' ? '给 Claude 发送消息' : '给 Codex 发送消息'}
          onChange={(event) => {
            const nextText = event.target.value
            setActionError(null)
            setCollapsedPastes((current) => reconcileCollapsedPastes(text, nextText, current))
            setText(nextText)
            setCursor(event.target.selectionStart)
            setSuggestionsDismissed(false)
            setAttachments((current) => current.filter((item) => item.kind !== 'skill' || hasSkillMarker(nextText, item.name)))
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
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
                const suggestion = suggestions[highlightedSuggestion] ?? suggestions[0]
                if (event.key === 'Enter' && suggestion.kind === 'command' && suggestion.complete && text.trim() === suggestion.replacement) {
                  // Let the normal send path execute an already complete local command.
                } else {
                  event.preventDefault()
                  chooseSuggestion(suggestion)
                  return
                }
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
          <div className="composer-suggestions" role="listbox" aria-label={triggerKind === 'file' ? '文件建议' : triggerKind === 'skill' ? '技能建议' : '命令建议'}>
            <div className="composer-suggestions-label">{triggerKind === 'file' ? '@ 文件' : triggerKind === 'skill' ? '$ Skill' : '/ 命令'}</div>
            {suggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.kind}:${suggestion.path ?? suggestion.replacement ?? suggestion.name}`}
                type="button"
                role="option"
                aria-selected={index === highlightedSuggestion}
                className={index === highlightedSuggestion ? 'selected' : ''}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSuggestion(suggestion)}
              >
                {suggestion.kind === 'skill' ? <Sparkles size={14} /> : suggestion.kind === 'command' ? <Terminal size={14} /> : <FileText size={14} />}
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
            {provider === 'codex' && <select className="approval-select" value={settings.approvalPolicy} disabled={settingsLocked} onChange={(event) => updateSettings({ approvalPolicy: event.target.value as ApprovalPolicy })} aria-label="审批模式" title="审批模式">
              <option value="on-request">On request</option>
              <option value="untrusted">Untrusted</option>
              <option value="never">Never</option>
            </select>}
            {provider === 'claude' && claudeSettings && <select className="approval-select claude-permission-select" value={claudeSettings.permissionMode} disabled={settingsLocked} onChange={(event) => updateClaudeSettings({ permissionMode: event.target.value as ClaudeSessionSettings['permissionMode'] })} aria-label="Claude 权限模式" title="Claude 权限模式">
              <option value="default">Ask</option>
              <option value="acceptEdits">Accept edits</option>
              <option value="plan">Plan</option>
              <option value="dontAsk">Don't ask</option>
              <option value="bypassPermissions">Dangerous</option>
            </select>}
            <button
              type="button"
              className={`yolo-mode-button${yoloEnabled ? ' active' : ''}`}
              disabled={settingsLocked}
              onClick={() => provider === 'claude'
                ? updateClaudeSettings({ permissionMode: yoloEnabled ? 'default' : 'bypassPermissions' })
                : updateSettings(yoloModeSettings(!yoloEnabled))}
              title={provider === 'claude'
                ? (yoloEnabled ? '关闭 Dangerous：恢复 Claude 审批' : '开启 Dangerous：绕过 Claude 权限审批')
                : (yoloEnabled ? '关闭 YOLO：恢复按需审批和工作区沙箱' : '开启 YOLO：不请求审批并允许完整文件系统访问')}
              aria-label={provider === 'claude' ? '切换 Dangerous 模式' : '切换 YOLO 模式'}
              aria-pressed={yoloEnabled}
            >
              <ShieldOff size={14} />
            </button>
            {provider === 'codex' && fastTier && (
              <button
                type="button"
                className={`fast-mode-button${fastEnabled ? ' active' : ''}`}
                disabled={settingsLocked}
                onClick={() => updateSettings({ serviceTier: fastEnabled ? null : fastTier.id })}
                title={fastServiceTierTooltip(fastTier)}
                aria-label="切换 Fast 模式"
                aria-pressed={fastEnabled}
              >
                <Zap size={14} fill={fastEnabled ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
          {onCollapse && (
            <button type="button" className="composer-collapse-toggle expanded" onClick={onCollapse} aria-label="向下收起对话输入框" title="向下收起对话输入框">
              <ChevronDown size={12} />
            </button>
          )}
          <div className="composer-actions">
            {rawMode && <span className="composer-raw-mode" title="输入 /raw 返回渲染视图">RAW</span>}
            {actions?.({ disabled: disabled || busy, insertSkillPrompt })}
            {provider === 'codex' && <div className="model-effort-control">
              <select value={settings.model} disabled={settingsLocked || models.length === 0} onChange={(event) => updateSettings({ model: event.target.value })} aria-label="模型" title={selectedModel?.description ?? '模型'}>
                {models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}
              </select>
              <select className="effort-select" data-effort={reasoningEffortTone(settings.effort)} value={settings.effort} disabled={settingsLocked || !selectedModel} onChange={(event) => updateSettings({ effort: event.target.value })} aria-label="推理强度" title={`推理强度：${settings.effort}`}>
                {(selectedModel?.supportedReasoningEfforts ?? []).map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
              </select>
            </div>}
            {provider === 'claude' && claudeSettings && <div className="model-effort-control">
              <select value={claudeSettings.model ?? selectedClaudeModel?.value ?? ''} disabled={settingsLocked || claudeModels.length === 0} onChange={(event) => {
                const model = claudeModels.find((candidate) => candidate.value === event.target.value)
                updateClaudeSettings({ model: event.target.value, effort: model?.supportedEffortLevels[0] ?? null })
              }} aria-label="Claude 模型" title={selectedClaudeModel?.description ?? 'Claude 模型'}>
                {claudeModels.map((model) => <option key={model.value} value={model.value}>{model.displayName}</option>)}
              </select>
              {selectedClaudeModel?.supportedEffortLevels.length ? <select className="effort-select" value={claudeSettings.effort ?? selectedClaudeModel.supportedEffortLevels[0]} disabled={settingsLocked} onChange={(event) => updateClaudeSettings({ effort: event.target.value })} aria-label="Claude 推理强度" title={`推理强度：${claudeSettings.effort ?? selectedClaudeModel.supportedEffortLevels[0]}`}>
                {selectedClaudeModel.supportedEffortLevels.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select> : null}
            </div>}
            <ContextRing usage={contextUsage} provider={provider} />
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

function commandSuggestions(query: string, models: CodexModel[], selectedModel: CodexModel | null, claudeModels: ClaudeModel[], selectedClaudeModel: ClaudeModel | null, provider: 'codex' | 'claude'): ComposerSuggestion[] {
  const separator = query.indexOf(' ')
  if (separator < 0) {
    const normalized = query.toLocaleLowerCase()
    return [
      { name: 'new', detail: '新建会话', complete: true },
      { name: 'reset', detail: '清空当前会话并开始新会话', complete: true },
      { name: 'model', detail: '选择当前会话模型', complete: false },
      ...(provider === 'codex' ? [
        { name: 'reasoning', detail: '选择推理强度', complete: false },
        { name: 'permissions', detail: '选择审批策略', complete: false },
      ] : selectedClaudeModel?.supportedEffortLevels.length ? [{ name: 'reasoning', detail: '选择 Claude 推理强度', complete: false }] : []),
      { name: 'raw', detail: '切换原始 Markdown 显示', complete: true },
    ].filter((command) => command.name.includes(normalized)).map((command) => ({
      kind: 'command',
      name: command.name,
      detail: command.detail,
      replacement: `/${command.name}${command.complete ? '' : ' '}`,
      complete: command.complete,
    }))
  }

  const name = query.slice(0, separator)
  const argument = query.slice(separator + 1).trim().toLocaleLowerCase()
  if (name === 'model') return provider === 'claude'
    ? claudeModels
      .filter((model) => !argument || model.value.toLocaleLowerCase().includes(argument) || model.displayName.toLocaleLowerCase().includes(argument))
      .map((model) => ({ kind: 'command', name: model.displayName, detail: model.description, replacement: `/model ${model.value}`, complete: true }))
    : models
      .filter((model) => !argument || model.model.toLocaleLowerCase().includes(argument) || model.displayName.toLocaleLowerCase().includes(argument))
      .map((model) => ({ kind: 'command', name: model.displayName, detail: model.description, replacement: `/model ${model.model}`, complete: true }))
  if (name === 'reasoning') return provider === 'claude'
    ? (selectedClaudeModel?.supportedEffortLevels ?? [])
      .filter((effort) => !argument || effort.toLocaleLowerCase().includes(argument))
      .map((effort) => ({ kind: 'command', name: effort, detail: 'Claude 推理强度', replacement: `/reasoning ${effort}`, complete: true }))
    : (selectedModel?.supportedReasoningEfforts ?? [])
      .filter((effort) => !argument || effort.reasoningEffort.toLocaleLowerCase().includes(argument))
      .map((effort) => ({ kind: 'command', name: effort.reasoningEffort, detail: effort.description, replacement: `/reasoning ${effort.reasoningEffort}`, complete: true }))
  if (name === 'permissions' && provider === 'codex') return [
    { value: 'on-request', label: 'On request' },
    { value: 'untrusted', label: 'Untrusted' },
    { value: 'never', label: 'Never' },
  ].filter((policy) => !argument || policy.value.includes(argument) || policy.label.toLocaleLowerCase().includes(argument))
    .map((policy) => ({ kind: 'command', name: policy.label, detail: `审批策略：${policy.value}`, replacement: `/permissions ${policy.value}`, complete: true }))
  return []
}

function attachmentFromPath(path: string): ComposerAttachment {
  const name = path.split(/[\\/]/).pop() || path
  return { path, name, kind: /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i.test(name) ? 'image' : 'file' }
}

function ContextRing({ usage, provider }: { usage: ThreadTokenUsage | null; provider: 'codex' | 'claude' }) {
  const windowSize = usage?.modelContextWindow ?? null
  const used = usage?.contextTokens ?? usage?.last.totalTokens ?? null
  const percent = windowSize && used !== null ? Math.min(100, Math.max(0, (used / windowSize) * 100)) : 0
  const circumference = 2 * Math.PI * 9
  const dashOffset = circumference * (1 - percent / 100)
  const tone = percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : ''
  const label = windowSize && used !== null ? `上下文已使用 ${formatTokens(used)} / ${formatTokens(windowSize)} tokens（${Math.round(percent)}%）` : `等待${provider === 'claude' ? ' Claude' : ' App Server'} 提供上下文窗口用量`
  return <span className={`context-ring ${tone}`} title={label} aria-label={label}><svg viewBox="0 0 24 24" aria-hidden><circle className="context-ring-track" cx="12" cy="12" r="9" /><circle className="context-ring-progress" cx="12" cy="12" r="9" strokeDasharray={circumference} strokeDashoffset={dashOffset} /></svg></span>
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
