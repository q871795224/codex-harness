import { useEffect, useLayoutEffect, useMemo, useRef, useState, Fragment, type ReactNode } from 'react'
import { ChevronDown, FileText, Image, NotebookPen, Plus, Send, ShieldOff, Sparkles, Square, Terminal, X, Zap } from 'lucide-react'
import type { ClaudeModel, ClaudeSessionSettings } from '../../core/claude/types'
import type { ApprovalPolicy, CodexModel, CodexSkill, FollowUpMode, SendShortcut, ThreadCodexSettings, ThreadTokenUsage, UserInput } from '../../core/domain/codex'
import type { ComposerCompletionItem } from '../../extensions/types'
import { runtime } from '../../core/runtime/bridge'
import { appServer, type FuzzyFileSearchResult } from '../../core/runtime/appServerClient'
import {
  absoluteMentionPath,
  activeComposerTrigger,
  clipboardHasImage,
  composerInputs,
  expandCollapsedPastes,
  hasSkillMarker,
  insertCollapsedPaste,
  insertComposerPrompt,
  isSupportedImagePath,
  matchesSendShortcut,
  reconcileCollapsedPastes,
  reasoningEffortTone,
  replaceComposerTrigger,
  shouldCollapsePaste,
  type CollapsedPaste,
} from './composerInput'
import { findProjectCard, projectCardLabel } from '../project-doc/projectCard'
import { parseComposerCommand, type ComposerCommand } from './composerCommands'
import { fastServiceTier, fastServiceTierTooltip } from '../codex/serviceTier'
import { isYoloMode, yoloModeSettings } from '../codex/yoloMode'

export interface ComposerProjectCard {
  projectId: string
  name: string
  seq: number
  /** 项目文档正文（注入内容，仅正文）。 */
  content: string
}

interface ComposerProps {
  provider?: 'codex' | 'claude'
  initialDraft?: ComposerDraft
  /** 第 0 轮的项目背景卡意图；非空时 Composer 在输入框第一行维护一张对应折叠卡。 */
  projectCard?: ComposerProjectCard | null
  /** 用户手动删掉项目背景卡时回调（用于解绑）。 */
  onProjectCardDismissed?: () => void
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
  completionProviders?: ComposerCompletionProvider[]
}

export interface ComposerCompletionProvider {
  key: string
  trigger: string
  loadItems(query: string): Promise<ComposerCompletionItem[]>
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
  kind: 'image' | 'file' | 'skill' | 'command' | 'plugin'
  name: string
  path?: string
  detail: string
  replacement?: string
  complete?: boolean
  id?: string
  group?: string
  insertText?: string
  collapseAsPaste?: boolean
}

