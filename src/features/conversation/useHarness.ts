import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppServerEvent,
  AppearancePreferences,
  ApprovalRequest,
  Badge,
  FontSize,
  FontSizeArea,
  JsonObject,
  NavigationLayout,
  NavigationPreferences,
  PendingSteer,
  QueuedSubmission,
  Thread,
  ThreadDetail,
  ThreadItem,
  ThreadItemEntry,
  ThreadSort,
  ThreadTokenUsage,
  ThreadUiState,
  Turn,
  UserInput,
  Workspace,
  WorkspaceSort,
} from '../../core/domain/codex'
import {
  DEFAULT_SIDEBAR_WIDTH,
  defaultFontSizePreferences,
  emptyThreadDetail,
  isActive,
  normalizeFontSize,
  normalizeFontSizePreferences,
  normalizeSidebarWidth,
  textInput,
  threadsOlderThan,
} from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'

type ViewMode = 'active' | 'archived'

const NAVIGATION_PREFERENCES_KEY = 'navigationPreferences'
const APPEARANCE_PREFERENCES_KEY = 'appearancePreferences'

const defaultNavigationPreferences: NavigationPreferences = {
  layout: 'workspace',
  sort: 'recent',
  manualThreadOrder: [],
  workspaceSort: 'stable',
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  sidebarCollapsed: false,
}

const defaultAppearancePreferences: AppearancePreferences = {
  fontSizes: defaultFontSizePreferences(),
}

interface ResumeResponse {
  thread: Thread
  initialTurnsPage?: { data: Turn[]; nextCursor: string | null } | null
}

interface ThreadListResponse {
  data: Thread[]
  nextCursor: string | null
}

interface TurnsPageResponse {
  data: Turn[]
  nextCursor: string | null
}

interface QueueListResponse {
  data: QueuedSubmission[]
}

interface StartTurnResponse {
  turn: Turn
}

interface StartThreadResponse {
  thread: Thread
}

interface HookToast {
  kind: 'error' | 'info'
  message: string
}

function eventThreadId(params: JsonObject): string | null {
  const value = params.threadId ?? params.conversationId
  return typeof value === 'string' ? value : null
}

function toThreadItem(value: unknown): ThreadItem | null {
  if (!value || typeof value !== 'object' || !('type' in value)) return null
  return value as ThreadItem
}

function newClientId(): string {
  return crypto.randomUUID()
}

function findActiveTurn(turns: Turn[]): string | null {
  return turns.find((turn) => turn.status === 'inProgress')?.id ?? null
}

function isMissingRollout(error: unknown): boolean {
  return messageOf(error).toLowerCase().includes('no rollout found')
}

function upsertItem(items: ThreadItemEntry[], turnId: string, nextItem: ThreadItem): ThreadItemEntry[] {
  const id = typeof nextItem.id === 'string' ? nextItem.id : null
  if (!id) return [...items, { turnId, item: nextItem }]
  const found = items.findIndex((entry) => entry.item.id === id)
  if (found < 0) return [...items, { turnId, item: nextItem }]
  const copy = [...items]
  copy[found] = { turnId, item: { ...copy[found].item, ...nextItem } }
  return copy
}

function upsertTurn(turns: Turn[], nextTurn: Turn): Turn[] {
  const index = turns.findIndex((turn) => turn.id === nextTurn.id)
  if (index < 0) return [...turns, nextTurn]
  const copy = [...turns]
  const current = copy[index]
  copy[index] = {
    ...current,
    ...nextTurn,
    // A turn/started event can arrive without items for a turn that was already
    // hydrated from history. Do not throw that known history away.
    items: nextTurn.items.length > 0 ? nextTurn.items : current.items,
  }
  return copy
}

