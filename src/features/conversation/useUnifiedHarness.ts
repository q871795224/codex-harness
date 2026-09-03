import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApprovalRequest, UserInput } from '../../core/domain/codex'
import { recordWorkspaceContextDiagnostic, runtime } from '../../core/runtime/bridge'
import { useClaudeHarness } from '../claude/useClaudeHarness'
import { useHarness, type ThreadSelectionSource } from './useHarness'
import type { TurnCompletedEvent } from '../../core/conversations/types'

export type ConversationProvider = 'codex' | 'claude'
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

export function useUnifiedHarness() {
  const codex = useHarness()
  const claude = useClaudeHarness()
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const previousCodexSelection = useRef<string | null>(null)
  const restoredSelection = useRef(false)
  const [newThreadProvider, setNewThreadProviderState] = useState<ConversationProvider>('codex')
  const selectedThreadIdRef = useRef<string | null>(null)
  const selectionRequestRef = useRef(0)

  useEffect(() => { selectedThreadIdRef.current = selectedThreadId }, [selectedThreadId])

  const toggleNewThreadProvider = useCallback(() => {
    setNewThreadProviderState((current) => {
      if (current === 'codex') return claude.status?.available ? 'claude' : current
      return 'codex'
    })
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
      if (disposed) return
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
          claudeSessionFound: Boolean(remembered && claude.sessions.some((session) => session.id === remembered)),
        },
      })
      let restoreSource = 'fallback'
      if (remembered?.startsWith('claude:') && claude.sessions.some((session) => session.id === remembered)) {
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
          restoredUnifiedThreadId: remembered && (codex.threads.some((thread) => thread.id === remembered) || claude.sessions.some((session) => session.id === remembered))
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
  }, [claude.loaded, claude.selectSession, claude.sessions, codex.phase, codex.selectedThreadId, codex.threads])

  const selectedProvider: ConversationProvider = selectedThreadId?.startsWith('claude:') ? 'claude' : 'codex'
  const capabilities = useMemo(() => capabilitiesForProvider(selectedProvider), [selectedProvider])
  const onTurnCompleted = useCallback((listener: (event: TurnCompletedEvent) => void) => {
    const disposeCodex = codex.onTurnCompleted(listener)
    const disposeClaude = claude.onTurnCompleted(listener)
    return () => {
      disposeCodex()
      disposeClaude()
    }
  }, [claude.onTurnCompleted, codex.onTurnCompleted])
  const threads = useMemo(() => [...claude.threads, ...codex.threads], [claude.threads, codex.threads])
  const details = useMemo(() => ({ ...codex.details, ...claude.details }), [claude.details, codex.details])
  const approvals = useMemo(() => ({ ...codex.approvals, ...claude.approvals }), [claude.approvals, codex.approvals])
  const activeTurnIds = useMemo(() => ({ ...codex.activeTurnIds, ...claude.activeTurnIds }), [claude.activeTurnIds, codex.activeTurnIds])
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
    return next
  }, [activeTurnIds, codex.startingThreadIds])

  const selectThread = useCallback(async (threadId: string, selectionSource: ThreadSelectionSource = 'unknown') => {
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
        provider: threadId.startsWith('claude:') ? 'claude' : 'codex',
        previousUnifiedThreadId: previousThreadId,
        previousThreadCwd,
        selectedThreadCwd,
        codexSelectedThreadIdBefore: codex.selectedThreadId,
      },
    })
    if (threadId.startsWith('claude:')) {
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
        provider: threadId.startsWith('claude:') ? 'claude' : 'codex',
        codexSelectedThreadIdAfterCall: codex.selectedThreadId,
        selectionCallCompleted: true,
      },
    })
    void runtime.setAppState(SELECTED_CONVERSATION_KEY, threadId).catch(() => undefined)
  }, [claude, codex, threads])

  const openThread = useCallback((threadId: string) => selectThread(threadId, 'open-thread'), [selectThread])

  const createThread = useCallback(async (provider: ConversationProvider = 'codex') => {
    const requestId = ++selectionRequestRef.current
    if (provider === 'codex') {
      return codex.createThread()
    }
    let cwd: string | undefined = currentThread?.cwd
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
  }, [claude, codex, currentThread?.cwd])

  const sendMessage = useCallback((input: UserInput[], mode: 'interject' | 'queue') => {
    recordWorkspaceContextDiagnostic({
      level: 'info',
      event: 'conversation.message.dispatch',
      threadId: selectedThreadId ?? undefined,
      method: selectedProvider === 'claude' ? 'claude/turn/start' : 'turn/start',
      context: {
        source: 'useUnifiedHarness.sendMessage',
        provider: selectedProvider,
        unifiedSelectedThreadId: selectedThreadId,
        codexSelectedThreadId: codex.selectedThreadId,
        stateAligned: selectedProvider === 'codex' ? selectedThreadId === codex.selectedThreadId : null,
        mode,
      },
    })
    if (selectedProvider === 'claude' && selectedThreadId) return claude.sendMessage(selectedThreadId, input, mode)
    return codex.sendMessage(input, mode)
  }, [claude, codex, selectedProvider, selectedThreadId])

  const stopTurn = useCallback(() => {
    if (selectedProvider === 'claude' && selectedThreadId) return claude.stopTurn(selectedThreadId)
    return codex.stopTurn()
  }, [claude, codex, selectedProvider, selectedThreadId])

  const editQueue = useCallback((queueId: string, text: string) => {
    if (selectedProvider === 'claude' && selectedThreadId) return claude.editQueue(selectedThreadId, queueId, text)
    return codex.editQueue(queueId, text)
  }, [claude, codex, selectedProvider, selectedThreadId])

  const removeQueue = useCallback((queueId: string) => {
    if (selectedProvider === 'claude' && selectedThreadId) return claude.removeQueue(selectedThreadId, queueId)
    return codex.removeQueue(queueId)
  }, [claude, codex, selectedProvider, selectedThreadId])

  const promoteQueue = useCallback((queue: Parameters<typeof codex.promoteQueue>[0]) => {
    if (selectedProvider === 'claude' && selectedThreadId) return claude.promoteQueue(selectedThreadId, queue)
    return codex.promoteQueue(queue)
  }, [claude, codex, selectedProvider, selectedThreadId])

  const startQueue = useCallback(() => {
    if (selectedProvider === 'claude' && selectedThreadId) return claude.startQueue(selectedThreadId)
    return codex.startQueue()
  }, [claude, codex, selectedProvider, selectedThreadId])

  const renameThread = useCallback((threadId: string, name: string) => threadId.startsWith('claude:')
    ? claude.renameSession(threadId, name)
    : codex.renameThread(threadId, name), [claude, codex])

  const archiveThread = useCallback(async (threadId: string) => {
    if (threadId.startsWith('claude:')) await claude.archiveSession(threadId)
    else await codex.archiveThread(threadId)
    if (selectedThreadId === threadId) setSelectedThreadId(null)
  }, [claude, codex, selectedThreadId])

  const unarchiveThread = useCallback(async (threadId: string) => {
    if (threadId.startsWith('claude:')) await claude.unarchiveSession(threadId)
    else await codex.unarchiveThread(threadId)
    if (selectedThreadId === threadId) setSelectedThreadId(null)
  }, [claude, codex, selectedThreadId])

  const answerApproval = useCallback((request: ApprovalRequest, decision: unknown) => request.method.startsWith('claude/')
    ? claude.answerApproval(request, decision)
    : codex.answerApproval(request, decision), [claude, codex])

  const setViewMode = useCallback(async (mode: 'active' | 'archived') => {
    await Promise.all([codex.setViewMode(mode), claude.refresh(mode === 'archived')])
  }, [claude, codex])

  const refresh = useCallback(async () => {
    await Promise.all([codex.refresh(), claude.refresh(codex.viewMode === 'archived')])
  }, [claude, codex])

  const resetThread = useCallback(async () => {
    if (selectedProvider === 'claude') await createThread('claude')
    else await codex.resetThread()
  }, [codex, createThread, selectedProvider])

  return {
    ...codex,
    threads,
    details,
    approvals,
    activeTurnIds,
    workingThreadIds,
    threadRoots,
    threadGitCwds,
    selectedThreadId,
    currentThread,
    currentDetail,
    activeTurnId,
    selectedProvider,
    onTurnCompleted,
    newThreadProvider,
    toggleNewThreadProvider,
    capabilities,
    claudeStatus: claude.status,
    currentTokenUsage: selectedProvider === 'claude' ? currentDetail?.tokenUsage ?? null : codex.currentTokenUsage,
    currentCostUsd: selectedProvider === 'claude' ? currentDetail?.costUsd ?? null : null,
    currentTaskPlan: selectedProvider === 'claude' ? null : codex.currentTaskPlan,
    currentForeignActive: selectedProvider === 'claude' ? false : codex.currentForeignActive,
    isCurrentWorking: Boolean(activeTurnId || (selectedThreadId && codex.startingThreadIds[selectedThreadId])),
    busy: selectedProvider === 'claude' ? { ...codex.busy, ...claude.busy } : codex.busy,
    toast: claude.toast ?? codex.toast,
    queues: selectedProvider === 'claude' ? claude.queues : codex.queues,
    pendingSteers: selectedProvider === 'claude' && selectedThreadId ? { ...codex.pendingSteers, [selectedThreadId]: [] } : codex.pendingSteers,
    selectThread,
    openThread,
    createThread,
    resetThread,
    sendMessage,
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
    setViewMode,
    refresh,
    loadOlderTurns: selectedProvider === 'claude' ? async () => undefined : codex.loadOlderTurns,
    forkThreadAtTurn: selectedProvider === 'claude' ? async () => undefined : codex.forkThreadAtTurn,
    continueAfterFailure: selectedProvider === 'claude' ? async () => undefined : codex.continueAfterFailure,
    changeThreadWorkspace: selectedProvider === 'claude'
      ? async (threadId: string, workspaceRoot: string) => { await claude.changeSessionWorkspace(threadId, workspaceRoot) }
      : codex.changeThreadWorkspace,
    setThreadDraftContent: selectedProvider === 'claude' ? () => undefined : codex.setThreadDraftContent,
    searchThreads: async (term: string) => {
      await codex.searchThreads(term)
      await claude.refresh(codex.viewMode === 'archived')
    },
  }
}
