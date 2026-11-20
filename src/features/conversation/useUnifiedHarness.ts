import { nextConversationProvider, type ConversationProvider } from '../../core/domain/conversationProvider'
import { useSuperbotHarness } from '../superbot/useSuperbotHarness'
import type { MessageReference } from '../../core/domain/codex'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApprovalRequest, UserInput } from '../../core/domain/codex'
import { recordWorkspaceContextDiagnostic, runtime } from '../../core/runtime/bridge'
import { DEFAULT_CLAUDE_SESSION_TITLE, useClaudeHarness } from '../claude/useClaudeHarness'
import { useHarness, type ThreadSelectionSource } from './useHarness'
import type { TurnCompletedEvent } from '../../core/conversations/types'
import { hasUnansweredAsyncInput } from './asyncUserInput'
import { isClaudeSessionWorking } from '../../core/claude/types'
import { completedTitleContext, titleNeedsResolvedContext } from './titleGenerator'

export type { ConversationProvider } from '../../core/domain/conversationProvider'
const SELECTED_CONVERSATION_KEY = 'selectedConversationId'

export interface ConversationCapabilities {
  images: boolean
  approvals: boolean
  interrupt: boolean
  resume: boolean
  queue: boolean
  steer: boolean
  fork: boolean
  skills: boolean
  mcpManagement: boolean
}

export function capabilitiesForProvider(provider: ConversationProvider): ConversationCapabilities {
  if (provider === 'superbot') return { images: true, approvals: false, interrupt: true, resume: true, queue: true, steer: true, fork: false, skills: false, mcpManagement: false }
  if (provider === 'claude') {
    return {
      images: true,
      approvals: true,
      interrupt: true,
      resume: true,
      queue: true,
      steer: true,
      fork: false,
      skills: false,
      mcpManagement: false,
    }
  }
  return {
    images: true,
    approvals: true,
    interrupt: true,
    resume: true,
    queue: true,
    steer: true,
    fork: true,
    skills: true,
    mcpManagement: true,
  }
}

export function shouldGenerateClaudeTitle(title: string, providerSessionId: string | null, active: boolean): boolean {
  return title === DEFAULT_CLAUDE_SESSION_TITLE && providerSessionId === null && !active
}