function parseNavigationPreferences(raw: string | null): NavigationPreferences {
  if (!raw) return defaultNavigationPreferences
  try {
    const value = JSON.parse(raw) as Partial<NavigationPreferences>
    return {
      layout: value.layout === 'list' ? 'list' : 'workspace',
      sort: value.sort === 'manual' ? 'manual' : 'recent',
      manualThreadOrder: Array.isArray(value.manualThreadOrder)
        ? [...new Set(value.manualThreadOrder.filter((id): id is string => typeof id === 'string'))].slice(0, 500)
        : [],
      workspaceSort: value.workspaceSort === 'recent' ? 'recent' : 'stable',
      sidebarWidth: normalizeSidebarWidth(value.sidebarWidth),
      sidebarCollapsed: value.sidebarCollapsed === true,
    }
  } catch {
    return defaultNavigationPreferences
  }
}

function parseAppearancePreferences(raw: string | null): AppearancePreferences {
  if (!raw) return defaultAppearancePreferences
  try {
    const value = JSON.parse(raw)
    return {
      fontSizes: normalizeFontSizePreferences(value),
    }
  } catch {
    return defaultAppearancePreferences
  }
}

function parseTokenUsage(value: unknown): ThreadTokenUsage | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as JsonObject
  const breakdown = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return null
    const source = candidate as JsonObject
    const number = (key: string, fallback = 0) => {
      const next = source[key]
      return typeof next === 'number' && Number.isFinite(next) ? Math.max(0, next) : fallback
    }
    if (typeof source.totalTokens !== 'number') return null
    return {
      totalTokens: number('totalTokens'),
      inputTokens: number('inputTokens'),
      cachedInputTokens: number('cachedInputTokens'),
      cacheWriteInputTokens: number('cacheWriteInputTokens'),
      outputTokens: number('outputTokens'),
      reasoningOutputTokens: number('reasoningOutputTokens'),
    }
  }
  const total = breakdown(raw.total)
  const last = breakdown(raw.last)
  if (!total || !last) return null
  const modelContextWindow = typeof raw.modelContextWindow === 'number' && Number.isFinite(raw.modelContextWindow)
    ? Math.max(0, raw.modelContextWindow)
    : null
  return { total, last, modelContextWindow }
}

function updateItem(items: ThreadItemEntry[], itemId: string, update: (item: ThreadItem) => ThreadItem): ThreadItemEntry[] {
  return items.map((entry) => entry.item.id === itemId ? { ...entry, item: update(entry.item) } : entry)
}

