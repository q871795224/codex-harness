import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApprovalRequest, UserInput } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { useClaudeHarness } from '../claude/useClaudeHarness'
import { useHarness } from './useHarness'

export type ConversationProvider = 'codex' | 'claude'

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
      queue: false,
      steer: false,
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

  useEffect(() => {
    if (codex.selectedThreadId === previousCodexSelection.current) return
    previousCodexSelection.current = codex.selectedThreadId
    if (codex.selectedThreadId) setSelectedThreadId(codex.selectedThreadId)
  }, [codex.selectedThreadId])

  useEffect(() => {
    if (restoredSelection.current || codex.phase !== 'ready' || !claude.status) return
    restoredSelection.current = true
    void runtime.getAppState('selectedThreadId').then((remembered) => {
      if (!remembered || !claude.sessions.some((session) => session.id === remembered)) return
      claude.selectSession(remembered)
      setSelectedThreadId(remembered)
    }).catch(() => undefined)
  }, [claude, codex.phase])

  const selectedProvider: ConversationProvider = selectedThreadId?.startsWith('claude:') ? 'claude' : 'codex'
  const capabilities = useMemo(() => capabilitiesForProvider(selectedProvider), [selectedProvider])
  const threads = useMemo(() => [...claude.threads, ...codex.threads], [claude.threads, codex.threads])
  const details = useMemo(() => ({ ...codex.details, ...claude.details }), [claude.details, codex.details])
  const approvals = useMemo(() => ({ ...codex.approvals, ...claude.approvals }), [claude.approvals, codex.approvals])
  const activeTurnIds = useMemo(() => ({ ...codex.activeTurnIds, ...claude.activeTurnIds }), [claude.activeTurnIds, codex.activeTurnIds])
  const claudeRoots = useMemo(
    () => Object.fromEntries(claude.sessions.map((session) => [session.id, session.cwd])),
    [claude.sessions],
  )
  const threadRoots = useMemo(() => ({ ...codex.threadRoots, ...claudeRoots }), [claudeRoots, codex.threadRoots])
  const threadGitCwds = useMemo(() => ({ ...codex.threadGitCwds, ...claudeRoots }), [claudeRoots, codex.threadGitCwds])
  const currentThread = threads.find((thread) => thread.id === selectedThreadId) ?? null
  const currentDetail = selectedThreadId ? details[selectedThreadId] ?? null : null
  const activeTurnId = selectedThreadId ? activeTurnIds[selectedThreadId] ?? currentDetail?.activeTurnId ?? null : null

  const selectThread = useCallback(async (threadId: string) => {
    if (threadId.startsWith('claude:')) claude.selectSession(threadId)
    else await codex.selectThread(threadId)
    setSelectedThreadId(threadId)
    void runtime.setAppState('selectedThreadId', threadId).catch(() => undefined)
  }, [claude, codex])

  const createThread = useCallback(async (provider: ConversationProvider = 'codex') => {
    if (provider === 'codex') {
      await codex.createThread()
      return
    }
    let cwd: string | undefined = currentThread?.cwd
      ?? codex.workspaces.find((workspace) => workspace.root === codex.selectedWorkspaceRoot)?.checkoutRoot
      ?? codex.workspaces[0]?.checkoutRoot
    if (!cwd) cwd = (await codex.chooseWorkspace())?.checkoutRoot
    if (!cwd) return
    const sessionCwd = cwd
    try {
      const id = await claude.createSession(sessionCwd)
      claude.selectSession(id)
      setSelectedThreadId(id)
      void runtime.setAppState('selectedThreadId', id).catch(() => undefined)
    } catch {
      // useClaudeHarness surfaces the actionable runtime error.
    }
  }, [claude, codex, currentThread?.cwd])

  const sendMessage = useCallback((input: UserInput[], mode: 'interject' | 'queue') => {
    if (selectedProvider === 'claude' && selectedThreadId) return claude.sendMessage(selectedThreadId, input)
    return codex.sendMessage(input, mode)
  }, [claude, codex, selectedProvider, selectedThreadId])

  const stopTurn = useCallback(() => {
    if (selectedProvider === 'claude' && selectedThreadId) return claude.stopTurn(selectedThreadId)
    return codex.stopTurn()
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
    threadRoots,
    threadGitCwds,
    selectedThreadId,
    currentThread,
    currentDetail,
    activeTurnId,
    selectedProvider,
    capabilities,
    claudeStatus: claude.status,
    currentTokenUsage: selectedProvider === 'claude' ? null : codex.currentTokenUsage,
    currentTaskPlan: selectedProvider === 'claude' ? null : codex.currentTaskPlan,
    currentForeignActive: selectedProvider === 'claude' ? false : codex.currentForeignActive,
    isCurrentWorking: Boolean(activeTurnId),
    busy: selectedProvider === 'claude' ? { ...codex.busy, ...claude.busy } : codex.busy,
    toast: claude.toast ?? codex.toast,
    queues: selectedProvider === 'claude' && selectedThreadId ? { ...codex.queues, [selectedThreadId]: [] } : codex.queues,
    pendingSteers: selectedProvider === 'claude' && selectedThreadId ? { ...codex.pendingSteers, [selectedThreadId]: [] } : codex.pendingSteers,
    selectThread,
    openThread: selectThread,
    createThread,
    resetThread,
    sendMessage,
    stopTurn,
    renameThread,
    archiveThread,
    unarchiveThread,
    answerApproval,
    setViewMode,
    refresh,
    loadOlderTurns: selectedProvider === 'claude' ? async () => undefined : codex.loadOlderTurns,
    forkThreadAtTurn: selectedProvider === 'claude' ? async () => undefined : codex.forkThreadAtTurn,
    continueAfterFailure: selectedProvider === 'claude' ? async () => undefined : codex.continueAfterFailure,
    changeThreadWorkspace: selectedProvider === 'claude' ? async () => undefined : codex.changeThreadWorkspace,
    setThreadDraftContent: selectedProvider === 'claude' ? () => undefined : codex.setThreadDraftContent,
    searchThreads: async (term: string) => {
      await codex.searchThreads(term)
      await claude.refresh(codex.viewMode === 'archived')
    },
  }
}
