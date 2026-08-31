import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppServerEvent,
  AppearancePreferences,
  ApprovalRequest,
  Badge,
  FollowUpMode,
  FontSize,
  FontSizeArea,
  JsonObject,
  KeyboardPreferences,
  HarnessActionId,
  NavigationLayout,
  NavigationPreferences,
  PendingSteer,
  QueuedSubmission,
  Thread,
  ThreadDetail,
  ThreadSort,
  ThreadTokenUsage,
  TurnPlanStep,
  ThreadUiState,
  Theme,
  ThreadTitleGenerationSettings,
  Turn,
  UserInput,
  Workspace,
  WorkspaceSort,
  SendShortcut,
} from '../../core/domain/codex'
import { yoloModeSettings } from '../codex/yoloMode'
import {
  DEFAULT_THREAD_TITLE_GENERATION,
  defaultFontSizePreferences,
  emptyThreadDetail,
  isActive,
  itemText,
  normalizeFontSize,
  normalizeFollowUpMode,
  normalizeSendShortcut,
  normalizeSidebarWidth,
  normalizeTheme,
  parseGeneratedThreadTitle,
  rebaseSandboxPolicy,
  textInput,
  threadTitle,
  touchThreadActivity,
  threadsOlderThan,
  withInitialThreadPreview,
} from '../../core/domain/codex'
import type { TurnCompletedEvent } from '../../core/conversations/types'
import { diagnosticErrorCode, runtime, type ClientDiagnostic } from '../../core/runtime/bridge'
import { appServer, type StartThreadResponse } from '../../core/runtime/appServerClient'
import { defaultHarnessActionShortcuts } from '../actions/harnessActions'
import {
  defaultConversationStatsPreferences,
  normalizeConversationStatsPreferences,
  type ConversationStatsPreferences,
} from './conversationStatsConfig'
import {
  activateTurn,
  completeTurn,
  deriveForeignActive,
  ownsStartedTurn,
  syncResumedTurn,
  type ActiveTurnOwnership,
} from './turnOwnership'
import { reduceThreadDetailEvent } from './conversationEventReducer'
import {
  eventPermissionProfile,
  eventSandboxPolicy,
  eventThreadId,
  eventThreadItem,
  eventThreadSettings,
  parseEventTokenUsage,
  parseEventTurnPlan,
} from './conversationEventParser'
import { approvalResponse, isApprovalRequestMethod } from './approvalFlow'
import {
  APPEARANCE_PREFERENCES_KEY,
  CONVERSATION_STATS_PREFERENCES_KEY,
  defaultAppearancePreferences,
  defaultKeyboardPreferences,
  defaultNavigationPreferences,
  KEYBOARD_PREFERENCES_KEY,
  loadHarnessBootstrap,
  NAVIGATION_PREFERENCES_KEY,
  THREAD_TITLE_GENERATION_KEY,
  togglePinnedIdentifier,
} from './harnessBootstrap'
import {
  isFirstUserTurn,
  resolveNewThreadWorkspaceRoot,
  resumedThreadDetail,
  runtimeThreadSettings,
  shouldDiscardDraftThread,
  startedThreadDetail,
  threadPermissionOverrides,
  threadTitlePrompt,
  threadTurnContext,
  turnStartRequest,
} from './threadLifecycle'
import { promoteQueuedSubmission, restartInputs, submitActiveTurnInput } from './turnQueue'

export { parseThreadTitleGenerationSettings } from './harnessBootstrap'

type ViewMode = 'active' | 'archived'

interface TitleGenerator {
  targetThreadId: string
  attemptId: string
  text: string
  startedAt: number
}

interface HookToast {
  kind: 'error' | 'info'
  message: string
}

function newClientId(): string {
  return crypto.randomUUID()
}

function recordTitleDiagnostic(diagnostic: Omit<ClientDiagnostic, 'area'>): void {
  void runtime.recordClientDiagnostic({ area: 'thread-title', ...diagnostic }).catch(() => undefined)
}

function isMissingRollout(error: unknown): boolean {
  return messageOf(error).toLowerCase().includes('no rollout found')
}