export function useHarness() {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [bootError, setBootError] = useState<string | null>(null)
  const [threads, setThreads] = useState<Thread[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [threadRoots, setThreadRoots] = useState<Record<string, string | null>>({})
  const [threadStates, setThreadStates] = useState<Record<string, ThreadUiState>>({})
  const [details, setDetails] = useState<Record<string, ThreadDetail>>({})
  const [threadTokenUsages, setThreadTokenUsages] = useState<Record<string, ThreadTokenUsage>>({})
  const [navigation, setNavigation] = useState<NavigationPreferences>(defaultNavigationPreferences)
  const [appearance, setAppearance] = useState<AppearancePreferences>(defaultAppearancePreferences)
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

  const selectedThreadIdRef = useRef<string | null>(null)
  const threadsRef = useRef<Thread[]>([])
  const pendingRestartRef = useRef<Record<string, PendingSteer[]>>({})
  const locallyStartingRef = useRef(new Set<string>())
  const activeTurnIdsRef = useRef<Record<string, string>>({})
  const ownedActiveThreadsRef = useRef<Record<string, boolean>>({})
  const approvalsRef = useRef<Record<string, ApprovalRequest[]>>({})

  useEffect(() => { selectedThreadIdRef.current = selectedThreadId }, [selectedThreadId])
  useEffect(() => { threadsRef.current = threads }, [threads])
  useEffect(() => { activeTurnIdsRef.current = activeTurnIds }, [activeTurnIds])
  useEffect(() => { ownedActiveThreadsRef.current = ownedActiveThreads }, [ownedActiveThreads])
  useEffect(() => { approvalsRef.current = approvals }, [approvals])

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

  const setFontSize = useCallback((area: FontSizeArea, fontSize: FontSize) => {
    setAppearance((current) => {
      const fontSizes = { ...current.fontSizes, [area]: normalizeFontSize(fontSize) }
      void runtime.setAppState(APPEARANCE_PREFERENCES_KEY, JSON.stringify({ fontSizes })).catch(() => undefined)
      return { fontSizes }
    })
  }, [])

  const resetFontSizes = useCallback(() => {
    const fontSizes = defaultFontSizePreferences()
    setAppearance({ fontSizes })
    void runtime.setAppState(APPEARANCE_PREFERENCES_KEY, JSON.stringify({ fontSizes })).catch(() => undefined)
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
    try {
      const mapped = await runtime.mapThreadWorkspaces(paths)
      setThreadRoots((current) => {
        const next = { ...current }
        for (const thread of nextThreads) next[thread.id] = mapped[thread.cwd]?.root ?? null
        return next
      })
      const discovered = Object.values(mapped).filter((workspace): workspace is Workspace => workspace !== null)
      if (discovered.length > 0) {
        setWorkspaces((current) => {
          const byRoot = new Map(current.map((workspace) => [workspace.root, workspace]))
          for (const workspace of discovered) if (!byRoot.has(workspace.root)) byRoot.set(workspace.root, workspace)
          return [...byRoot.values()]
        })
        setSelectedWorkspaceRoot((current) => current ?? discovered[0].root)
      }
    } catch {
      // A non-Git historic session is intentionally left in 未分组.
    }
  }, [])

  const refreshThreads = useCallback(async (mode: ViewMode = viewMode, searchTerm = '') => {
    const response = await runtime.request<ThreadListResponse>('thread/list', {
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
    void mapThreadRoots(response.data)
    return response.data
  }, [mapThreadRoots, viewMode])

  const listAllActiveThreads = useCallback(async (): Promise<Thread[]> => {
    const allThreads: Thread[] = []
    let cursor: string | null = null

    do {
      const response: ThreadListResponse = await runtime.request<ThreadListResponse>('thread/list', {
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
      const response = await runtime.request<QueueListResponse>('thread/queue/list', { threadId, limit: 100 })
      setQueues((current) => ({ ...current, [threadId]: response.data }))
    } catch (error) {
      notify(`无法读取排队消息：${messageOf(error)}`, 'error')
    }
  }, [notify])

  const selectThread = useCallback(async (threadId: string) => {
    setSelectedThreadId(threadId)
    void runtime.setAppState('selectedThreadId', threadId).catch(() => undefined)
    markThreadRead(threadId)
    setBusy((current) => ({ ...current, [`load:${threadId}`]: true }))
    try {
      const response = await runtime.request<ResumeResponse>('thread/resume', {
        threadId,
        // Match the CLI's bounded history strategy: hydrate only the newest
        // page first, then let the user explicitly ask for older history.
        initialTurnsPage: { limit: 5, sortDirection: 'desc', itemsView: 'full' },
      })
      const initialTurns = response.initialTurnsPage?.data ?? response.thread.turns ?? []
      const turns = response.initialTurnsPage ? [...initialTurns].reverse() : initialTurns
      const items = turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })))
      const activeTurnId = findActiveTurn(turns)
      const owned = ownedActiveThreadsRef.current[threadId] === true
      setDetails((current) => ({
        ...current,
        [threadId]: {
          thread: response.thread,
          turns,
          items,
          nextTurnsCursor: response.initialTurnsPage?.nextCursor ?? null,
          activeTurnId,
          foreignActive: activeTurnId !== null && !owned,
        },
      }))
      upsertThread(response.thread)
      if (activeTurnId) {
        setActiveTurnIds((current) => ({ ...current, [threadId]: activeTurnId }))
      }
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
  }, [loadQueue, markThreadRead, notify, upsertThread])

  const loadOlderTurns = useCallback(async () => {
    const threadId = selectedThreadIdRef.current
    const cursor = threadId ? details[threadId]?.nextTurnsCursor : null
    if (!threadId || !cursor || busy.olderTurns) return

    setBusy((current) => ({ ...current, olderTurns: true }))
    try {
      const response = await runtime.request<TurnsPageResponse>('thread/turns/list', {
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
      if (!workspace) return
      setWorkspaces((current) => [workspace, ...current.filter((item) => item.root !== workspace.root)])
      setSelectedWorkspaceRoot(workspace.root)
      notify(`已添加 ${workspace.name}`)
      await refreshThreads()
    } catch (error) {
      notify(messageOf(error), 'error')
    }
  }, [notify, refreshThreads])

  const createThread = useCallback(async () => {
    if (!selectedWorkspaceRoot) {
      notify('请先在左侧选择一个 Git 主工作区。', 'error')
      return
    }
    setBusy((current) => ({ ...current, createThread: true }))
    try {
      const response = await runtime.request<StartThreadResponse>('thread/start', { cwd: selectedWorkspaceRoot })
      upsertThread(response.thread)
      setThreadRoots((current) => ({ ...current, [response.thread.id]: selectedWorkspaceRoot }))
      setSelectedThreadId(response.thread.id)
      void runtime.setAppState('selectedThreadId', response.thread.id).catch(() => undefined)
      markThreadRead(response.thread.id)
      // Do not call `thread/resume` here. A newly started, empty thread has no
      // persisted rollout yet, and App Server correctly rejects that request.
      setDetails((current) => ({ ...current, [response.thread.id]: emptyThreadDetail(response.thread) }))
    } catch (error) {
      notify(`无法创建会话：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, createThread: false }))
    }
  }, [markThreadRead, notify, selectedWorkspaceRoot, upsertThread])

  const changeThreadWorkspace = useCallback(async (threadId: string, workspaceRoot: string) => {
    if (!workspaceRoot || threadRoots[threadId] === workspaceRoot) return
    setBusy((current) => ({ ...current, threadWorkspace: true }))
    try {
      await runtime.request('thread/settings/update', { threadId, cwd: workspaceRoot })
      setThreadRoots((current) => ({ ...current, [threadId]: workspaceRoot }))
      setSelectedWorkspaceRoot(workspaceRoot)
      updateThread(threadId, (thread) => ({ ...thread, cwd: workspaceRoot }))
      updateDetail(threadId, (detail) => ({
        ...detail,
        thread: { ...detail.thread, cwd: workspaceRoot },
      }))
    } catch (error) {
      notify(`无法切换工作区：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, threadWorkspace: false }))
    }
  }, [notify, threadRoots, updateDetail, updateThread])

  const setActiveTurn = useCallback((threadId: string, turnId: string, owned: boolean) => {
    setActiveTurnIds((current) => ({ ...current, [threadId]: turnId }))
    setOwnedActiveThreads((current) => ({ ...current, [threadId]: owned }))
    updateDetail(threadId, (detail) => ({ ...detail, activeTurnId: turnId, foreignActive: !owned }))
    updateThread(threadId, (thread) => ({ ...thread, status: { type: 'active', activeFlags: [] } }))
    persistBadge(threadId, 'working')
  }, [persistBadge, updateDetail, updateThread])

  const startTurn = useCallback(async (threadId: string, text: string | null, inputs?: UserInput[]) => {
    locallyStartingRef.current.add(threadId)
    try {
      const response = await runtime.request<StartTurnResponse>('turn/start', {
        threadId,
        clientUserMessageId: newClientId(),
        input: inputs ?? (text ? [textInput(text)] : []),
      })
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
    const owned = ownedActiveThreadsRef.current[threadId] === true
    if (activeTurnId && !owned) {
      notify('该会话正由其他客户端运行；请等待当前轮结束。', 'error')
      return
    }
    setBusy((current) => ({ ...current, composer: true }))
    try {
      if (!activeTurnId) {
        await startTurn(threadId, null, input)
        return
      }

      const clientUserMessageId = newClientId()
      if (mode === 'queue') {
        await runtime.request('thread/queue/add', {
          threadId,
          clientUserMessageId,
          input,
        })
        await loadQueue(threadId)
        return
      }

      await runtime.request('turn/steer', {
        threadId,
        expectedTurnId: activeTurnId,
        clientUserMessageId,
        input,
      })
      setPendingSteers((current) => ({
        ...current,
        [threadId]: [...(current[threadId] ?? []), { clientUserMessageId, text: text.trim() || '附件', createdAt: Date.now() }],
      }))
    } catch (error) {
      notify(`无法发送消息：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, composer: false }))
    }
  }, [loadQueue, notify, startTurn])

  const stopTurn = useCallback(async () => {
    const threadId = selectedThreadIdRef.current
    if (!threadId) return
    const turnId = activeTurnIdsRef.current[threadId]
    if (!turnId || !ownedActiveThreadsRef.current[threadId]) return
    const steers = pendingSteers[threadId] ?? []
    if (steers.length > 0) pendingRestartRef.current[threadId] = steers
    setBusy((current) => ({ ...current, stop: true }))
    try {
      await runtime.request('turn/interrupt', { threadId, turnId })
    } catch (error) {
      delete pendingRestartRef.current[threadId]
      notify(`无法停止当前轮：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, stop: false }))
    }
  }, [notify, pendingSteers])

  const editQueue = useCallback(async (queueId: string, text: string) => {
    const threadId = selectedThreadIdRef.current
    if (!threadId || !text.trim()) return
    try {
      await runtime.request('thread/queue/update', { threadId, queuedSubmissionId: queueId, input: [textInput(text.trim())] })
      await loadQueue(threadId)
    } catch (error) {
      notify(`无法修改排队消息：${messageOf(error)}`, 'error')
    }
  }, [loadQueue, notify])

  const removeQueue = useCallback(async (queueId: string) => {
    const threadId = selectedThreadIdRef.current
    if (!threadId) return
    try {
      await runtime.request('thread/queue/delete', { threadId, queuedSubmissionId: queueId })
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
      // App Server has no atomic promote operation. Delete first avoids a duplicated follow-up;
      // on a failed steer we immediately restore the same server-owned queue entry.
      await runtime.request('thread/queue/delete', { threadId, queuedSubmissionId: queue.id })
      try {
        await runtime.request('turn/steer', {
          threadId,
          expectedTurnId: activeTurnId,
          clientUserMessageId: queue.clientUserMessageId,
          input: queue.input,
        })
      } catch (error) {
        await runtime.request('thread/queue/add', {
          threadId,
          clientUserMessageId: queue.clientUserMessageId,
          input: queue.input,
        }).catch(() => undefined)
        throw error
      }
      const text = queue.input.map((input) => input.type === 'text' ? input.text : '').filter(Boolean).join('\n')
      setPendingSteers((current) => ({
        ...current,
        [threadId]: [...(current[threadId] ?? []), { clientUserMessageId: queue.clientUserMessageId, text, createdAt: Date.now() }],
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
      const response = await runtime.request<StartTurnResponse>('thread/queue/start', { threadId, queuedSubmissionId: queue[0].id })
      setActiveTurn(threadId, response.turn.id, true)
    } catch (error) {
      notify(`无法继续队列：${messageOf(error)}`, 'error')
    }
  }, [notify, queues, setActiveTurn])

  const renameThread = useCallback(async (threadId: string, name: string) => {
    try {
      await runtime.request('thread/name/set', { threadId, name: name.trim() })
      updateThread(threadId, (thread) => ({ ...thread, name: name.trim() || null }))
      updateDetail(threadId, (detail) => ({ ...detail, thread: { ...detail.thread, name: name.trim() || null } }))
    } catch (error) {
      notify(`无法重命名会话：${messageOf(error)}`, 'error')
    }
  }, [notify, updateDetail, updateThread])

  const archiveThread = useCallback(async (threadId: string) => {
    try {
      await runtime.request('thread/archive', { threadId })
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
          await runtime.request('thread/archive', { threadId: thread.id })
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
      await runtime.request('thread/unarchive', { threadId })
      setThreads((current) => current.filter((thread) => thread.id !== threadId))
      if (selectedThreadIdRef.current === threadId) setSelectedThreadId(null)
      notify('已恢复会话')
    } catch (error) {
      notify(`无法恢复会话：${messageOf(error)}`, 'error')
    }
  }, [notify])

  const answerApproval = useCallback(async (request: ApprovalRequest, decision: unknown) => {
    try {
      await runtime.respond(request.id, approvalResult(request.method, decision))
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

  const handleEvent = useCallback((event: AppServerEvent) => {
    const method = event.method
    const params = event.params ?? {}
    if (!method) return

    if (event.id !== undefined && isApprovalRequest(method)) {
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
      if (thread) {
        upsertThread(thread)
        void mapThreadRoots([thread])
      }
      return
    }

    if (method === 'thread/status/changed') {
      const threadId = eventThreadId(params)
      const status = params.status as Thread['status'] | undefined
      if (threadId && status) {
        updateThread(threadId, (thread) => ({ ...thread, status }))
        updateDetail(threadId, (detail) => ({ ...detail, thread: { ...detail.thread, status } }))
        if (status.type === 'systemError') persistBadge(threadId, 'error')
      }
      return
    }

    if (method === 'thread/name/updated') {
      const threadId = eventThreadId(params)
      const name = typeof params.threadName === 'string' ? params.threadName : null
      if (threadId) {
        updateThread(threadId, (thread) => ({ ...thread, name }))
        updateDetail(threadId, (detail) => ({ ...detail, thread: { ...detail.thread, name } }))
      }
      return
    }

    if (method === 'thread/tokenUsage/updated') {
      const threadId = eventThreadId(params)
      const tokenUsage = parseTokenUsage(params.tokenUsage)
      if (threadId && tokenUsage) {
        setThreadTokenUsages((current) => ({ ...current, [threadId]: tokenUsage }))
      }
      return
    }

    if (method === 'turn/started') {
      const threadId = eventThreadId(params)
      const turn = params.turn as Turn | undefined
      if (threadId && turn) {
        const owned = locallyStartingRef.current.has(threadId) || ownedActiveThreadsRef.current[threadId] === true
        setActiveTurn(threadId, turn.id, owned)
        updateDetail(threadId, (detail) => ({
          ...detail,
          turns: upsertTurn(detail.turns, turn),
          items: turn.items.reduce((items, item) => upsertItem(items, turn.id, item), detail.items),
        }))
      }
      return
    }

    if (method === 'item/started' || method === 'item/completed') {
      const threadId = eventThreadId(params)
      const turnId = typeof params.turnId === 'string' ? params.turnId : null
      const item = toThreadItem(params.item)
      if (threadId && turnId && item) {
        updateDetail(threadId, (detail) => ({ ...detail, items: upsertItem(detail.items, turnId, item) }))
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
        updateDetail(threadId, (detail) => ({
          ...detail,
          items: updateItem(detail.items, itemId, (item) => ({ ...item, text: `${item.text ?? ''}${delta}` })),
        }))
      }
      return
    }

    if (method === 'item/commandExecution/outputDelta') {
      const threadId = eventThreadId(params)
      const itemId = typeof params.itemId === 'string' ? params.itemId : null
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (threadId && itemId) {
        updateDetail(threadId, (detail) => ({
          ...detail,
          items: updateItem(detail.items, itemId, (item) => ({ ...item, aggregatedOutput: `${item.aggregatedOutput ?? ''}${delta}` })),
        }))
      }
      return
    }

    if (method === 'turn/completed') {
      const threadId = eventThreadId(params)
      const turn = params.turn as Turn | undefined
      if (threadId && turn) {
        updateDetail(threadId, (detail) => ({
          ...detail,
          turns: upsertTurn(detail.turns, turn),
          items: turn.items.reduce((items, item) => upsertItem(items, turn.id, item), detail.items),
          activeTurnId: detail.activeTurnId === turn.id ? null : detail.activeTurnId,
        }))
        setActiveTurnIds((current) => {
          const next = { ...current }
          if (next[threadId] === turn.id) delete next[threadId]
          return next
        })
        setOwnedActiveThreads((current) => {
          const next = { ...current }
          delete next[threadId]
          return next
        })
        updateThread(threadId, (thread) => ({ ...thread, status: { type: 'idle' }, updatedAt: Math.floor(Date.now() / 1000) }))
        const badge: Badge = turn.status === 'failed' ? 'error' : selectedThreadIdRef.current === threadId ? null : 'success'
        persistBadge(threadId, badge)

        const restarts = pendingRestartRef.current[threadId]
        if (restarts?.length) {
          delete pendingRestartRef.current[threadId]
          setPendingSteers((current) => ({ ...current, [threadId]: [] }))
          void startTurn(threadId, null, restarts.map((steer) => textInput(steer.text))).catch((error) => {
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
      if (threadId) setThreads((current) => current.filter((thread) => thread.id !== threadId))
    }
  }, [loadQueue, mapThreadRoots, notify, persistBadge, setActiveTurn, startTurn, updateDetail, updateThread, upsertThread])

  useEffect(() => {
    let disposed = false
    let unlistenEvents: (() => void) | undefined
    let unlistenTransport: (() => void) | undefined
    const bootstrap = async () => {
      try {
        const [storedWorkspaces, storedStates, rememberedThreadId, storedNavigation, storedAppearance] = await Promise.all([
          runtime.listWorkspaces(),
          runtime.listThreadStates(),
          runtime.getAppState('selectedThreadId'),
          runtime.getAppState(NAVIGATION_PREFERENCES_KEY),
          runtime.getAppState(APPEARANCE_PREFERENCES_KEY),
        ])
        if (disposed) return
        setWorkspaces(storedWorkspaces)
        setThreadStates(Object.fromEntries(storedStates.map((state) => [state.threadId, state])))
        setNavigation(parseNavigationPreferences(storedNavigation))
        setAppearance(parseAppearancePreferences(storedAppearance))
        if (storedWorkspaces.length > 0) setSelectedWorkspaceRoot(storedWorkspaces[0].root)
        const loadedThreads = await refreshThreads('active')
        if (disposed) return
        setPhase('ready')
        if (rememberedThreadId && loadedThreads.some((thread) => thread.id === rememberedThreadId)) {
          void selectThread(rememberedThreadId)
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
  const activeTurnId = selectedThreadId ? activeTurnIds[selectedThreadId] ?? currentDetail?.activeTurnId ?? null : null
  const currentForeignActive = currentDetail?.foreignActive ?? (Boolean(activeTurnId) && !ownedActiveThreads[selectedThreadId ?? ''])

  return {
    phase,
    bootError,
    threads,
    workspaces,
    threadRoots,
    threadStates,
    details,
    threadTokenUsages,
    navigation,
    appearance,
    queues,
    approvals,
    pendingSteers,
    selectedThreadId,
    selectedWorkspaceRoot,
    viewMode,
    toast,
    busy,
    currentThread,
    currentDetail,
    currentTokenUsage,
    activeTurnId,
    currentForeignActive,
    isCurrentWorking: Boolean(activeTurnId),
    selectThread,
    loadOlderTurns,
    chooseWorkspace,
    createThread,
    startTurnInThread: (threadId: string, prompt: string) => startTurn(threadId, prompt),
    sendMessage,
    stopTurn,
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
    setSidebarWidth,
    setSidebarCollapsed,
    setFontSize,
    resetFontSizes,
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

function isApprovalRequest(method: string): boolean {
  return method === 'execCommandApproval'
    || method === 'applyPatchApproval'
    || method.endsWith('/requestApproval')
    || method === 'item/tool/requestUserInput'
}

function approvalResult(method: string, decision: unknown): JsonObject {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: decision === 'accept' ? 'approved' : { denied: { rejection: 'Denied in Codex Harness' } } }
  }
  if (method === 'item/tool/requestUserInput') return { answers: {} }
  return { decision }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