export function useUnifiedHarness() {
  const codex = useHarness()
  const claude = useClaudeHarness()
  const superbot = useSuperbotHarness(codex.viewMode === 'archived')
  const previousViewMode = useRef(codex.viewMode)
  const messageSubmittedListeners = useRef(new Set<(threadId: string) => void>())
  const onMessageSubmitted = useCallback((listener: (threadId: string) => void) => {
    messageSubmittedListeners.current.add(listener)
    return () => { messageSubmittedListeners.current.delete(listener) }
  }, [])
  const noteMessageSubmitted = useCallback((threadId: string) => {
    for (const listener of messageSubmittedListeners.current) listener(threadId)
  }, [])

  useEffect(() => {
    // Codex can also change the view internally when restoring/opening a thread.
    // Claude loads the active list on mount; refresh on every subsequent switch.
    if (previousViewMode.current === codex.viewMode) return
    previousViewMode.current = codex.viewMode
    void claude.refresh(codex.viewMode === 'archived').catch((error) => {
      codex.notify('无法读取 Claude 会话', 'error', error)
    })
  }, [claude.refresh, codex.notify, codex.viewMode])
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const previousCodexSelection = useRef<string | null>(null)
  const restoredSelection = useRef(false)
  const [newThreadProvider, setNewThreadProviderState] = useState<ConversationProvider>('codex')
  const selectedThreadIdRef = useRef<string | null>(null)
  const selectionRequestRef = useRef(0)
  const [pendingClaudeTitles, setPendingClaudeTitles] = useState<Record<string, { cwd: string; userText: string }>>({})

  useEffect(() => {
    for (const [sessionId, pending] of Object.entries(pendingClaudeTitles)) {
      const session = claude.sessions.find(candidate => candidate.id === sessionId)
      const turn = claude.details[sessionId]?.turns[0]
      if (!session || (session.title === DEFAULT_CLAUDE_SESSION_TITLE && (!turn || turn.status === 'inProgress'))) continue
      setPendingClaudeTitles(current => {
        const next = { ...current }
        delete next[sessionId]
        return next
      })
      const context = completedTitleContext(turn, claude.details[sessionId]?.items.filter(entry => entry.turnId === turn?.id).map(entry => entry.item))
      if (session.title === DEFAULT_CLAUDE_SESSION_TITLE && context) {
        void codex.generateConversationTitle(sessionId, pending.cwd, pending.userText, context)
          .then(title => title ? claude.applyGeneratedTitle(sessionId, title) : undefined)
          .catch(() => undefined)
      }
    }
  }, [claude.applyGeneratedTitle, claude.details, claude.sessions, codex.generateConversationTitle, pendingClaudeTitles])

  useEffect(() => { selectedThreadIdRef.current = selectedThreadId }, [selectedThreadId])

  const toggleNewThreadProvider = useCallback(() => {
    setNewThreadProviderState(current => nextConversationProvider(current, Boolean(claude.status?.available)))
  }, [claude.status?.available])

  useEffect(() => {
    if (!restoredSelection.current) return
    if (codex.selectedThreadId === previousCodexSelection.current) return
    recordWorkspaceContextDiagnostic({
      level: 'info',
      event: 'conversation.codex-selection.changed',
      threadId: codex.selectedThreadId ?? undefined,
      context: {
        source: 'useUnifiedHarness.codex-selection-effect',
        previousCodexThreadId: previousCodexSelection.current,
        codexSelectedThreadId: codex.selectedThreadId,
        unifiedSelectedThreadId: selectedThreadId,
        stateAligned: codex.selectedThreadId === selectedThreadId,
      },
    })
    previousCodexSelection.current = codex.selectedThreadId
    if (codex.selectedThreadId) {
      selectedThreadIdRef.current = codex.selectedThreadId
      setSelectedThreadId(codex.selectedThreadId)
      void runtime.setAppState(SELECTED_CONVERSATION_KEY, codex.selectedThreadId).catch(() => undefined)
    }
  }, [codex.selectedThreadId, selectedThreadId])

  useEffect(() => {
    if (restoredSelection.current || codex.phase !== 'ready' || !claude.loaded) return
    let disposed = false
    void (async () => {
      const remembered = await runtime.getAppState(SELECTED_CONVERSATION_KEY)
        ?? await runtime.getAppState('selectedThreadId')
      if (disposed || restoredSelection.current || (remembered?.startsWith('superbot:') && !superbot.loaded)) return
      recordWorkspaceContextDiagnostic({
        level: 'info',
        event: 'conversation.selection.restore-read',
        threadId: remembered ?? undefined,
        context: {
          source: 'useUnifiedHarness.restore',
          rememberedThreadId: remembered,
          codexSelectedThreadId: codex.selectedThreadId,
          unifiedSelectedThreadId: selectedThreadId,
          codexThreadFound: Boolean(remembered && codex.threads.some((thread) => thread.id === remembered)),
          superbotSessionFound: Boolean(remembered && superbot.threads.some(thread => thread.id === remembered)),
          claudeSessionFound: Boolean(remembered && claude.sessions.some((session) => session.id === remembered)),
        },
      })
      let restoreSource = 'fallback'
      if (remembered?.startsWith('superbot:') && superbot.threads.some(t => t.id === remembered)) {
        setSelectedThreadId(remembered)
        selectedThreadIdRef.current = remembered
        restoreSource = 'superbot-session'
      } else if (remembered?.startsWith('claude:') && claude.sessions.some((session) => session.id === remembered)) {
        claude.selectSession(remembered)
        selectedThreadIdRef.current = remembered
        setSelectedThreadId(remembered)
        restoreSource = 'claude-session'
      } else if (remembered && codex.threads.some((thread) => thread.id === remembered)) {
        selectedThreadIdRef.current = remembered
        setSelectedThreadId(remembered)
        restoreSource = 'codex-unified-state-only'
      } else {
        const fallback = codex.selectedThreadId ?? claude.sessions[0]?.id ?? null
        if (fallback?.startsWith('claude:')) claude.selectSession(fallback)
        selectedThreadIdRef.current = fallback
        setSelectedThreadId(fallback)
      }
      recordWorkspaceContextDiagnostic({
        level: 'info',
        event: 'conversation.selection.restored',
        threadId: remembered ?? undefined,
        context: {
          source: 'useUnifiedHarness.restore',
          restoreSource,
          rememberedThreadId: remembered,
          codexSelectedThreadId: codex.selectedThreadId,
          restoredUnifiedThreadId: remembered && (codex.threads.some((thread) => thread.id === remembered) || claude.sessions.some((session) => session.id === remembered) || superbot.threads.some(thread => thread.id === remembered))
            ? remembered
            : codex.selectedThreadId ?? claude.sessions[0]?.id ?? null,
          codexSelectThreadCalled: false,
        },
      })
      previousCodexSelection.current = codex.selectedThreadId
      restoredSelection.current = true
    })().catch(() => {
      if (disposed) return
      previousCodexSelection.current = codex.selectedThreadId
      selectedThreadIdRef.current = codex.selectedThreadId
      setSelectedThreadId(codex.selectedThreadId)
      restoredSelection.current = true
    })
    return () => { disposed = true }
  }, [superbot.loaded, superbot.threads, claude.loaded, claude.selectSession, claude.sessions, codex.phase, codex.selectedThreadId, codex.threads])

  const selectedProvider: ConversationProvider = selectedThreadId?.startsWith('superbot:') ? 'superbot' : selectedThreadId?.startsWith('claude:') ? 'claude' : 'codex'
  useEffect(() => { superbot.select(selectedProvider === 'superbot' ? selectedThreadId : null) }, [selectedProvider, selectedThreadId, superbot.select])
  const capabilities = useMemo(() => capabilitiesForProvider(selectedProvider), [selectedProvider])
  const onMessageAccepted = useCallback((listener: (threadId: string) => void) => {
    const disposeCodex = codex.onMessageAccepted(listener)
    const disposeClaude = claude.onMessageAccepted(listener)
    const disposeSuperbot = superbot.onMessageAccepted(listener)
    return () => { disposeCodex(); disposeClaude(); disposeSuperbot() }
  }, [claude.onMessageAccepted, codex.onMessageAccepted, superbot.onMessageAccepted])

  const onTurnCompleted = useCallback((listener: (event: TurnCompletedEvent) => void) => {
    const disposeCodex = codex.onTurnCompleted(listener)
    const disposeClaude = claude.onTurnCompleted(listener)
    return () => {
      disposeCodex()
      disposeClaude()
    }
  }, [claude.onTurnCompleted, codex.onTurnCompleted])
  const threads = useMemo(() => [...superbot.threads, ...claude.threads, ...codex.threads], [superbot.threads, claude.threads, codex.threads])
  const details = useMemo(() => ({ ...codex.details, ...claude.details }), [claude.details, codex.details])
  const approvals = useMemo(() => ({ ...codex.approvals, ...claude.approvals }), [claude.approvals, codex.approvals])
  const queues = useMemo(() => ({ ...codex.queues, ...claude.queues }), [claude.queues, codex.queues])
  const activeTurnIds = useMemo(() => ({ ...codex.activeTurnIds, ...claude.activeTurnIds, ...superbot.activeTurnIds }), [claude.activeTurnIds, codex.activeTurnIds, superbot.activeTurnIds])
  const claudeRoots = useMemo(
    () => Object.fromEntries(claude.sessions.map((session) => {
      // threadRoots is matched against Workspace.root in App.tsx; map the
      // session cwd (a checkout root) back to its workspace root when known.
      const root = codex.workspaces.find((workspace) => workspace.checkoutRoot === session.cwd)?.root ?? session.cwd
      return [session.id, root]
    })),
    [claude.sessions, codex.workspaces],
  )
  const claudeGitCwds = useMemo(
    () => Object.fromEntries(claude.sessions.map((session) => [session.id, session.cwd])),
    [claude.sessions],
  )
  const threadRoots = useMemo(() => ({ ...codex.threadRoots, ...claudeRoots }), [claudeRoots, codex.threadRoots])
  const threadGitCwds = useMemo(() => ({ ...codex.threadGitCwds, ...claudeGitCwds }), [claudeGitCwds, codex.threadGitCwds])
  const currentThread = threads.find((thread) => thread.id === selectedThreadId) ?? null
  const currentDetail = selectedThreadId ? details[selectedThreadId] ?? null : null
  const activeTurnId = selectedThreadId ? activeTurnIds[selectedThreadId] ?? currentDetail?.activeTurnId ?? null : null
  const workingThreadIds = useMemo(() => {
    const next: Record<string, boolean> = {}
    for (const threadId of Object.keys(activeTurnIds)) next[threadId] = true
    for (const threadId of Object.keys(codex.startingThreadIds)) next[threadId] = true
    for (const [threadId, activity] of Object.entries(claude.sessionActivities)) {
      if (isClaudeSessionWorking(activity)) next[threadId] = true
    }
    return next
  }, [activeTurnIds, claude.sessionActivities, codex.startingThreadIds])
  const waitingThreadIds = useMemo(() => {
    const next: Record<string, boolean> = {}
    for (const [threadId, requests] of Object.entries(approvals)) {
      if (requests.length > 0) next[threadId] = true
    }
    for (const [threadId, activity] of Object.entries(claude.sessionActivities)) {
      if (activity.state === 'requires_action') next[threadId] = true
    }
    for (const [threadId, detail] of Object.entries(codex.details)) {
      if (hasUnansweredAsyncInput(threadId, detail, codex.activeTurnIds[threadId], codex.pendingSteers[threadId])) next[threadId] = true
    }
    return next
  }, [approvals, claude.sessionActivities, codex.details, codex.activeTurnIds, codex.pendingSteers])

  const selectThread = useCallback(async (threadId: string, selectionSource: ThreadSelectionSource = 'unknown') => {
    restoredSelection.current = true
    const requestId = ++selectionRequestRef.current
    const previousThreadId = selectedThreadIdRef.current
    const previousThreadCwd = threads.find((thread) => thread.id === previousThreadId)?.cwd ?? null
    const selectedThreadCwd = threads.find((thread) => thread.id === threadId)?.cwd ?? null
    selectedThreadIdRef.current = threadId
    setSelectedThreadId(threadId)
    recordWorkspaceContextDiagnostic({
      level: 'info',
      event: 'conversation.selection.requested',
      threadId,
      context: {
        source: selectionSource,
        provider: threadId.startsWith('superbot:') ? 'superbot' : threadId.startsWith('claude:') ? 'claude' : 'codex',
        previousUnifiedThreadId: previousThreadId,
        previousThreadCwd,
        selectedThreadCwd,
        codexSelectedThreadIdBefore: codex.selectedThreadId,
      },
    })
    if (threadId.startsWith('superbot:')) {
      superbot.select(threadId)
    } else if (threadId.startsWith('claude:')) {
      if (!claude.sessions.some((session) => session.id === threadId)) await claude.refresh(false)
      claude.selectSession(threadId)
    }
    else await codex.selectThread(threadId, selectionSource)
    if (selectionRequestRef.current !== requestId || selectedThreadIdRef.current !== threadId) return
    recordWorkspaceContextDiagnostic({
      level: 'info',
      event: 'conversation.selection.completed',
      threadId,
      context: {
        source: selectionSource,
        provider: threadId.startsWith('superbot:') ? 'superbot' : threadId.startsWith('claude:') ? 'claude' : 'codex',
        codexSelectedThreadIdAfterCall: codex.selectedThreadId,
        selectionCallCompleted: true,
      },
    })
    void runtime.setAppState(SELECTED_CONVERSATION_KEY, threadId).catch(() => undefined)
  }, [claude, codex, superbot.select, threads])

  const openThread = useCallback((threadId: string) => selectThread(threadId, 'open-thread'), [selectThread])

  const createThread = useCallback(async (provider: ConversationProvider = 'codex', explicitCwd?: string) => {
    restoredSelection.current = true
    const requestId = ++selectionRequestRef.current
    if (provider === 'codex') {
      return codex.createThread(explicitCwd)
    }
    if (provider === 'superbot') {
      codex.setViewMode('active')
      try {
        const id = await superbot.create()
        if (selectionRequestRef.current !== requestId) return id
        selectedThreadIdRef.current = id
        setSelectedThreadId(id)
        void runtime.setAppState(SELECTED_CONVERSATION_KEY, id).catch(() => undefined)
        return id
      } catch (error) { codex.notify('无法创建 Superbot 会话', 'error', error); return undefined }
    }
    let cwd: string | undefined = explicitCwd ?? (currentThread?.cwd || undefined)
      ?? codex.workspaces.find((workspace) => workspace.root === codex.selectedWorkspaceRoot)?.checkoutRoot
      ?? codex.workspaces[0]?.checkoutRoot
    if (!cwd) cwd = (await codex.chooseWorkspace())?.checkoutRoot
    if (!cwd) return undefined
    const sessionCwd = cwd
    try {
      const id = await claude.createSession(sessionCwd)
      if (selectionRequestRef.current !== requestId) return undefined
      claude.selectSession(id)
      selectedThreadIdRef.current = id
      setSelectedThreadId(id)
      void runtime.setAppState(SELECTED_CONVERSATION_KEY, id).catch(() => undefined)
      return id
    } catch {
      // useClaudeHarness surfaces the actionable runtime error.
      return undefined
    }
  }, [claude, codex, currentThread?.cwd, superbot.create])

  const sendMessage = useCallback(async (input: UserInput[], mode: 'interject' | 'queue', references: MessageReference[] = [], titleSource?: string, targetThreadId?: string) => {
    const threadId = targetThreadId ?? selectedThreadId
    if (threadId?.startsWith('superbot:')) throw new Error('请在 Superbot 会话中发送文字消息')
    const provider = threadId?.startsWith('claude:') ? 'claude' : 'codex'
    if (threadId) noteMessageSubmitted(threadId)
    recordWorkspaceContextDiagnostic({
      level: 'info',
      event: 'conversation.message.dispatch',
      threadId: threadId ?? undefined,
      method: provider === 'claude' ? 'claude/turn/start' : 'turn/start',
      context: {
        source: 'useUnifiedHarness.sendMessage',
        provider,
        unifiedSelectedThreadId: selectedThreadId,
        codexSelectedThreadId: codex.selectedThreadId,
        stateAligned: selectedProvider === 'codex' ? selectedThreadId === codex.selectedThreadId : null,
        mode,
      },
    })
    if (provider === 'claude' && threadId) {
      const session = claude.sessions.find((candidate) => candidate.id === threadId)
      const userText = input
        .filter((item): item is Extract<UserInput, { type: 'text' }> => item.type === 'text')
        .map((item) => item.text)
        .join('\n')
      const shouldGenerateTitle = Boolean(session
        && userText.trim()
        && shouldGenerateClaudeTitle(session.title, session.providerSessionId, Boolean(claude.activeTurnIds[threadId])))
      if (!session || session.archived) throw new Error('目标会话已不可用，草稿已保留')
      await claude.sendMessage(threadId, input, mode)
      if (shouldGenerateTitle && session) {
        const source = titleSource ?? userText
        if (titleNeedsResolvedContext(source)) {
          setPendingClaudeTitles(current => ({ ...current, [session.id]: { cwd: session.cwd, userText: source } }))
        } else {
          void codex.generateConversationTitle(session.id, session.cwd, source)
            .then((title) => title ? claude.applyGeneratedTitle(session.id, title) : undefined)
            .catch(() => undefined)
        }
      }
      return
    }
    return codex.sendMessage(input, mode, references, titleSource, threadId ?? undefined)
  }, [claude, codex, noteMessageSubmitted, selectedProvider, selectedThreadId])

  const stopTurn = useCallback(() => {
    if (selectedProvider === 'superbot') return superbot.stop(selectedThreadId!)
    if (selectedProvider === 'claude' && selectedThreadId) return claude.stopTurn(selectedThreadId)
    return codex.stopTurn()
  }, [claude, codex, selectedProvider, selectedThreadId, superbot.stop])

  const editQueue = useCallback((queueId: string, text: string) => {
    if (selectedProvider === 'superbot') return undefined
    if (selectedProvider === 'claude' && selectedThreadId) return claude.editQueue(selectedThreadId, queueId, text)
    return codex.editQueue(queueId, text)
  }, [claude, codex, selectedProvider, selectedThreadId])

  const removeQueue = useCallback((queueId: string) => {
    if (selectedProvider === 'superbot') return undefined
    if (selectedProvider === 'claude' && selectedThreadId) return claude.removeQueue(selectedThreadId, queueId)
    return codex.removeQueue(queueId)
  }, [claude, codex, selectedProvider, selectedThreadId])

  const promoteQueue = useCallback((queue: Parameters<typeof codex.promoteQueue>[0]) => {
    if (selectedProvider === 'superbot') return undefined
    if (selectedProvider === 'claude' && selectedThreadId) return claude.promoteQueue(selectedThreadId, queue)
    return codex.promoteQueue(queue)
  }, [claude, codex, selectedProvider, selectedThreadId])

  const startQueue = useCallback(() => {
    if (selectedProvider === 'superbot') return undefined
    if (selectedProvider === 'claude' && selectedThreadId) return claude.startQueue(selectedThreadId)
    return codex.startQueue()
  }, [claude, codex, selectedProvider, selectedThreadId])

  const renameThread = useCallback((threadId: string, name: string) => threadId.startsWith('superbot:') ? superbot.rename(threadId, name) : threadId.startsWith('claude:')
    ? claude.renameSession(threadId, name)
    : codex.renameThread(threadId, name), [claude, codex, superbot.rename])

  const archiveThread = useCallback(async (threadId: string, fromAssistant = false) => {
    if (threadId.startsWith('superbot:')) await superbot.archive(threadId, true)
    else if (threadId.startsWith('claude:')) await claude.archiveSession(threadId)
    else if (fromAssistant) await codex.archiveThread(threadId, true)
    else await codex.archiveThread(threadId)
    if (selectedThreadIdRef.current === threadId) { selectedThreadIdRef.current = null; setSelectedThreadId(null) }
  }, [claude, codex, superbot.archive])

  const unarchiveThread = useCallback(async (threadId: string) => {
    if (threadId.startsWith('superbot:')) await superbot.archive(threadId, false)
    else if (threadId.startsWith('claude:')) await claude.unarchiveSession(threadId)
    else await codex.unarchiveThread(threadId)
    if (selectedThreadId === threadId) { selectedThreadIdRef.current = null; setSelectedThreadId(null) }
  }, [claude, codex, selectedThreadId, superbot.archive])

  const answerApproval = useCallback((request: ApprovalRequest, decision: unknown) => request.method.startsWith('claude/')
    ? claude.answerApproval(request, decision)
    : codex.answerApproval(request, decision), [claude, codex])

  const prepareRemoteThread = useCallback(async (threadId: string) => threadId.startsWith('superbot:') ? false : threadId.startsWith('claude:')
    ? true : codex.prepareRemoteThread(threadId), [codex.prepareRemoteThread])
  const sendRemoteMessage = useCallback(async (threadId: string, text: string) => {
    if (threadId.startsWith('superbot:')) throw new Error('Superbot 暂不支持 SeaTalk 续聊')
    if (threadId.startsWith('claude:')) await claude.sendMessage(threadId, [{ type: 'text', text, text_elements: [] }], 'queue')
    else await codex.sendRemoteMessage(threadId, text)
    noteMessageSubmitted(threadId)
  }, [claude.sendMessage, codex.sendRemoteMessage, noteMessageSubmitted])
  const stopRemoteTurn = useCallback(async (threadId: string) => {
    if (threadId.startsWith('superbot:')) throw new Error('请在 Superbot 会话停止任务')
    if (threadId.startsWith('claude:')) await claude.stopTurn(threadId, true)
    else await codex.stopRemoteTurn(threadId)
  }, [claude.stopTurn, codex.stopRemoteTurn])
  const answerRemoteApproval = useCallback(async (request: ApprovalRequest, decision: unknown) => {
    if (request.method.startsWith('claude/')) await claude.answerApproval(request, decision, true)
    else await codex.answerApproval(request, decision, true)
  }, [claude.answerApproval, codex.answerApproval])

  const refresh = useCallback(async () => {
    await Promise.all([codex.refresh(), claude.refresh(codex.viewMode === 'archived'), superbot.refresh().catch(() => undefined)])
  }, [claude, codex, superbot.refresh])

  const resetThread = useCallback(async () => {
    if (selectedProvider === 'superbot') await createThread('superbot')
    else if (selectedProvider === 'claude') await createThread('claude')
    else await codex.resetThread()
  }, [codex, createThread, selectedProvider])

  const busy: Record<string, boolean> = {
    ...codex.busy,
    ...(selectedProvider === 'claude' ? claude.busy : {}),
    ...(selectedProvider === 'superbot' ? { createThread: superbot.busy } : {}),
    composer: selectedProvider === 'claude'
      ? Boolean(claude.busy.composer)
      : selectedThreadId === codex.selectedThreadId && codex.busy.composer,
    workspaceRouter: selectedThreadId === codex.selectedThreadId && codex.busy.workspaceRouter,
  }

  return {
    ...codex,
    superbot,
    threads,
    details,
    approvals,
    activeTurnIds,
    workingThreadIds,
    waitingThreadIds,
    threadRoots,
    threadGitCwds,
    selectedThreadId,
    currentThread,
    currentDetail,
    activeTurnId,
    selectedProvider,
    onTurnCompleted,
    onMessageAccepted,
    onMessageSubmitted,
    newThreadProvider,
    toggleNewThreadProvider,
    capabilities,
    claudeStatus: claude.status,
    currentTokenUsage: selectedProvider === 'superbot' ? null : selectedProvider === 'claude' ? currentDetail?.tokenUsage ?? null : codex.currentTokenUsage,
    currentCostUsd: selectedProvider === 'superbot' ? null : selectedProvider === 'claude' ? currentDetail?.costUsd ?? null : null,
    currentTaskPlan: selectedProvider === 'superbot' ? null : selectedProvider === 'claude' ? null : codex.currentTaskPlan,
    currentForeignActive: selectedProvider !== 'codex' ? false : codex.currentForeignActive,
    isCurrentWorking: Boolean(activeTurnId || (selectedThreadId && workingThreadIds[selectedThreadId])),
    isCurrentBackgroundWorking: selectedProvider === 'claude' && !activeTurnId
      && isClaudeSessionWorking(claude.sessionActivities[selectedThreadId ?? '']),
    busy,
    queues,
    pendingSteers: selectedProvider === 'claude' && selectedThreadId ? { ...codex.pendingSteers, [selectedThreadId]: [] } : codex.pendingSteers,
    selectThread,
    openThread,
    createThread,
    resetThread,
    sendMessage,
    prepareRemoteThread,
    sendRemoteMessage,
    stopRemoteTurn,
    answerRemoteApproval,
    stopTurn,
    editQueue,
    removeQueue,
    promoteQueue,
    startQueue,
    claudeModels: claude.models,
    claudeSettingsForThread: claude.settingsForSession,
    updateClaudeSettings: claude.updateSessionSettings,
    renameThread,
    archiveThread,
    unarchiveThread,
    answerApproval,
    refresh,
    loadOlderTurns: selectedProvider !== 'codex' ? async () => undefined : codex.loadOlderTurns,
    forkThreadAtTurn: selectedProvider !== 'codex' ? async () => undefined : codex.forkThreadAtTurn,
    continueAfterFailure: selectedProvider !== 'codex' ? async () => undefined : codex.continueAfterFailure,
    changeThreadWorkspace: selectedProvider === 'superbot' ? async () => { throw new Error('云端会话没有本机工作区') } : selectedProvider === 'claude'
      ? async (threadId: string, workspaceRoot: string) => { await claude.changeSessionWorkspace(threadId, workspaceRoot) }
      : codex.changeThreadWorkspace,
    setThreadDraftContent: selectedProvider !== 'codex' ? () => undefined : codex.setThreadDraftContent,
    searchThreads: async (term: string) => {
      await codex.searchThreads(term)
      await claude.refresh(codex.viewMode === 'archived')
    },
  }
}