export function Composer({ provider = 'codex', initialDraft, projectCard = null, onProjectCardDismissed, disabled, working, foreignActive, busy: externallyBusy, contextUsage, workspaceRoot, sendShortcut, focusRequest, autoFocus = true, models, settings, claudeModels = [], claudeSettings, rawMode, followUpMode, settingsDisabled, onSettingsChange, onClaudeSettingsChange, onFollowUpModeChange, onSend, onCommand, onStop, onDraftChange, onCollapse, actions, completionProviders = [] }: ComposerProps) {
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const busy = externallyBusy || submitting
  const [text, setText] = useState(initialDraft?.text ?? '')
  const [collapsedPastes, setCollapsedPastes] = useState<CollapsedPaste[]>(initialDraft?.collapsedPastes ?? [])
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(initialDraft?.attachments ?? [])
  const [modeOpen, setModeOpen] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [cursor, setCursor] = useState<number | null>(0)
  const [fileMatches, setFileMatches] = useState<FuzzyFileSearchResult[]>([])
  const [pluginItems, setPluginItems] = useState<ComposerCompletionItem[]>([])
  const [skills, setSkills] = useState<CodexSkill[]>([])
  const [loadedSkillsRoot, setLoadedSkillsRoot] = useState<string | null>(null)
  const [suggestionBusy, setSuggestionBusy] = useState(false)
  const [suggestionError, setSuggestionError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(0)
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  const [composing, setComposing] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const pendingProjectCursor = useRef<{ text: string; cursor: number } | null>(null)
  const previousFocusRequestRef = useRef(focusRequest)
  const onDraftChangeRef = useRef(onDraftChange)
  const completionProvidersRef = useRef(completionProviders)
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
  const providerChars = useMemo(() => completionProviders.map((item) => item.trigger).join(''), [completionProviders])
  const trigger = useMemo(() => activeComposerTrigger(text, cursor, providerChars), [cursor, providerChars, text])
  const triggerKind = trigger?.kind ?? null
  const triggerChar = trigger?.triggerChar ?? null
  const triggerQuery = trigger?.query ?? ''

  const suggestions = useMemo<ComposerSuggestion[]>(() => {
    if (!trigger || suggestionsDismissed) return []
    if (trigger.kind === 'file') {
      if (provider === 'claude') return []
      return fileMatches
        .filter((match) => match.match_type === 'file')
        .slice(0, 8)
        .map((match) => ({
          kind: isSupportedImagePath(match.path) ? 'image' : 'file',
          name: match.file_name || match.path.split(/[\\/]/).pop() || match.path,
          path: absoluteMentionPath(match.root, match.path),
          detail: match.path,
        }))
    }
    if (trigger.kind === 'command') return attachments.length > 0 ? [] : commandSuggestions(trigger.query, models, selectedModel, claudeModels, selectedClaudeModel, provider)
    if (trigger.kind === 'plugin') {
      return pluginItems.map((item) => ({
        kind: 'plugin',
        id: item.id,
        name: item.title,
        detail: item.subtitle ?? '',
        group: item.group,
        insertText: item.insertText,
        collapseAsPaste: item.collapseAsPaste,
      }))
    }
    if (provider === 'claude') return []
    const query = trigger.query.toLocaleLowerCase()
    return skills
      .filter((skill) => skill.enabled && (!query || skill.name.toLocaleLowerCase().includes(query) || skill.description.toLocaleLowerCase().includes(query)))
      .slice(0, 8)
      .map((skill) => ({ kind: 'skill', name: skill.name, path: skill.path, detail: skill.description }))
  }, [attachments.length, claudeModels, fileMatches, models, pluginItems, provider, selectedClaudeModel, selectedModel, skills, suggestionsDismissed, trigger])
  const suggestionsOpen = Boolean(trigger && !suggestionsDismissed && !(trigger.kind === 'command' && attachments.length > 0))

  useLayoutEffect(() => { onDraftChangeRef.current = onDraftChange }, [onDraftChange])
  useLayoutEffect(() => { completionProvidersRef.current = completionProviders }, [completionProviders])

  // —— 项目背景卡（第 0 轮注入）同步 ——
  // spec（App 驱动的绑定意图）是单一事实源；折叠卡是它在输入框里的投影。
  // 本 effect 负责把 spec 同步成第一张项目卡：插入 / 替换 / 移除。
  // 只有用户编辑事件可以触发解绑；同步和发送清空都不触发。
  useLayoutEffect(() => {
    const existing = findProjectCard(collapsedPastes)
    const wantId = projectCard?.projectId ?? null
    const haveId = existing?.origin?.kind === 'project-doc' ? existing.origin.projectId : null
    const label = projectCard ? projectCardLabel(projectCard) : null
    // 已同步：卡的 projectId 与 label 都与 spec 一致，不动。
    if (haveId === wantId && (wantId === null || existing?.label === label)) return

    // 先移除现有项目卡（如有），再按需插入新卡。移除 = 删掉 label 文本区间。
    let nextText = text
    let nextPastes = collapsedPastes
    if (existing) {
      nextText = `${text.slice(0, existing.start)}${text.slice(existing.end)}`
      nextPastes = reconcileCollapsedPastes(text, nextText, collapsedPastes)
    }
    if (projectCard && label) {
      // 项目卡固定在输入框最开头（第一行）。
      if (!nextText.startsWith('\n')) {
        const separated = `\n${nextText}`
        nextPastes = reconcileCollapsedPastes(nextText, separated, nextPastes)
        nextText = separated
      }
      const inserted = insertCollapsedPaste(nextText, 0, 0, projectCard.content, nextPastes, label, {
        kind: 'project-doc',
        projectId: projectCard.projectId,
      })
      nextText = inserted.text
      nextPastes = inserted.pastes
      if (!existing) pendingProjectCursor.current = { text: nextText, cursor: inserted.cursor + 1 }
    }
    setText(nextText)
    setCollapsedPastes(nextPastes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectCard?.projectId, projectCard?.seq, projectCard?.name, projectCard?.content])

  useLayoutEffect(() => {
    const pending = pendingProjectCursor.current
    if (!pending || pending.text !== text) return
    ref.current?.setSelectionRange(pending.cursor, pending.cursor)
    setCursor(pending.cursor)
    pendingProjectCursor.current = null
    // Browser focus/selection restoration can run after layout effects.
    const frame = requestAnimationFrame(() => {
      if (ref.current?.value === pending.text) ref.current.setSelectionRange(pending.cursor, pending.cursor)
    })
    return () => cancelAnimationFrame(frame)
  }, [text])

  const updatePastesFromUserEdit = (nextPastes: CollapsedPaste[]) => {
    if (projectCard && findProjectCard(collapsedPastes) && !findProjectCard(nextPastes)) {
      onProjectCardDismissed?.()
    }
    setCollapsedPastes(nextPastes)
  }

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
    if (highlightRef.current) {
      highlightRef.current.style.width = `${textarea.clientWidth}px`
      highlightRef.current.scrollTop = textarea.scrollTop
    }
  }, [composing, text])

  useEffect(() => {
    const textarea = ref.current
    if (!textarea || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (highlightRef.current) highlightRef.current.style.width = `${textarea.clientWidth}px`
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [])

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

  const providerKeys = completionProviders.map((entry) => `${entry.key}:${entry.trigger}`).join('|')
  useEffect(() => {
    if (triggerKind !== 'plugin' || !triggerChar) {
      setPluginItems([])
      return undefined
    }
    const providers = completionProvidersRef.current.filter((entry) => entry.trigger === triggerChar)
    if (providers.length === 0) {
      setPluginItems([])
      return undefined
    }
    let disposed = false
    setPluginItems([])
    const timeout = window.setTimeout(() => {
      setSuggestionBusy(true)
      setSuggestionError(null)
      void Promise.all(providers.map((entry) => entry.loadItems(triggerQuery))).then((results) => {
        if (!disposed) setPluginItems(results.flat())
      }).catch((error) => {
        if (!disposed) setSuggestionError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (!disposed) setSuggestionBusy(false)
      })
    }, 80)
    return () => {
      disposed = true
      window.clearTimeout(timeout)
    }
  }, [providerKeys, triggerChar, triggerKind, triggerQuery])

  useEffect(() => { setHighlightedSuggestion(0) }, [triggerKind, triggerQuery])

  const inputs = useMemo<UserInput[]>(() => {
    return composerInputs(expandedText, attachments, collapsedPastes.length > 0)
  }, [attachments, collapsedPastes.length, expandedText])

  const submitDraft = async () => {
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
      try {
        await onCommand(command)
      } catch {
        return
      }
    }
    else {
      try {
        await onSend(inputs, followUpMode)
      } catch {
        return
      }
    }
    setText('')
    setCollapsedPastes([])
    setAttachments([])
    setFileMatches([])
    setPluginItems([])
    setCursor(0)
    setSuggestionsDismissed(false)
  }

  // onSend 包括发送后的绑定落盘；在整个流程结束前不接受重复提交。
  const submit = async () => {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      await submitDraft()
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const runPrimaryAction = () => working && !hasContent ? onStop() : submit()

  const chooseSuggestion = async (suggestion: ComposerSuggestion) => {
    if (!trigger) return
    if (suggestion.kind === 'plugin') {
      const body = suggestion.insertText ?? ''
      const next = suggestion.collapseAsPaste
        ? (() => {
          const stripped = replaceComposerTrigger(text, trigger, '')
          const rebased = reconcileCollapsedPastes(text, stripped.text, collapsedPastes)
          const label = `[Prompt: ${suggestion.name.replace(/\s+/g, ' ').trim().slice(0, 30)}]`
          return insertCollapsedPaste(stripped.text, stripped.cursor, stripped.cursor, body, rebased, label)
        })()
        : (() => {
          const replaced = replaceComposerTrigger(text, trigger, body)
          return { text: replaced.text, cursor: replaced.cursor, pastes: reconcileCollapsedPastes(text, replaced.text, collapsedPastes) }
        })()
      setText(next.text)
      updatePastesFromUserEdit(next.pastes)
      setCursor(next.cursor)
      setPluginItems([])
      requestAnimationFrame(() => {
        ref.current?.focus()
        ref.current?.setSelectionRange(next.cursor, next.cursor)
      })
      return
    }
    if (suggestion.kind === 'image') {
      setAttachmentBusy(true)
      setActionError(null)
      try {
        await runtime.validateComposerImage(suggestion.path!)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error))
        return
      } finally {
        setAttachmentBusy(false)
      }
    }
    const replacement = suggestion.kind === 'skill' ? `$${suggestion.name}` : suggestion.kind === 'command' ? suggestion.replacement ?? `/${suggestion.name}` : ''
    const next = replaceComposerTrigger(text, trigger, replacement)
    updatePastesFromUserEdit(reconcileCollapsedPastes(text, next.text, collapsedPastes))
    setText(next.text)
    setCursor(next.cursor)
    setAttachments((current) => suggestion.kind === 'command' || suggestion.kind === 'plugin' || current.some((item) => item.kind === suggestion.kind && item.path === suggestion.path)
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
      const candidates = await Promise.all(paths.map(async (path) => {
        const attachment = attachmentFromPath(path)
        if (attachment.kind === 'image') await runtime.validateComposerImage(path)
        return attachment
      }))
      setAttachments((current) => {
        const known = new Set(current.map((item) => item.path))
        return [...current, ...candidates.filter((attachment) => !known.has(attachment.path))]
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
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
        <div className={`composer-text-editor${findProjectCard(collapsedPastes) ? ' has-project-card' : ''}`}>
          <div className="composer-text-highlight" ref={highlightRef} aria-hidden="true">
            <ProjectCardHighlight text={text} pastes={collapsedPastes} />
          </div>
        <textarea
          ref={ref}
          value={text}
          onScroll={(event) => { if (highlightRef.current) highlightRef.current.scrollTop = event.currentTarget.scrollTop }}
          disabled={disabled || busy || attachmentBusy}
          placeholder={foreignActive ? '等待其他客户端完成当前轮' : provider === 'claude' ? '给 Claude 发送消息' : '给 Codex 发送消息'}
          onChange={(event) => {
            const nextText = event.target.value
            setActionError(null)
            updatePastesFromUserEdit(reconcileCollapsedPastes(text, nextText, collapsedPastes))
            setText(nextText)
            setCursor(event.target.selectionStart)
            setSuggestionsDismissed(false)
            setAttachments((current) => current.filter((item) => item.kind !== 'skill' || hasSkillMarker(nextText, item.name)))
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onPaste={(event) => {
            if (clipboardHasImage(event.clipboardData)) {
              event.preventDefault()
              setAttachmentBusy(true)
              setActionError(null)
              void runtime.pasteComposerImage()
                .then((image) => setAttachments((current) => [...current, { path: image.path, name: image.name, kind: 'image' }]))
                .catch((error) => setActionError(error instanceof Error ? error.message : String(error)))
                .finally(() => setAttachmentBusy(false))
              return
            }
            const content = event.clipboardData.getData('text/plain')
            if (!shouldCollapsePaste(content)) return
            event.preventDefault()
            const textarea = event.currentTarget
            const next = insertCollapsedPaste(text, textarea.selectionStart, textarea.selectionEnd, content, collapsedPastes)
            setText(next.text)
            updatePastesFromUserEdit(next.pastes)
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
                  void chooseSuggestion(suggestion)
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
        </div>
        {suggestionsOpen && (
          <div className="composer-suggestions" role="listbox" aria-label={triggerKind === 'file' ? '文件建议' : triggerKind === 'skill' ? '技能建议' : triggerKind === 'plugin' ? '补全建议' : '命令建议'}>
            <div className="composer-suggestions-label">{triggerKind === 'file' ? '@ 文件' : triggerKind === 'skill' ? '$ Skill' : triggerKind === 'plugin' ? `${triggerChar} 建议` : '/ 命令'}</div>
            {suggestions.map((suggestion, index) => {
              const showGroup = suggestion.kind === 'plugin' && Boolean(suggestion.group) && (index === 0 || suggestions[index - 1]?.group !== suggestion.group)
              return (
                <Fragment key={`${suggestion.kind}:${suggestion.id ?? suggestion.path ?? suggestion.replacement ?? suggestion.name}`}>
                  {showGroup && <div className="composer-suggestions-label group">{suggestion.group}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === highlightedSuggestion}
                    className={index === highlightedSuggestion ? 'selected' : ''}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void chooseSuggestion(suggestion)}
                  >
                    {suggestion.kind === 'image' ? <Image size={14} /> : suggestion.kind === 'skill' ? <Sparkles size={14} /> : suggestion.kind === 'command' ? <Terminal size={14} /> : suggestion.kind === 'plugin' ? <NotebookPen size={14} /> : <FileText size={14} />}
                    <span><strong>{suggestion.name}</strong><small>{suggestion.detail}</small></span>
                  </button>
                </Fragment>
              )
            })}
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
                disabled={disabled || busy || attachmentBusy || (!working && !hasContent) || (hasContent && imageUnsupported)}
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

export function ProjectCardHighlight({ text, pastes }: { text: string; pastes: CollapsedPaste[] }) {
  const card = findProjectCard(pastes)
  if (!card) return <>{text}{'\n'}</>
  return <>{text.slice(0, card.start)}<span className="composer-project-label">{text.slice(card.start, card.end)}</span>{text.slice(card.end)}{'\n'}</>
}

function commandSuggestions(query: string, models: CodexModel[], selectedModel: CodexModel | null, claudeModels: ClaudeModel[], selectedClaudeModel: ClaudeModel | null, provider: 'codex' | 'claude'): ComposerSuggestion[] {
  const separator = query.indexOf(' ')
  if (separator < 0) {
    const normalized = query.toLocaleLowerCase()
    return [
      { name: 'new', detail: '新建会话', complete: true },
      { name: 'reset', detail: '清空当前会话并开始新会话', complete: true },
      { name: 'handover', detail: '生成交接文档并开启新会话', complete: true },
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
  return { path, name, kind: isSupportedImagePath(name) ? 'image' : 'file' }
}

export function ContextRing({ usage, provider }: { usage: ThreadTokenUsage | null; provider: 'codex' | 'claude' }) {
  const windowSize = usage?.modelContextWindow ?? null
  const used = usage?.contextTokens ?? usage?.last.totalTokens ?? null
  const percent = windowSize && used !== null ? Math.min(100, Math.max(0, (used / windowSize) * 100)) : 0
  const circumference = 2 * Math.PI * 9
  const dashOffset = circumference * (1 - percent / 100)
  const tone = percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : ''
  const label = windowSize && used !== null ? `上下文已使用 ${formatTokens(used)} / ${formatTokens(windowSize)} tokens（${Math.round(percent)}%）` : `等待${provider === 'claude' ? ' Claude' : ' App Server'} 提供上下文窗口用量`
  return (
    <span className={`context-ring ${tone}`} aria-label={label}>
      <svg viewBox="0 0 24 24" aria-hidden>
        <circle className="context-ring-track" cx="12" cy="12" r="9" />
        <circle className="context-ring-progress" cx="12" cy="12" r="9" strokeDasharray={circumference} strokeDashoffset={dashOffset} />
      </svg>
      <span className="context-ring-tooltip" role="tooltip">{label}</span>
    </span>
  )
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