export function useHarness() {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [bootError, setBootError] = useState<string | null>(null)
  const [threads, setThreads] = useState<Thread[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [threadRoots, setThreadRoots] = useState<Record<string, string | null>>({})
  const [threadGitCwds, setThreadGitCwds] = useState<Record<string, string>>({})
  const [threadStates, setThreadStates] = useState<Record<string, ThreadUiState>>({})
  const [details, setDetails] = useState<Record<string, ThreadDetail>>({})
  const [threadTokenUsages, setThreadTokenUsages] = useState<Record<string, ThreadTokenUsage>>({})
  const [threadPlans, setThreadPlans] = useState<Record<string, TurnPlanStep[]>>({})
  const [navigation, setNavigation] = useState<NavigationPreferences>(defaultNavigationPreferences)
  const [appearance, setAppearance] = useState<AppearancePreferences>(defaultAppearancePreferences)
  const [keyboard, setKeyboard] = useState<KeyboardPreferences>(defaultKeyboardPreferences)
  const [conversationStats, setConversationStatsState] = useState<ConversationStatsPreferences>(defaultConversationStatsPreferences)
  const [threadTitleGeneration, setThreadTitleGenerationState] = useState<ThreadTitleGenerationSettings>(DEFAULT_THREAD_TITLE_GENERATION)
  const [queues, setQueues] = useState<Record<string, QueuedSubmission[]>>({})
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest[]>>({})
  const [pendingSteers, setPendingSteers] = useState<Record<string, PendingSteer[]>>({})
  const [activeTurnIds, setActiveTurnIds] = useState<Record<string, string>>({})
  const [ownedActiveThreads, setOwnedActiveThreads] = useState<Record<string, boolean>>({})
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [selectedWorkspaceRoot, setSelectedWorkspaceRoot] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('active')
  const [toast, setToast] = useState<HookToast | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [forkingTurnId, setForkingTurnId] = useState<string | null>(null)

  const selectedThreadIdRef = useRef<string | null>(null)
  const threadsRef = useRef<Thread[]>([])
  const pendingRestartRef = useRef<Record<string, PendingSteer[]>>({})
  const continuingFailedThreadsRef = useRef(new Set<string>())
  const locallyStartingRef = useRef(new Set<string>())
  const unstartedDraftThreadIdsRef = useRef(new Set<string>())
  const draftContentThreadIdsRef = useRef(new Set<string>())
  const activeTurnIdsRef = useRef<Record<string, string>>({})
  const ownedActiveThreadsRef = useRef<Record<string, boolean>>({})
  const approvalsRef = useRef<Record<string, ApprovalRequest[]>>({})
  const detailsRef = useRef<Record<string, ThreadDetail>>({})
  const threadMappingVersionsRef = useRef<Record<string, number>>({})
  const generatingTitlesRef = useRef(new Set<string>())
  const attemptedTitleThreadsRef = useRef(new Set<string>())
  const titleGeneratorsRef = useRef(new Map<string, TitleGenerator>())
  const threadTitleGenerationRef = useRef(threadTitleGeneration)
  const turnCompletedListenersRef = useRef(new Set<(event: TurnCompletedEvent) => void>())

  useEffect(() => { selectedThreadIdRef.current = selectedThreadId }, [selectedThreadId])
  useEffect(() => { threadsRef.current = threads }, [threads])
  useEffect(() => { approvalsRef.current = approvals }, [approvals])
  useEffect(() => { detailsRef.current = details }, [details])
  useEffect(() => { threadTitleGenerationRef.current = threadTitleGeneration }, [threadTitleGeneration])

  const onTurnCompleted = useCallback((listener: (event: TurnCompletedEvent) => void) => {
    turnCompletedListenersRef.current.add(listener)
    return () => { turnCompletedListenersRef.current.delete(listener) }
  }, [])

  const commitTurnOwnership = useCallback((next: ActiveTurnOwnership) => {
    activeTurnIdsRef.current = next.activeTurnIds
    ownedActiveThreadsRef.current = next.ownedActiveThreads
    setActiveTurnIds(next.activeTurnIds)
    setOwnedActiveThreads(next.ownedActiveThreads)
  }, [])

  const notify = useCallback((message: string, kind: HookToast['kind'] = 'info') => {
    setToast({ message, kind })
  }, [])

  const updateNavigation = useCallback((change: (current: NavigationPreferences) => NavigationPreferences) => {
    setNavigation((current) => {
      const next = change(current)
      void runtime.setAppState(NAVIGATION_PREFERENCES_KEY, JSON.stringify(next)).catch(() => undefined)
      return next
    })
  }, [])

  const setNavigationLayout = useCallback((layout: NavigationLayout) => {
    updateNavigation((current) => ({ ...current, layout }))
  }, [updateNavigation])

  const setThreadSort = useCallback((sort: ThreadSort) => {
    updateNavigation((current) => ({ ...current, sort }))
  }, [updateNavigation])

  const setWorkspaceSort = useCallback((workspaceSort: WorkspaceSort) => {
    updateNavigation((current) => ({ ...current, workspaceSort }))
  }, [updateNavigation])

  const setSidebarWidth = useCallback((sidebarWidth: number) => {
    updateNavigation((current) => ({ ...current, sidebarWidth: normalizeSidebarWidth(sidebarWidth) }))
  }, [updateNavigation])

  const setSidebarCollapsed = useCallback((sidebarCollapsed: boolean) => {
    updateNavigation((current) => ({ ...current, sidebarCollapsed }))
  }, [updateNavigation])

  const setManualThreadOrder = useCallback((manualThreadOrder: string[]) => {
    updateNavigation((current) => ({
      ...current,
      manualThreadOrder: [...new Set(manualThreadOrder.filter((id) => Boolean(id)))].slice(0, 500),
    }))
  }, [updateNavigation])

  const toggleThreadPinned = useCallback((threadId: string) => {
    updateNavigation((current) => ({
      ...current,
      pinnedThreadIds: togglePinnedIdentifier(current.pinnedThreadIds, threadId),
    }))
  }, [updateNavigation])

  const toggleWorkspacePinned = useCallback((workspaceRoot: string) => {
    updateNavigation((current) => ({
      ...current,
      pinnedWorkspaceRoots: togglePinnedIdentifier(current.pinnedWorkspaceRoots, workspaceRoot),
    }))
  }, [updateNavigation])

  const setFontSize = useCallback((area: FontSizeArea, fontSize: FontSize) => {
    setAppearance((current) => {
      const fontSizes = { ...current.fontSizes, [area]: normalizeFontSize(fontSize) }
      const next = { ...current, fontSizes }
      void runtime.setAppState(APPEARANCE_PREFERENCES_KEY, JSON.stringify(next)).catch(() => undefined)
      return next
    })
  }, [])

  const resetFontSizes = useCallback(() => {
    setAppearance((current) => {
      const next = { ...current, fontSizes: defaultFontSizePreferences() }
      void runtime.setAppState(APPEARANCE_PREFERENCES_KEY, JSON.stringify(next)).catch(() => undefined)
      return next
    })
  }, [])

  const setTheme = useCallback((theme: Theme) => {
    setAppearance((current) => {
      const next = { ...current, theme: normalizeTheme(theme) }
      void runtime.setAppState(APPEARANCE_PREFERENCES_KEY, JSON.stringify(next)).catch(() => undefined)
      return next
    })
  }, [])

  const setSendShortcut = useCallback((sendShortcut: SendShortcut) => {
    setKeyboard((current) => {
      const next = { ...current, sendShortcut: normalizeSendShortcut(sendShortcut) }
      void runtime.setAppState(KEYBOARD_PREFERENCES_KEY, JSON.stringify(next)).catch(() => undefined)
      return next
    })
  }, [])

  const setFollowUpMode = useCallback((followUpMode: FollowUpMode) => {
    setKeyboard((current) => {
      const next = { ...current, followUpMode: normalizeFollowUpMode(followUpMode) }
      void runtime.setAppState(KEYBOARD_PREFERENCES_KEY, JSON.stringify(next)).catch(() => undefined)
      return next
    })
  }, [])

  const setActionShortcut = useCallback((actionId: HarnessActionId, shortcut: string) => {
    setKeyboard((current) => {
      const next = { ...current, actionShortcuts: { ...current.actionShortcuts, [actionId]: shortcut } }
      void runtime.setAppState(KEYBOARD_PREFERENCES_KEY, JSON.stringify(next)).catch(() => undefined)
      return next
    })
  }, [])

  const resetActionShortcuts = useCallback(() => {
    setKeyboard((current) => {
      const next = { ...current, actionShortcuts: { ...defaultHarnessActionShortcuts } }
      void runtime.setAppState(KEYBOARD_PREFERENCES_KEY, JSON.stringify(next)).catch(() => undefined)
      return next
    })
  }, [])

  const setThreadTitleGeneration = useCallback((next: ThreadTitleGenerationSettings) => {
    threadTitleGenerationRef.current = next
    setThreadTitleGenerationState(next)
    void runtime.setAppState(THREAD_TITLE_GENERATION_KEY, JSON.stringify(next)).catch(() => undefined)
  }, [])

  const setConversationStats = useCallback((next: ConversationStatsPreferences) => {
    const normalized = normalizeConversationStatsPreferences(next)
    setConversationStatsState(normalized)
    void runtime.setAppState(CONVERSATION_STATS_PREFERENCES_KEY, JSON.stringify(normalized)).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!toast) return undefined
    const timeout = window.setTimeout(() => setToast(null), toast.kind === 'error' ? 6_000 : 3_500)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const updateThread = useCallback((threadId: string, change: (thread: Thread) => Thread) => {
    setThreads((current) => current.map((thread) => thread.id === threadId ? change(thread) : thread))
  }, [])

  const upsertThread = useCallback((nextThread: Thread) => {
    setThreads((current) => {
      const index = current.findIndex((thread) => thread.id === nextThread.id)
      if (index < 0) return [nextThread, ...current]
      const copy = [...current]
      copy[index] = { ...copy[index], ...nextThread }
      return copy
    })
  }, [])

  const updateDetail = useCallback((threadId: string, change: (detail: ThreadDetail) => ThreadDetail) => {
    setDetails((current) => {
      const detail = current[threadId]
      return detail ? { ...current, [threadId]: change(detail) } : current
    })
  }, [])

  const persistBadge = useCallback((threadId: string, badge: Badge, lastReadAt: number | null = null) => {
    setThreadStates((current) => ({
      ...current,
      [threadId]: {
        threadId,
        lastReadAt: lastReadAt ?? current[threadId]?.lastReadAt ?? null,
        badge,
      },
    }))
    void runtime.setThreadState(threadId, lastReadAt, badge).catch(() => undefined)
  }, [])

  const markThreadRead = useCallback((threadId: string) => {
    const now = Date.now()
    const hasApproval = (approvalsRef.current[threadId] ?? []).length > 0
    persistBadge(threadId, hasApproval ? 'approval' : null, now)
  }, [persistBadge])

  const mapThreadRoots = useCallback(async (nextThreads: Thread[]) => {
    const paths = [...new Set(nextThreads.map((thread) => thread.cwd).filter(Boolean))]
    if (paths.length === 0) return
    const mappings = new Map(nextThreads.map((thread) => {
      const version = (threadMappingVersionsRef.current[thread.id] ?? 0) + 1
      threadMappingVersionsRef.current[thread.id] = version
      return [thread.id, { cwd: thread.cwd, version }]
    }))
    try {
      const mapped = await runtime.mapThreadWorkspaces(paths)
      setThreadRoots((current) => {
        const next = { ...current }
        for (const [threadId, mapping] of mappings) {
          if (threadMappingVersionsRef.current[threadId] !== mapping.version) continue
          next[threadId] = mapped[mapping.cwd]?.root ?? null
        }
        return next
      })
      setThreadGitCwds((current) => {
        const next = { ...current }
        for (const [threadId, mapping] of mappings) {
          if (threadMappingVersionsRef.current[threadId] !== mapping.version) continue
          next[threadId] = mapping.cwd
        }
        return next
      })
      setThreads((current) => current.map((thread) => {
        const mapping = mappings.get(thread.id)
        if (!mapping || threadMappingVersionsRef.current[thread.id] !== mapping.version || thread.cwd !== mapping.cwd) return thread
        const workspace = mapped[mapping.cwd]
        return { ...thread, gitInfo: workspace ? { branch: workspace.branch, sha: workspace.sha } : null }
      }))
      setDetails((current) => {
        let changed = false
        const next = { ...current }
        for (const [threadId, mapping] of mappings) {
          const detail = next[threadId]
          if (!detail || threadMappingVersionsRef.current[threadId] !== mapping.version || detail.thread.cwd !== mapping.cwd) continue
          const workspace = mapped[mapping.cwd]
          next[threadId] = {
            ...detail,
            thread: { ...detail.thread, gitInfo: workspace ? { branch: workspace.branch, sha: workspace.sha } : null },
          }
          changed = true
        }
        return changed ? next : current
      })
      const discovered = Object.values(mapped).filter((workspace): workspace is Workspace => workspace !== null)
      if (discovered.length > 0) {
        setWorkspaces((current) => {
          const byRoot = new Map(current.map((workspace) => [workspace.root, workspace]))
          for (const workspace of discovered) {
            const existing = byRoot.get(workspace.root)
            byRoot.set(workspace.root, existing ? { ...existing, name: workspace.name } : workspace)
          }
          return [...byRoot.values()]
        })
        setSelectedWorkspaceRoot((current) => current ?? discovered[0].root)
      }
    } catch {
      // A non-Git historic session is intentionally left in 未分组.
    }
  }, [])

  const refreshThreads = useCallback(async (mode: ViewMode = viewMode, searchTerm = '') => {
    const response = await appServer.listThreads({
      // The state DB already backs normal Codex session navigation. Avoid the
      // expensive JSONL scan-and-repair path on every Harness refresh.
      limit: 100,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: mode === 'archived',
      useStateDbOnly: true,
      ...(searchTerm.trim() ? { searchTerm: searchTerm.trim() } : {}),
    })
    setThreads(response.data)
    setThreadRoots((current) => {
      const next = { ...current }
      for (const thread of response.data) delete next[thread.id]
      return next
    })
    setThreadGitCwds((current) => {
      const next = { ...current }
      for (const thread of response.data) delete next[thread.id]
      return next
    })
    void mapThreadRoots(response.data)
    return response.data
  }, [mapThreadRoots, viewMode])

  const listAllActiveThreads = useCallback(async (): Promise<Thread[]> => {
    const allThreads: Thread[] = []
    let cursor: string | null = null

    do {
      const response = await appServer.listThreads({
        cursor,
        limit: 100,
        sortKey: 'recency_at',
        sortDirection: 'desc',
        archived: false,
        useStateDbOnly: true,
      })
      allThreads.push(...response.data)
      cursor = response.nextCursor
    } while (cursor)

    return allThreads
  }, [])

  const loadQueue = useCallback(async (threadId: string) => {
    try {
      const response = await appServer.listQueue(threadId)
      setQueues((current) => ({ ...current, [threadId]: response.data }))
    } catch (error) {
      notify(`无法读取排队消息：${messageOf(error)}`, 'error')
    }
  }, [notify])

  const discardEmptyDraftThread = useCallback((threadId: string | null) => {
    if (!threadId || !shouldDiscardDraftThread(
      unstartedDraftThreadIdsRef.current.has(threadId),
      draftContentThreadIdsRef.current.has(threadId),
    )) return
    unstartedDraftThreadIdsRef.current.delete(threadId)
    setThreads((current) => current.filter((thread) => thread.id !== threadId))
    setDetails((current) => {
      const next = { ...current }
      delete next[threadId]
      return next
    })
    setThreadRoots((current) => {
      const next = { ...current }
      delete next[threadId]
      return next
    })
    void appServer.deleteThread(threadId).catch((error) => {
      notify(`无法清理空白会话：${messageOf(error)}`, 'error')
      void refreshThreads()
    })
  }, [notify, refreshThreads])

  const setThreadDraftContent = useCallback((threadId: string, hasContent: boolean) => {
    if (!unstartedDraftThreadIdsRef.current.has(threadId)) return
    if (hasContent) draftContentThreadIdsRef.current.add(threadId)
    else draftContentThreadIdsRef.current.delete(threadId)
  }, [])

  const selectThread = useCallback(async (threadId: string) => {
    const previousThreadId = selectedThreadIdRef.current
    selectedThreadIdRef.current = threadId
    setSelectedThreadId(threadId)
    if (previousThreadId !== threadId) discardEmptyDraftThread(previousThreadId)
    void runtime.setAppState('selectedThreadId', threadId).catch(() => undefined)
    markThreadRead(threadId)
    setBusy((current) => ({ ...current, [`load:${threadId}`]: true }))
    try {
      const listedThread = threadsRef.current.find((thread) => thread.id === threadId)
      const response = await appServer.resumeThread({
        threadId,
        ...(listedThread ? { cwd: listedThread.cwd, runtimeWorkspaceRoots: [listedThread.cwd] } : {}),
        // Match the CLI's bounded history strategy: hydrate only the newest
        // page first, then let the user explicitly ask for older history.
        initialTurnsPage: { limit: 5, sortDirection: 'desc', itemsView: 'full' },
      })
      const resumedDetail = resumedThreadDetail(response)
      const activeTurnId = resumedDetail.activeTurnId
      const ownership = syncResumedTurn({
        activeTurnIds: activeTurnIdsRef.current,
        ownedActiveThreads: ownedActiveThreadsRef.current,
      }, threadId, activeTurnId)
      commitTurnOwnership(ownership)
      const owned = ownership.ownedActiveThreads[threadId] === true
      setDetails((current) => ({
        ...current,
        [threadId]: {
          ...resumedDetail,
          foreignActive: activeTurnId !== null && !owned,
        },
      }))
      upsertThread(response.thread)
      void mapThreadRoots([response.thread])
      await loadQueue(threadId)
    } catch (error) {
      const thread = threadsRef.current.find((item) => item.id === threadId)
      if (thread?.canAcceptDirectInput && isMissingRollout(error)) {
        // `thread/start` creates a live, empty thread before its first turn is
        // materialized as a rollout. It is still safe to compose into it.
        setDetails((current) => ({ ...current, [threadId]: emptyThreadDetail(thread) }))
        return
      }
      notify(`无法恢复会话：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, [`load:${threadId}`]: false }))
    }
  }, [commitTurnOwnership, discardEmptyDraftThread, loadQueue, mapThreadRoots, markThreadRead, notify, upsertThread])

  const openThread = useCallback(async (threadId: string) => {
    const activeThreads = await refreshThreads('active')
    if (activeThreads.some((thread) => thread.id === threadId)) {
      setViewMode('active')
    } else {
      const archivedThreads = await refreshThreads('archived')
      setViewMode(archivedThreads.some((thread) => thread.id === threadId) ? 'archived' : 'active')
    }
    await selectThread(threadId)
  }, [refreshThreads, selectThread])

  const forkThreadAtTurn = useCallback(async (turnId: string) => {
    const sourceThreadId = selectedThreadIdRef.current
    if (!sourceThreadId || forkingTurnId) return
    setForkingTurnId(turnId)
    try {
      const response = await appServer.forkThread(sourceThreadId, turnId)
      upsertThread(response.thread)
      await mapThreadRoots([response.thread])
      await selectThread(response.thread.id)
      notify('已创建分支会话。对话历史已复制，代码文件仍与来源会话共用同一工作目录。')
    } catch (error) {
      notify(`无法创建分支会话：${messageOf(error)}`, 'error')
    } finally {
      setForkingTurnId(null)
    }
  }, [forkingTurnId, mapThreadRoots, notify, selectThread, upsertThread])

  const loadOlderTurns = useCallback(async () => {
    const threadId = selectedThreadIdRef.current
    const cursor = threadId ? details[threadId]?.nextTurnsCursor : null
    if (!threadId || !cursor || busy.olderTurns) return

    setBusy((current) => ({ ...current, olderTurns: true }))
    try {
      const response = await appServer.listTurns({
        threadId,
        cursor,
        limit: 5,
        sortDirection: 'desc',
        itemsView: 'full',
      })
      if (selectedThreadIdRef.current !== threadId) return
      const olderItems = [...response.data]
        .reverse()
        .flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })))
      updateDetail(threadId, (detail) => ({
        ...detail,
        turns: [...response.data].reverse().concat(detail.turns),
        items: [...olderItems, ...detail.items],
        nextTurnsCursor: response.nextCursor,
      }))
    } catch (error) {
      notify(`无法加载更早消息：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, olderTurns: false }))
    }
  }, [busy.olderTurns, details, notify, updateDetail])

  const chooseWorkspace = useCallback(async () => {
    try {
      const workspace = await runtime.chooseWorkspace()
      if (!workspace) return null
      setWorkspaces((current) => [workspace, ...current.filter((item) => item.root !== workspace.root)])
      setSelectedWorkspaceRoot(workspace.root)
      notify(`已添加 ${workspace.name}`)
      await refreshThreads()
      return workspace
    } catch (error) {
      notify(messageOf(error), 'error')
      return null
    }
  }, [notify, refreshThreads])

  const startNewThread = useCallback(async (sessionStartSource: 'clear' | undefined, operation: '创建' | '重置') => {
    const workspaceRoot = resolveNewThreadWorkspaceRoot(selectedThreadIdRef.current, threadsRef.current, selectedWorkspaceRoot)
    if (!workspaceRoot) {
      notify('请先在左侧选择一个 Git 主工作区。', 'error')
      return
    }
    setBusy((current) => ({ ...current, createThread: true }))
    try {
      const yolo = yoloModeSettings(true)
      const response: StartThreadResponse = await appServer.startThread({
        cwd: workspaceRoot,
        runtimeWorkspaceRoots: [workspaceRoot],
        approvalPolicy: yolo.approvalPolicy,
        approvalsReviewer: yolo.approvalsReviewer,
        sandbox: yolo.sandboxMode,
        ...(sessionStartSource ? { sessionStartSource } : {}),
      })
      const previousThreadId = selectedThreadIdRef.current
      unstartedDraftThreadIdsRef.current.add(response.thread.id)
      upsertThread(response.thread)
      void mapThreadRoots([response.thread])
      selectedThreadIdRef.current = response.thread.id
      setSelectedThreadId(response.thread.id)
      if (previousThreadId !== response.thread.id) discardEmptyDraftThread(previousThreadId)
      void runtime.setAppState('selectedThreadId', response.thread.id).catch(() => undefined)
      markThreadRead(response.thread.id)
      // Do not call `thread/resume` here. A newly started, empty thread has no
      // persisted rollout yet, and App Server correctly rejects that request.
      setDetails((current) => ({
        ...current,
        [response.thread.id]: startedThreadDetail(response),
      }))
    } catch (error) {
      notify(`无法${operation}会话：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, createThread: false }))
    }
  }, [discardEmptyDraftThread, mapThreadRoots, markThreadRead, notify, selectedWorkspaceRoot, upsertThread])

  const createThread = useCallback(async () => {
    await startNewThread(undefined, '创建')
  }, [startNewThread])

  const resetThread = useCallback(async () => {
    const threadId = selectedThreadIdRef.current
    if (!threadId) return
    if (activeTurnIdsRef.current[threadId]) {
      notify('请先停止或等待当前回合结束，再重置会话。', 'error')
      return
    }
    await startNewThread('clear', '重置')
  }, [notify, startNewThread])

  const changeThreadWorkspace = useCallback(async (threadId: string, checkoutRoot: string) => {
    const currentThread = threadsRef.current.find((thread) => thread.id === threadId)
    if (!checkoutRoot || !currentThread || currentThread.cwd === checkoutRoot) return
    if (activeTurnIdsRef.current[threadId]) {
      notify('请先停止或等待当前轮完成，再切换工作目录。', 'error')
      return
    }
    setBusy((current) => ({ ...current, threadWorkspace: true }))
    try {
      const mapped = await runtime.mapThreadWorkspaces([checkoutRoot])
      const workspace = mapped[checkoutRoot]
      if (!workspace) throw new Error('所选目录不是可用的 Git checkout。')
      const nextCwd = workspace.checkoutRoot
      const detail = detailsRef.current[threadId]
      const overrides = threadPermissionOverrides(detail, currentThread.cwd, nextCwd)
      await appServer.updateThreadSettings({ threadId, cwd: nextCwd, ...overrides })
      await appServer.updateThreadMetadata({
        threadId,
        gitInfo: { branch: workspace.branch, sha: workspace.sha },
      }).catch(() => undefined)
      setThreadRoots((current) => ({ ...current, [threadId]: workspace.root }))
      setThreadGitCwds((current) => ({ ...current, [threadId]: nextCwd }))
      setSelectedWorkspaceRoot(workspace.root)
      updateThread(threadId, (thread) => ({
        ...thread,
        cwd: nextCwd,
        gitInfo: { ...thread.gitInfo, branch: workspace.branch, sha: workspace.sha },
      }))
      updateDetail(threadId, (detail) => ({
        ...detail,
        thread: {
          ...detail.thread,
          cwd: nextCwd,
          gitInfo: { ...detail.thread.gitInfo, branch: workspace.branch, sha: workspace.sha },
        },
        runtimeWorkspaceRoots: [nextCwd],
        sandbox: rebaseSandboxPolicy(detail.sandbox, currentThread.cwd, nextCwd),
      }))
    } catch (error) {
      notify(`无法切换工作区：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, threadWorkspace: false }))
    }
  }, [notify, updateDetail, updateThread])

  const setActiveTurn = useCallback((threadId: string, turnId: string, owned: boolean) => {
    commitTurnOwnership(activateTurn({
      activeTurnIds: activeTurnIdsRef.current,
      ownedActiveThreads: ownedActiveThreadsRef.current,
    }, threadId, turnId, owned))
    updateDetail(threadId, (detail) => ({ ...detail, activeTurnId: turnId, foreignActive: !owned }))
    updateThread(threadId, (thread) => touchThreadActivity({ ...thread, status: { type: 'active', activeFlags: [] } }))
    persistBadge(threadId, 'working')
  }, [commitTurnOwnership, persistBadge, updateDetail, updateThread])

  const maybeGenerateThreadTitle = useCallback(async (threadId: string, userText: string) => {
    const thread = threadsRef.current.find((candidate) => candidate.id === threadId)
    if (!thread) {
      recordTitleDiagnostic({
        level: 'info',
        event: 'generation.skipped',
        threadId,
        stage: 'preflight',
        reason: 'thread_not_found',
        trigger: 'first-user-input',
      })
      return
    }
    if (thread.name?.trim()) {
      recordTitleDiagnostic({
        level: 'info',
        event: 'generation.skipped',
        threadId,
        stage: 'preflight',
        reason: 'already_named',
        trigger: 'first-user-input',
      })
      return
    }
    const prompt = threadTitlePrompt(userText)
    if (!prompt) {
      recordTitleDiagnostic({
        level: 'info',
        event: 'generation.skipped',
        threadId,
        stage: 'preflight',
        reason: 'empty_user_input',
        trigger: 'first-user-input',
      })
      return
    }
    if (attemptedTitleThreadsRef.current.has(threadId)) {
      recordTitleDiagnostic({
        level: 'info',
        event: 'generation.skipped',
        threadId,
        stage: 'preflight',
        reason: generatingTitlesRef.current.has(threadId) ? 'in_flight' : 'already_attempted',
        trigger: 'first-user-input',
      })
      return
    }

    attemptedTitleThreadsRef.current.add(threadId)
    generatingTitlesRef.current.add(threadId)
    const attemptId = newClientId()
    const settings = threadTitleGenerationRef.current
    const startedAt = performance.now()
    recordTitleDiagnostic({
      level: 'info',
      event: 'generation.started',
      threadId,
      attemptId,
      stage: 'thread/start',
      trigger: 'first-user-input',
      model: settings.model,
      effort: settings.effort,
      sourceChars: userText.length,
    })

    let generatorThreadId: string | null = null
    let stage = 'thread/start'
    try {
      const response: StartThreadResponse = await appServer.startThread({
        cwd: thread.cwd,
        runtimeWorkspaceRoots: [thread.cwd],
        model: settings.model,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        developerInstructions: settings.prompt,
        ephemeral: true,
      })
      generatorThreadId = response.thread.id
      titleGeneratorsRef.current.set(response.thread.id, {
        targetThreadId: threadId,
        attemptId,
        text: '',
        startedAt,
      })
      recordTitleDiagnostic({
        level: 'info',
        event: 'generator.started',
        method: 'thread/start',
        threadId,
        generatorThreadId,
        attemptId,
        stage,
        model: settings.model,
        effort: settings.effort,
      })

      stage = 'turn/start'
      await appServer.startTurn({
        threadId: response.thread.id,
        clientUserMessageId: newClientId(),
        input: [textInput(prompt)],
        cwd: thread.cwd,
        runtimeWorkspaceRoots: [thread.cwd],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        effort: settings.effort,
      })
      recordTitleDiagnostic({
        level: 'info',
        event: 'generator.turn_started',
        method: 'turn/start',
        threadId,
        generatorThreadId,
        attemptId,
        stage,
        model: settings.model,
        effort: settings.effort,
      })
    } catch (error) {
      if (generatorThreadId) titleGeneratorsRef.current.delete(generatorThreadId)
      generatingTitlesRef.current.delete(threadId)
      recordTitleDiagnostic({
        level: 'error',
        event: 'generation.failed',
        method: stage,
        threadId,
        generatorThreadId: generatorThreadId ?? undefined,
        attemptId,
        stage,
        trigger: 'first-user-input',
        model: settings.model,
        effort: settings.effort,
        errorCode: diagnosticErrorCode(error),
        durationMs: Math.round(performance.now() - startedAt),
      })
    }
  }, [])

  const startTurn = useCallback(async (threadId: string, text: string | null, inputs?: UserInput[]) => {
    unstartedDraftThreadIdsRef.current.delete(threadId)
    draftContentThreadIdsRef.current.delete(threadId)
    locallyStartingRef.current.add(threadId)
    try {
      const thread = threadsRef.current.find((candidate) => candidate.id === threadId)
      const detail = detailsRef.current[threadId]
      const response = await appServer.startTurn(turnStartRequest(
        threadId,
        newClientId(),
        inputs ?? (text ? [textInput(text)] : []),
        thread,
        detail,
      ))
      setActiveTurn(threadId, response.turn.id, true)
      return response.turn.id
    } finally {
      locallyStartingRef.current.delete(threadId)
    }
  }, [setActiveTurn])

  const sendMessage = useCallback(async (input: UserInput[], mode: 'interject' | 'queue') => {
    const threadId = selectedThreadIdRef.current
    if (!threadId || input.length === 0) return
    const text = input
      .filter((item): item is Extract<UserInput, { type: 'text' }> => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
    const activeTurnId = activeTurnIdsRef.current[threadId]
    const shouldEvaluateTitle = !activeTurnId && (
      unstartedDraftThreadIdsRef.current.has(threadId)
      || isFirstUserTurn(detailsRef.current[threadId])
    )
    const owned = ownedActiveThreadsRef.current[threadId] === true
    if (activeTurnId && !owned) {
      notify('该会话正由其他客户端运行；请等待当前轮结束。', 'error')
      return
    }
    setBusy((current) => ({ ...current, composer: true }))
    try {
      if (!activeTurnId) {
        await startTurn(threadId, null, input)
        if (text.trim()) {
          updateThread(threadId, (thread) => withInitialThreadPreview(thread, text))
          updateDetail(threadId, (detail) => ({
            ...detail,
            thread: withInitialThreadPreview(detail.thread, text),
          }))
        }
        if (shouldEvaluateTitle) void maybeGenerateThreadTitle(threadId, text)
        return
      }

      const clientUserMessageId = newClientId()
      const result = await submitActiveTurnInput(appServer, {
        threadId,
        activeTurnId,
        clientUserMessageId,
        input,
        mode,
      })
      if (result.kind === 'queued') {
        await loadQueue(threadId)
        return
      }
      setPendingSteers((current) => ({
        ...current,
        [threadId]: [...(current[threadId] ?? []), result.pending],
      }))
    } catch (error) {
      notify(`无法发送消息：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, composer: false }))
    }
  }, [loadQueue, maybeGenerateThreadTitle, notify, startTurn, updateDetail, updateThread])

  const continueAfterFailure = useCallback(async () => {
    const threadId = selectedThreadIdRef.current
    if (!threadId || activeTurnIdsRef.current[threadId] || continuingFailedThreadsRef.current.has(threadId)) return
    const thread = threadsRef.current.find((candidate) => candidate.id === threadId)
    const latestTurn = detailsRef.current[threadId]?.turns.at(-1)
    if (!latestTurn || latestTurn.status !== 'failed') return
    if (thread?.canAcceptDirectInput === false) {
      notify('当前会话不接受继续输入。', 'error')
      return
    }
    continuingFailedThreadsRef.current.add(threadId)
    setBusy((current) => ({ ...current, composer: true }))
    try {
      await startTurn(threadId, '继续')
    } catch (error) {
      notify(`无法继续会话：${messageOf(error)}`, 'error')
    } finally {
      continuingFailedThreadsRef.current.delete(threadId)
      setBusy((current) => ({ ...current, composer: false }))
    }
  }, [notify, startTurn])

  const stopTurn = useCallback(async () => {
    const threadId = selectedThreadIdRef.current
    if (!threadId) return
    const turnId = activeTurnIdsRef.current[threadId]
    if (!turnId || !ownedActiveThreadsRef.current[threadId]) return
    const steers = pendingSteers[threadId] ?? []
    if (steers.length > 0) pendingRestartRef.current[threadId] = steers
    setBusy((current) => ({ ...current, stop: true }))
    try {
      await appServer.interruptTurn(threadId, turnId)
    } catch (error) {
      delete pendingRestartRef.current[threadId]
      notify(`无法停止当前轮：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, stop: false }))
    }
  }, [notify, pendingSteers])

  const interruptAgentThread = useCallback(async (threadId: string) => {
    const turnId = activeTurnIdsRef.current[threadId]
    if (!turnId) {
      notify('子 Agent 当前没有可停止的运行轮次。', 'error')
      return
    }
    try {
      await appServer.interruptTurn(threadId, turnId)
    } catch (error) {
      notify(`无法停止子 Agent：${messageOf(error)}`, 'error')
    }
  }, [notify])

  const editQueue = useCallback(async (queueId: string, text: string) => {
    const threadId = selectedThreadIdRef.current
    if (!threadId || !text.trim()) return
    try {
      await appServer.updateQueue(threadId, queueId, [textInput(text.trim())])
      await loadQueue(threadId)
    } catch (error) {
      notify(`无法修改排队消息：${messageOf(error)}`, 'error')
    }
  }, [loadQueue, notify])

  const removeQueue = useCallback(async (queueId: string) => {
    const threadId = selectedThreadIdRef.current
    if (!threadId) return
    try {
      await appServer.deleteQueue(threadId, queueId)
      setQueues((current) => ({ ...current, [threadId]: (current[threadId] ?? []).filter((item) => item.id !== queueId) }))
    } catch (error) {
      notify(`无法撤回排队消息：${messageOf(error)}`, 'error')
    }
  }, [notify])

  const promoteQueue = useCallback(async (queue: QueuedSubmission) => {
    const threadId = selectedThreadIdRef.current
    if (!threadId) return
    const activeTurnId = activeTurnIdsRef.current[threadId]
    if (!activeTurnId || !ownedActiveThreadsRef.current[threadId]) {
      notify('只有 Harness 正在运行该会话时，才能将排队消息改为插话。', 'error')
      return
    }
    setBusy((current) => ({ ...current, [`promote:${queue.id}`]: true }))
    try {
      const pending = await promoteQueuedSubmission(appServer, threadId, activeTurnId, queue)
      setPendingSteers((current) => ({
        ...current, [threadId]: [...(current[threadId] ?? []), pending],
      }))
      setQueues((current) => ({ ...current, [threadId]: (current[threadId] ?? []).filter((item) => item.id !== queue.id) }))
    } catch (error) {
      await loadQueue(threadId)
      notify(`未能改为插话；消息已尝试恢复到队列：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, [`promote:${queue.id}`]: false }))
    }
  }, [loadQueue, notify])

  const startQueue = useCallback(async () => {
    const threadId = selectedThreadIdRef.current
    if (!threadId || activeTurnIdsRef.current[threadId]) return
    const queue = queues[threadId] ?? []
    if (queue.length === 0) return
    try {
      const response = await appServer.startQueue(threadId, queue[0].id)
      setActiveTurn(threadId, response.turn.id, true)
    } catch (error) {
      notify(`无法继续队列：${messageOf(error)}`, 'error')
    }
  }, [notify, queues, setActiveTurn])

  const renameThread = useCallback(async (threadId: string, name: string) => {
    try {
      await appServer.renameThread(threadId, name.trim())
      updateThread(threadId, (thread) => ({ ...thread, name: name.trim() || null }))
      updateDetail(threadId, (detail) => ({ ...detail, thread: { ...detail.thread, name: name.trim() || null } }))
    } catch (error) {
      notify(`无法重命名会话：${messageOf(error)}`, 'error')
    }
  }, [notify, updateDetail, updateThread])

  const archiveThread = useCallback(async (threadId: string) => {
    try {
      await appServer.archiveThread(threadId)
      setThreads((current) => current.filter((thread) => thread.id !== threadId))
      if (selectedThreadIdRef.current === threadId) setSelectedThreadId(null)
      notify('已归档会话')
    } catch (error) {
      notify(`无法归档会话：${messageOf(error)}`, 'error')
    }
  }, [notify])

  const archiveOldThreads = useCallback(async () => {
    if (busy.archiveOldThreads) return

    setBusy((current) => ({ ...current, archiveOldThreads: true }))
    try {
      const cutoff = Date.now() / 1_000 - 3 * 24 * 60 * 60
      const candidates = threadsOlderThan(await listAllActiveThreads(), cutoff)
      if (candidates.length === 0) {
        notify('没有超过 3 天的会话需要归档')
        return
      }

      const archivedIds = new Set<string>()
      let failedCount = 0
      for (const thread of candidates) {
        try {
          await appServer.archiveThread(thread.id)
          archivedIds.add(thread.id)
        } catch {
          failedCount += 1
        }
      }

      if (archivedIds.size > 0) {
        setThreads((current) => current.filter((thread) => !archivedIds.has(thread.id)))
        if (archivedIds.has(selectedThreadIdRef.current ?? '')) {
          selectedThreadIdRef.current = null
          setSelectedThreadId(null)
        }
      }

      if (failedCount > 0) {
        const message = archivedIds.size > 0
          ? `已归档 ${archivedIds.size} 个 3 天前的会话；${failedCount} 个未能归档`
          : `未能归档 ${failedCount} 个 3 天前的会话`
        notify(message, 'error')
      } else {
        notify(`已归档 ${archivedIds.size} 个 3 天前的会话`)
      }
    } catch (error) {
      notify(`无法归档旧会话：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, archiveOldThreads: false }))
    }
  }, [busy.archiveOldThreads, listAllActiveThreads, notify])

  const unarchiveThread = useCallback(async (threadId: string) => {
    try {
      await appServer.unarchiveThread(threadId)
      setThreads((current) => current.filter((thread) => thread.id !== threadId))
      if (selectedThreadIdRef.current === threadId) setSelectedThreadId(null)
      notify('已恢复会话')
    } catch (error) {
      notify(`无法恢复会话：${messageOf(error)}`, 'error')
    }
  }, [notify])

  const answerApproval = useCallback(async (request: ApprovalRequest, decision: unknown) => {
    try {
      await runtime.respond(request.id, approvalResponse(request.method, decision))
      setApprovals((current) => ({
        ...current,
        [request.threadId]: (current[request.threadId] ?? []).filter((item) => item.id !== request.id),
      }))
      const remaining = (approvalsRef.current[request.threadId] ?? []).filter((item) => item.id !== request.id)
      if (remaining.length === 0 && activeTurnIdsRef.current[request.threadId]) persistBadge(request.threadId, 'working')
    } catch (error) {
      notify(`无法提交审批结果：${messageOf(error)}`, 'error')
    }
  }, [notify, persistBadge])

  const handleTitleGeneratorEvent = useCallback((method: string, params: JsonObject): boolean => {
    const generatorThreadId = eventThreadId(params)
    if (!generatorThreadId) return false
    const generator = titleGeneratorsRef.current.get(generatorThreadId)
    if (!generator) return false

    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      generator.text += params.delta
    } else if (method === 'item/completed') {
      const item = eventThreadItem(params.item)
      if (item?.type === 'agentMessage') generator.text = itemText(item) || generator.text
    } else if (method === 'turn/completed') {
      const turn = params.turn as Turn | undefined
      const fallback = turn?.items.find((item) => item.type === 'agentMessage')
      const generatedText = generator.text || (fallback ? itemText(fallback) : '')
      const title = parseGeneratedThreadTitle(generatedText)
      recordTitleDiagnostic({
        level: 'info',
        event: 'generation.completed',
        method: 'turn/completed',
        threadId: generator.targetThreadId,
        generatorThreadId,
        attemptId: generator.attemptId,
        stage: 'turn/completed',
        generatedChars: generatedText.length,
        accepted: Boolean(title),
        status: turn?.status,
        durationMs: Math.round(performance.now() - generator.startedAt),
      })
      titleGeneratorsRef.current.delete(generatorThreadId)
      generatingTitlesRef.current.delete(generator.targetThreadId)
      const target = threadsRef.current.find((thread) => thread.id === generator.targetThreadId)
      if (!title) {
        recordTitleDiagnostic({
          level: 'info',
          event: 'name_set.skipped',
          method: 'thread/name/set',
          threadId: generator.targetThreadId,
          generatorThreadId,
          attemptId: generator.attemptId,
          stage: 'thread/name/set',
          reason: 'empty_generated_title',
        })
        return true
      }
      if (!target) {
        recordTitleDiagnostic({
          level: 'info',
          event: 'name_set.skipped',
          method: 'thread/name/set',
          threadId: generator.targetThreadId,
          generatorThreadId,
          attemptId: generator.attemptId,
          stage: 'thread/name/set',
          reason: 'thread_not_found',
        })
        return true
      }
      if (target.name?.trim()) {
        recordTitleDiagnostic({
          level: 'info',
          event: 'name_set.skipped',
          method: 'thread/name/set',
          threadId: target.id,
          generatorThreadId,
          attemptId: generator.attemptId,
          stage: 'thread/name/set',
          reason: 'already_named',
        })
        return true
      }
      const nameSetStartedAt = performance.now()
      void appServer.renameThread(target.id, title).then(() => {
        updateThread(target.id, (thread) => thread.name?.trim() ? thread : { ...thread, name: title })
        updateDetail(target.id, (detail) => detail.thread.name?.trim()
          ? detail
          : { ...detail, thread: { ...detail.thread, name: title } })
        recordTitleDiagnostic({
          level: 'info',
          event: 'name_set.completed',
          method: 'thread/name/set',
          threadId: target.id,
          generatorThreadId,
          attemptId: generator.attemptId,
          stage: 'thread/name/set',
          accepted: true,
          durationMs: Math.round(performance.now() - nameSetStartedAt),
        })
      }).catch((error) => {
        recordTitleDiagnostic({
          level: 'error',
          event: 'name_set.failed',
          method: 'thread/name/set',
          threadId: target.id,
          generatorThreadId,
          attemptId: generator.attemptId,
          stage: 'thread/name/set',
          errorCode: diagnosticErrorCode(error),
          durationMs: Math.round(performance.now() - nameSetStartedAt),
        })
      })
    }
    return true
  }, [updateDetail, updateThread])

  const handleEvent = useCallback((event: AppServerEvent) => {
    const method = event.method
    const params = event.params ?? {}
    if (!method) return

    if (handleTitleGeneratorEvent(method, params)) return

    if (event.id !== undefined && isApprovalRequestMethod(method)) {
      const threadId = eventThreadId(params)
      if (threadId) {
        const request: ApprovalRequest = { id: event.id, method, params, threadId }
        setApprovals((current) => ({ ...current, [threadId]: [...(current[threadId] ?? []), request] }))
        persistBadge(threadId, 'approval')
      }
      return
    }

    if (method === 'thread/started') {
      const thread = params.thread as Thread | undefined
      if (thread && !thread.ephemeral) {
        upsertThread(thread)
        void mapThreadRoots([thread])
      }
      return
    }

    if (method === 'thread/settings/updated') {
      const threadId = eventThreadId(params)
      const settings = params.threadSettings as JsonObject | undefined
      const cwd = typeof settings?.cwd === 'string' ? settings.cwd : null
      if (threadId && cwd && settings) {
        const sandbox = eventSandboxPolicy(settings.sandboxPolicy)
        const profile = eventPermissionProfile(settings.activePermissionProfile)
        const model = typeof settings?.model === 'string' ? settings.model : null
        const nextThreadSettings = eventThreadSettings(settings)
        threadMappingVersionsRef.current[threadId] = (threadMappingVersionsRef.current[threadId] ?? 0) + 1
        setThreadRoots((current) => {
          const next = { ...current }
          delete next[threadId]
          return next
        })
        setThreadGitCwds((current) => {
          const next = { ...current }
          delete next[threadId]
          return next
        })
        updateThread(threadId, (thread) => ({ ...thread, cwd, gitInfo: null }))
        updateDetail(threadId, (detail) => reduceThreadDetailEvent(detail, {
          type: 'settingsUpdated',
          cwd,
          sandbox,
          activePermissionProfile: profile,
          model,
          threadSettings: nextThreadSettings,
        }))
        const thread = threadsRef.current.find((candidate) => candidate.id === threadId)
        if (thread) void mapThreadRoots([{ ...thread, cwd }])
      }
      return
    }

    if (method === 'thread/status/changed') {
      const threadId = eventThreadId(params)
      const status = params.status as Thread['status'] | undefined
      if (threadId && status) {
        updateThread(threadId, (thread) => status.type === 'active'
          ? touchThreadActivity({ ...thread, status })
          : { ...thread, status })
        updateDetail(threadId, (detail) => reduceThreadDetailEvent(detail, { type: 'statusChanged', status }))
        if (status.type === 'systemError') persistBadge(threadId, 'error')
      }
      return
    }

    if (method === 'thread/name/updated') {
      const threadId = eventThreadId(params)
      const name = typeof params.threadName === 'string' ? params.threadName : null
      if (threadId) {
        updateThread(threadId, (thread) => ({ ...thread, name }))
        updateDetail(threadId, (detail) => reduceThreadDetailEvent(detail, { type: 'nameUpdated', name }))
      }
      return
    }

    if (method === 'thread/tokenUsage/updated') {
      const threadId = eventThreadId(params)
      const tokenUsage = parseEventTokenUsage(params.tokenUsage)
      if (threadId && tokenUsage) {
        setThreadTokenUsages((current) => ({ ...current, [threadId]: tokenUsage }))
      }
      return
    }

    if (method === 'turn/plan/updated') {
      const threadId = eventThreadId(params)
      const plan = parseEventTurnPlan(params.plan)
      if (threadId && plan) setThreadPlans((current) => ({ ...current, [threadId]: plan }))
      return
    }

    if (method === 'turn/started') {
      const threadId = eventThreadId(params)
      const turn = params.turn as Turn | undefined
      if (threadId && turn) {
        const owned = ownsStartedTurn({
          activeTurnIds: activeTurnIdsRef.current,
          ownedActiveThreads: ownedActiveThreadsRef.current,
        }, threadId, turn.id, locallyStartingRef.current.has(threadId))
        setActiveTurn(threadId, turn.id, owned)
        updateDetail(threadId, (detail) => reduceThreadDetailEvent(detail, { type: 'turnStarted', turn }))
      }
      return
    }

    if (method === 'item/started' || method === 'item/completed') {
      const threadId = eventThreadId(params)
      const turnId = typeof params.turnId === 'string' ? params.turnId : null
      const item = eventThreadItem(params.item)
      if (threadId && turnId && item) {
        updateDetail(threadId, (detail) => reduceThreadDetailEvent(detail, { type: 'itemUpserted', turnId, item }))
        if (item.type === 'userMessage') {
          const clientId = typeof item.clientId === 'string' ? item.clientId : null
          if (clientId) {
            setPendingSteers((current) => ({
              ...current,
              [threadId]: (current[threadId] ?? []).filter((steer) => steer.clientUserMessageId !== clientId),
            }))
          }
        }
      }
      return
    }

    if (method === 'item/agentMessage/delta') {
      const threadId = eventThreadId(params)
      const itemId = typeof params.itemId === 'string' ? params.itemId : null
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (threadId && itemId) {
        updateDetail(threadId, (detail) => reduceThreadDetailEvent(detail, { type: 'agentMessageDelta', itemId, delta }))
      }
      return
    }

    if (method === 'item/commandExecution/outputDelta') {
      const threadId = eventThreadId(params)
      const itemId = typeof params.itemId === 'string' ? params.itemId : null
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (threadId && itemId) {
        updateDetail(threadId, (detail) => reduceThreadDetailEvent(detail, { type: 'commandOutputDelta', itemId, delta }))
      }
      return
    }

    if (method === 'turn/completed') {
      const threadId = eventThreadId(params)
      const turn = params.turn as Turn | undefined
      if (threadId && turn) {
        const completedThread = threadsRef.current.find((thread) => thread.id === threadId)
        updateDetail(threadId, (detail) => reduceThreadDetailEvent(detail, { type: 'turnCompleted', turn }))
        commitTurnOwnership(completeTurn({
          activeTurnIds: activeTurnIdsRef.current,
          ownedActiveThreads: ownedActiveThreadsRef.current,
        }, threadId, turn.id))
        updateThread(threadId, (thread) => touchThreadActivity({ ...thread, status: { type: 'idle' } }))
        const badge: Badge = turn.status === 'failed' ? 'error' : selectedThreadIdRef.current === threadId ? null : 'success'
        persistBadge(threadId, badge)
        if (completedThread && !completedThread.ephemeral) {
          const completedEvent: TurnCompletedEvent = {
            threadId,
            turnId: turn.id,
            title: threadTitle(completedThread),
            status: turn.status,
          }
          for (const listener of turnCompletedListenersRef.current) listener(completedEvent)
        }

        const restarts = pendingRestartRef.current[threadId]
        if (restarts?.length) {
          delete pendingRestartRef.current[threadId]
          setPendingSteers((current) => ({ ...current, [threadId]: [] }))
          void startTurn(threadId, null, restartInputs(restarts)).catch((error) => {
            notify(`插话未能在停止后继续发送：${messageOf(error)}`, 'error')
          })
        }
      }
      return
    }

    if (method === 'thread/queue/changed') {
      const threadId = eventThreadId(params)
      if (threadId) void loadQueue(threadId)
      return
    }

    if (method === 'serverRequest/resolved') {
      const threadId = eventThreadId(params)
      const requestId = params.requestId
      if (threadId && (typeof requestId === 'string' || typeof requestId === 'number')) {
        setApprovals((current) => ({
          ...current,
          [threadId]: (current[threadId] ?? []).filter((request) => request.id !== requestId),
        }))
      }
      return
    }

    if (method === 'thread/archived' || method === 'thread/deleted' || method === 'thread/unarchived') {
      const threadId = eventThreadId(params)
      if (threadId) {
        unstartedDraftThreadIdsRef.current.delete(threadId)
        draftContentThreadIdsRef.current.delete(threadId)
        setThreads((current) => current.filter((thread) => thread.id !== threadId))
      }
    }
  }, [commitTurnOwnership, handleTitleGeneratorEvent, loadQueue, mapThreadRoots, notify, persistBadge, setActiveTurn, startTurn, updateDetail, updateThread, upsertThread])

  useEffect(() => {
    let disposed = false
    let unlistenEvents: (() => void) | undefined
    let unlistenTransport: (() => void) | undefined
    const bootstrap = async () => {
      try {
        const restored = await loadHarnessBootstrap(runtime)
        if (disposed) return
        setWorkspaces(restored.workspaces)
        setThreadStates(restored.threadStates)
        setNavigation(restored.navigation)
        setAppearance(restored.appearance)
        setKeyboard(restored.keyboard)
        threadTitleGenerationRef.current = restored.threadTitleGeneration
        setThreadTitleGenerationState(restored.threadTitleGeneration)
        setConversationStatsState(restored.conversationStats)
        if (restored.workspaces.length > 0) setSelectedWorkspaceRoot(restored.workspaces[0].root)
        const loadedThreads = await refreshThreads('active')
        if (disposed) return
        setPhase('ready')
        if (restored.rememberedThreadId && loadedThreads.some((thread) => thread.id === restored.rememberedThreadId)) {
          void selectThread(restored.rememberedThreadId)
        }
      } catch (error) {
        if (!disposed) {
          setPhase('error')
          setBootError(messageOf(error))
        }
      }
    }
    void bootstrap()
    void runtime.listenEvents(handleEvent).then((unlisten) => { unlistenEvents = unlisten })
    void runtime.listenTransport((event) => {
      if (event.kind === 'disconnected') notify(String(event.message ?? 'Codex App Server 连接已断开。'), 'error')
    }).then((unlisten) => { unlistenTransport = unlisten })
    return () => {
      disposed = true
      unlistenEvents?.()
      unlistenTransport?.()
    }
  }, [handleEvent, notify, refreshThreads, selectThread])

  const currentThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, threads],
  )
  const currentDetail = selectedThreadId ? details[selectedThreadId] ?? null : null
  const currentTokenUsage = selectedThreadId ? threadTokenUsages[selectedThreadId] ?? null : null
  const currentTaskPlan = selectedThreadId ? threadPlans[selectedThreadId] ?? null : null
  const activeTurnId = selectedThreadId ? activeTurnIds[selectedThreadId] ?? currentDetail?.activeTurnId ?? null : null
  const currentForeignActive = deriveForeignActive(
    activeTurnId,
    ownedActiveThreads[selectedThreadId ?? ''] === true,
  )

  return {
    phase,
    bootError,
    threads,
    workspaces,
    threadRoots,
    threadGitCwds,
    threadStates,
    details,
    threadTokenUsages,
    threadPlans,
    navigation,
    appearance,
    keyboard,
    conversationStats,
    threadTitleGeneration,
    queues,
    approvals,
    pendingSteers,
    selectedThreadId,
    selectedWorkspaceRoot,
    viewMode,
    toast,
    busy,
    forkingTurnId,
    currentThread,
    currentDetail,
    currentTokenUsage,
    currentTaskPlan,
    activeTurnId,
    activeTurnIds,
    currentForeignActive,
    isCurrentWorking: Boolean(activeTurnId),
    selectThread,
    openThread,
    forkThreadAtTurn,
    onTurnCompleted,
    loadOlderTurns,
    chooseWorkspace,
    createThread,
    resetThread,
    setThreadDraftContent,
    startTurnInThread: (threadId: string, prompt: string) => startTurn(threadId, prompt),
    sendMessage,
    continueAfterFailure,
    stopTurn,
    interruptAgentThread,
    editQueue,
    removeQueue,
    promoteQueue,
    startQueue,
    renameThread,
    archiveThread,
    archiveOldThreads,
    unarchiveThread,
    answerApproval,
    setNavigationLayout,
    setThreadSort,
    setWorkspaceSort,
    setManualThreadOrder,
    toggleThreadPinned,
    toggleWorkspacePinned,
    setSidebarWidth,
    setSidebarCollapsed,
    setFontSize,
    resetFontSizes,
    setTheme,
    setSendShortcut,
    setFollowUpMode,
    setActionShortcut,
    resetActionShortcuts,
    setThreadTitleGeneration,
    setConversationStats,
    setSelectedWorkspaceRoot,
    changeThreadWorkspace,
    setViewMode: async (mode: ViewMode) => {
      setViewMode(mode)
      try {
        await refreshThreads(mode)
      } catch (error) {
        notify(`无法读取会话：${messageOf(error)}`, 'error')
      }
    },
    searchThreads: async (term: string) => {
      try {
        await refreshThreads(viewMode, term)
      } catch (error) {
        notify(`无法搜索会话：${messageOf(error)}`, 'error')
      }
    },
    refresh: async () => {
      try {
        await refreshThreads()
      } catch (error) {
        notify(`无法刷新会话：${messageOf(error)}`, 'error')
      }
    },
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
