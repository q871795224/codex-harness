import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { emptyThreadDetail, textInput, type ApprovalRequest, type QueuedSubmission, type Thread, type ThreadDetail, type Turn, type UserInput } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import { approvalRequestFromEvent, reconcileClaudeApprovalSnapshot } from '../../core/claude/approvalState'
import type { ClaudeAdapterEvent, ClaudeContextUsage, ClaudeModel, ClaudeProviderSnapshot, ClaudeRuntimeStatus, ClaudeSessionRecord, ClaudeSessionSettings, ClaudeTransportEvent } from '../../core/claude/types'
import { DEFAULT_CLAUDE_SESSION_SETTINGS } from '../../core/claude/types'
import { reduceClaudeEvent } from '../../core/claude/eventReducer'
import { reduceThreadDetailEvent } from '../conversation/conversationEventReducer'
import type { TurnCompletedEvent } from '../../core/conversations/types'

const CLAUDE_MAX_TURNS = 65_536
const CLAUDE_SESSION_SETTINGS_KEY = 'claude.sessionSettings'

interface ClaudeToast {
  kind: 'error' | 'info'
  message: string
}

export function useClaudeHarness() {
  const [status, setStatus] = useState<ClaudeRuntimeStatus | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [sessions, setSessions] = useState<ClaudeSessionRecord[]>([])
  const [details, setDetails] = useState<Record<string, ThreadDetail>>({})
  const [activeTurnIds, setActiveTurnIds] = useState<Record<string, string>>({})
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest[]>>({})
  const [queues, setQueues] = useState<Record<string, QueuedSubmission[]>>({})
  const [models, setModels] = useState<ClaudeModel[]>([])
  const [sessionSettings, setSessionSettings] = useState<Record<string, ClaudeSessionSettings>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<ClaudeToast | null>(null)
  const sessionsRef = useRef<ClaudeSessionRecord[]>([])
  const activeTurnIdsRef = useRef<Record<string, string>>({})
  const approvalsRef = useRef<Record<string, ApprovalRequest[]>>({})
  const queuesRef = useRef<Record<string, QueuedSubmission[]>>({})
  const settingsRef = useRef<Record<string, ClaudeSessionSettings>>({})
  const turnCompletedListenersRef = useRef(new Set<(event: TurnCompletedEvent) => void>())
  const manualStopRef = useRef(new Set<string>())
  const interjectRef = useRef(new Set<string>())
  const daemonInstanceIdRef = useRef<string | null>(null)
  const approvalEventSeqRef = useRef<Record<string, number>>({})
  const approvalResolvedSeqRef = useRef<Record<string, number>>({})

  useEffect(() => { sessionsRef.current = sessions }, [sessions])
  useEffect(() => { activeTurnIdsRef.current = activeTurnIds }, [activeTurnIds])
  useEffect(() => { approvalsRef.current = approvals }, [approvals])
  useEffect(() => { queuesRef.current = queues }, [queues])
  useEffect(() => { settingsRef.current = sessionSettings }, [sessionSettings])
  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), toast.kind === 'error' ? 6_000 : 3_500)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    void runtime.getAppState(CLAUDE_SESSION_SETTINGS_KEY).then((value) => {
      const parsed = parseSessionSettings(value)
      settingsRef.current = parsed
      setSessionSettings(parsed)
    }).catch(() => undefined)
  }, [])

  const notify = useCallback((message: string, kind: ClaudeToast['kind'] = 'info') => {
    setToast({ message, kind })
  }, [])

  const onTurnCompleted = useCallback((listener: (event: TurnCompletedEvent) => void) => {
    turnCompletedListenersRef.current.add(listener)
    return () => { turnCompletedListenersRef.current.delete(listener) }
  }, [])

  useEffect(() => {
    const cwd = sessions[0]?.cwd
    if (!status?.available || !cwd) return
    let disposed = false
    void runtime.listClaudeModels(cwd).then((result) => {
      if (!disposed) setModels(result.models)
    }).catch((error) => {
      if (!disposed) notify(`无法读取 Claude 模型列表：${messageOf(error)}`, 'error')
    })
    return () => { disposed = true }
  }, [notify, sessions[0]?.cwd, status?.available])

  const refresh = useCallback(async (archived = false) => {
    const next = await runtime.listClaudeSessions(archived)
    sessionsRef.current = next
    setSessions(next)
    return next
  }, [])

  const settingsForSession = useCallback((sessionId: string | null): ClaudeSessionSettings => {
    if (!sessionId) return DEFAULT_CLAUDE_SESSION_SETTINGS
    return sessionSettings[sessionId] ?? DEFAULT_CLAUDE_SESSION_SETTINGS
  }, [sessionSettings])

  const updateSessionSettings = useCallback((sessionId: string, patch: Partial<ClaudeSessionSettings>) => {
    setSessionSettings((current) => {
      const next = {
        ...current,
        [sessionId]: { ...DEFAULT_CLAUDE_SESSION_SETTINGS, ...(current[sessionId] ?? {}), ...patch },
      }
      settingsRef.current = next
      void runtime.setAppState(CLAUDE_SESSION_SETTINGS_KEY, JSON.stringify(next)).catch(() => undefined)
      return next
    })
  }, [])

  const refreshContext = useCallback(async (sessionId: string) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId)
    if (!session || !session.providerSessionId) return
    try {
      const context = await runtime.readClaudeContext(sessionId, session.cwd, session.providerSessionId)
      if (!context) return
      setDetails((current) => {
        const detail = current[sessionId]
        if (!detail) return current
        const tokenUsage = detail.tokenUsage ?? {
          total: emptyTokenBreakdown(),
          last: emptyTokenBreakdown(),
          modelContextWindow: context.rawMaxTokens || context.maxTokens || null,
        }
        return {
          ...current,
          [sessionId]: {
            ...detail,
            tokenUsage: {
              ...tokenUsage,
              modelContextWindow: context.rawMaxTokens || context.maxTokens || tokenUsage.modelContextWindow,
              contextTokens: context.totalTokens,
            },
          },
        }
      })
    } catch {
      // The usage event already provides a safe fallback for the context ring.
    }
  }, [])

  const persistProviderSession = useCallback(async (sessionId: string, providerSessionId: string) => {
    const current = sessionsRef.current.find((session) => session.id === sessionId)
    if (!current || current.providerSessionId === providerSessionId) return
    const saved = await runtime.upsertClaudeSession({
      id: current.id,
      providerSessionId,
      cwd: current.cwd,
      title: current.title,
    })
    setSessions((sessions) => {
      const next = sessions.map((session) => session.id === saved.id ? saved : session)
      sessionsRef.current = next
      return next
    })
  }, [])

  const beginTurn = useCallback(async (sessionId: string, input: UserInput[], turnId = `claude-turn:${crypto.randomUUID()}`) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId)
    if (!session || input.length === 0) return
    if (activeTurnIdsRef.current[sessionId]) throw new Error('Claude 会话当前正在运行')
    const userItemId = `${turnId}:user`
    const startedAt = Date.now()
    const newTurn: Turn = {
      id: turnId,
      items: [],
      status: 'inProgress',
      error: null,
      startedAt,
      completedAt: null,
      durationMs: null,
    }
    const nextActive = { ...activeTurnIdsRef.current, [sessionId]: turnId }
    activeTurnIdsRef.current = nextActive
    setActiveTurnIds(nextActive)
    setBusy((current) => ({ ...current, composer: true }))
    setDetails((current) => {
      const base = current[sessionId] ?? emptyThreadDetail(sessionThread(session))
      const withTurn = reduceThreadDetailEvent(base, { type: 'turnStarted', turn: newTurn })
      const withUser = reduceThreadDetailEvent(withTurn, {
        type: 'itemUpserted',
        turnId,
        item: { id: userItemId, type: 'userMessage', content: input },
      })
      return { ...current, [sessionId]: { ...withUser, activeTurnId: turnId } }
    })
    const settings = settingsRef.current[sessionId] ?? DEFAULT_CLAUDE_SESSION_SETTINGS
    const selectedModel = models.find((model) => model.value === settings.model) ?? models[0] ?? null
    const model = selectedModel?.value
    const effort = selectedModel && selectedModel.supportedEffortLevels.includes(settings.effort ?? '')
      ? settings.effort!
      : selectedModel?.supportedEffortLevels[0]
    try {
      await runtime.startClaudeTurn({
        sessionId,
        providerSessionId: session.providerSessionId,
        turnId,
        cwd: session.cwd,
        input,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        permissionMode: settings.permissionMode,
        maxTurns: CLAUDE_MAX_TURNS,
      })
    } catch (error) {
      setDetails((current) => {
        const detail = current[sessionId]
        if (!detail) return current
        return {
          ...current,
          [sessionId]: reduceClaudeEvent(detail, {
            method: 'turn/failed',
            params: { sessionId, turnId, message: messageOf(error) },
          }),
        }
      })
      const next = { ...activeTurnIdsRef.current }
      if (next[sessionId] === turnId) delete next[sessionId]
      activeTurnIdsRef.current = next
      setActiveTurnIds(next)
      notify(`无法发送 Claude 消息：${messageOf(error)}`, 'error')
      throw error
    } finally {
      setBusy((current) => ({ ...current, composer: false }))
    }
  }, [models, notify])

  const drainQueue = useCallback(async (sessionId: string) => {
    if (activeTurnIdsRef.current[sessionId]) return
    if (manualStopRef.current.delete(sessionId)) return
    const queue = queuesRef.current[sessionId] ?? []
    const next = queue[0]
    if (!next) {
      interjectRef.current.delete(sessionId)
      return
    }
    const remaining = queue.slice(1)
    queuesRef.current = { ...queuesRef.current, [sessionId]: remaining }
    setQueues(queuesRef.current)
    interjectRef.current.delete(sessionId)
    await beginTurn(sessionId, next.input)
  }, [beginTurn])

  const sendMessage = useCallback(async (sessionId: string, input: UserInput[], mode: 'interject' | 'queue') => {
    if (input.length === 0) return
    if (!activeTurnIdsRef.current[sessionId]) {
      await beginTurn(sessionId, input)
      return
    }
    const queued: QueuedSubmission = {
      id: `claude-queue:${crypto.randomUUID()}`,
      input,
      clientUserMessageId: crypto.randomUUID(),
    }
    const nextQueue = [...(queuesRef.current[sessionId] ?? []), queued]
    queuesRef.current = { ...queuesRef.current, [sessionId]: nextQueue }
    setQueues(queuesRef.current)
    if (mode === 'interject' && !interjectRef.current.has(sessionId)) {
      interjectRef.current.add(sessionId)
      try {
        await runtime.interruptClaudeTurn(sessionId)
      } catch (error) {
        interjectRef.current.delete(sessionId)
        notify(`无法插话 Claude turn：${messageOf(error)}`, 'error')
      }
    }
  }, [beginTurn, notify])

  const editQueue = useCallback((sessionId: string, queueId: string, text: string) => {
    const value = text.trim()
    if (!value) return
    const nextQueue = (queuesRef.current[sessionId] ?? []).map((item) => item.id === queueId
      ? { ...item, input: [textInput(value)] }
      : item)
    queuesRef.current = { ...queuesRef.current, [sessionId]: nextQueue }
    setQueues(queuesRef.current)
  }, [])

  const removeQueue = useCallback((sessionId: string, queueId: string) => {
    const nextQueue = (queuesRef.current[sessionId] ?? []).filter((item) => item.id !== queueId)
    queuesRef.current = { ...queuesRef.current, [sessionId]: nextQueue }
    setQueues(queuesRef.current)
  }, [])

  const promoteQueue = useCallback(async (sessionId: string, item: QueuedSubmission) => {
    const queue = queuesRef.current[sessionId] ?? []
    const promoted = queue.find((candidate) => candidate.id === item.id)
    if (!promoted) return
    const nextQueue = [promoted, ...queue.filter((candidate) => candidate.id !== item.id)]
    queuesRef.current = { ...queuesRef.current, [sessionId]: nextQueue }
    setQueues(queuesRef.current)
    if (activeTurnIdsRef.current[sessionId] && !interjectRef.current.has(sessionId)) {
      interjectRef.current.add(sessionId)
      try {
        await runtime.interruptClaudeTurn(sessionId)
      } catch (error) {
        interjectRef.current.delete(sessionId)
        notify(`无法插话 Claude turn：${messageOf(error)}`, 'error')
      }
    } else {
      await drainQueue(sessionId)
    }
  }, [drainQueue, notify])

  const startQueue = useCallback((sessionId: string) => drainQueue(sessionId), [drainQueue])

  const replaceApprovals = useCallback((next: Record<string, ApprovalRequest[]>) => {
    approvalsRef.current = next
    setApprovals(next)
  }, [])

  const removeApproval = useCallback((sessionId: string, requestId: string) => {
    const next = {
      ...approvalsRef.current,
      [sessionId]: (approvalsRef.current[sessionId] ?? []).filter((item) => String(item.id) !== requestId),
    }
    delete approvalEventSeqRef.current[requestId]
    replaceApprovals(next)
  }, [replaceApprovals])

  const applyProviderSnapshot = useCallback((provider: ClaudeProviderSnapshot) => {
    const previousDaemonInstanceId = daemonInstanceIdRef.current
    const nextDaemonInstanceId = typeof provider.daemonInstanceId === 'string' ? provider.daemonInstanceId : null
    const daemonChanged = previousDaemonInstanceId !== null
      && nextDaemonInstanceId !== null
      && previousDaemonInstanceId !== nextDaemonInstanceId
    daemonInstanceIdRef.current = nextDaemonInstanceId

    const active = Array.isArray(provider.activeTurns)
      ? Object.fromEntries(provider.activeTurns
        .filter((turn) => typeof turn?.sessionId === 'string' && typeof turn?.turnId === 'string')
        .map((turn) => [turn.sessionId, turn.turnId]))
      : {}
    activeTurnIdsRef.current = active
    setActiveTurnIds(active)

    if (!Array.isArray(provider.pendingApprovals)) return
    const snapshotSeq = Number.isSafeInteger(provider.snapshotSeq)
      ? provider.snapshotSeq
      : Number.isSafeInteger(provider.latestEventSeq) ? provider.latestEventSeq : null
    const sequenceState = daemonChanged
      ? { eventSeqById: {}, resolvedSeqById: {} }
      : { eventSeqById: approvalEventSeqRef.current, resolvedSeqById: approvalResolvedSeqRef.current }
    const result = reconcileClaudeApprovalSnapshot(
      approvalsRef.current,
      provider.pendingApprovals,
      snapshotSeq,
      sequenceState.eventSeqById,
      sequenceState.resolvedSeqById,
      !daemonChanged,
    )
    approvalEventSeqRef.current = result.eventSeqById
    approvalResolvedSeqRef.current = result.resolvedSeqById
    replaceApprovals(result.approvals)
  }, [replaceApprovals])

  const handleEvent = useCallback((event: ClaudeAdapterEvent) => {
    const params = event.params ?? {}
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null
    if (!sessionId) return
    if (event.method === 'session/started' && typeof params.providerSessionId === 'string') {
      void persistProviderSession(sessionId, params.providerSessionId).catch((error) => notify(messageOf(error), 'error'))
      return
    }
    if ((event.method === 'approval/resolved' || event.method === 'approval/expired') && typeof params.requestId === 'string') {
      if (event.replayed) return
      const requestId = params.requestId
      const eventSeq = eventSequence(event)
      if (eventSeq !== null) approvalResolvedSeqRef.current[requestId] = eventSeq
      removeApproval(sessionId, requestId)
      return
    }
    if (event.method === 'approval/requested') {
      if (event.replayed) return
      const request = approvalRequestFromEvent(event)
      if (!request) return
      const requestId = String(request.id)
      const eventSeq = eventSequence(event)
      if (eventSeq !== null) approvalEventSeqRef.current[requestId] = eventSeq
      delete approvalResolvedSeqRef.current[requestId]
      const next = {
        ...approvalsRef.current,
        [sessionId]: [...(approvalsRef.current[sessionId] ?? []).filter((item) => String(item.id) !== requestId), request],
      }
      replaceApprovals(next)
      return
    }
    setDetails((current) => {
      const session = sessionsRef.current.find((candidate) => candidate.id === sessionId)
      const detail = current[sessionId] ?? (session ? emptyThreadDetail(sessionThread(session)) : null)
      if (!detail) return current
      return { ...current, [sessionId]: reduceClaudeEvent(detail, event) }
    })
    if (!event.replayed && event.method === 'turn/started' && typeof params.turnId === 'string') {
      setActiveTurnIds((current) => {
        const next = { ...current, [sessionId]: params.turnId as string }
        activeTurnIdsRef.current = next
        return next
      })
      setSessions((current) => {
        const next = current.map((session) => session.id === sessionId
          ? { ...session, updatedAt: Date.now() }
          : session)
        sessionsRef.current = next
        return next
      })
    }
    if (!event.replayed && (event.method === 'turn/completed' || event.method === 'turn/failed' || event.method === 'turn/interrupted')) {
      const eventSeq = eventSequence(event)
      for (const request of approvalsRef.current[sessionId] ?? []) {
        const requestId = String(request.id)
        if (eventSeq !== null) approvalResolvedSeqRef.current[requestId] = eventSeq
        delete approvalEventSeqRef.current[requestId]
      }
      setActiveTurnIds((current) => {
        const next = { ...current }
        delete next[sessionId]
        activeTurnIdsRef.current = next
        return next
      })
      replaceApprovals({ ...approvalsRef.current, [sessionId]: [] })
      if (event.method === 'turn/failed') notify(typeof params.message === 'string' ? params.message : 'Claude turn 失败', 'error')
      if (event.method === 'turn/completed') {
        const providerSessionId = typeof params.providerSessionId === 'string' ? params.providerSessionId : null
        if (providerSessionId) {
          void persistProviderSession(sessionId, providerSessionId)
            .then(() => refreshContext(sessionId))
            .catch(() => undefined)
        } else {
          void refreshContext(sessionId)
        }
        const session = sessionsRef.current.find((candidate) => candidate.id === sessionId)
        if (session) {
          const completedEvent: TurnCompletedEvent = {
            threadId: sessionId,
            turnId: typeof params.turnId === 'string' ? params.turnId : '',
            title: session.title,
            status: 'completed',
          }
          for (const listener of turnCompletedListenersRef.current) listener(completedEvent)
        }
      }
      void drainQueue(sessionId).catch((error) => notify(`无法继续 Claude 排队消息：${messageOf(error)}`, 'error'))
    }
  }, [drainQueue, notify, persistProviderSession, refreshContext, removeApproval, replaceApprovals])

  useEffect(() => {
    let disposed = false
    let unlistenEvents: (() => void) | undefined
    let unlistenTransport: (() => void) | undefined
    let reconnectTimer: number | undefined
    const handleTransport = (event: ClaudeTransportEvent) => {
      if (event.kind === 'connected') {
        setStatus((current) => current ? { ...current, managed: event.managed ?? current.managed, running: true, error: null } : current)
        return
      }
      setStatus((current) => current ? { ...current, running: false } : current)
      const interrupted = activeTurnIdsRef.current
      if (Object.keys(interrupted).length > 0) {
        setDetails((current) => {
          const next = { ...current }
          for (const [sessionId, turnId] of Object.entries(interrupted)) {
            const detail = next[sessionId]
            if (!detail) continue
            next[sessionId] = reduceClaudeEvent(detail, {
              method: 'turn/failed',
              params: { sessionId, turnId, message: 'Claude Provider 异常退出，当前 turn 无法恢复。' },
            })
          }
          return next
        })
        activeTurnIdsRef.current = {}
        setActiveTurnIds({})
        setApprovals({})
        notify('Claude Provider 已重启；中断的 turn 需要重新发送。', 'error')
      }
      reconnectTimer = window.setTimeout(() => {
        void runtime.claudeRequest<ClaudeProviderSnapshot>('runtime/status')
          .then((provider) => {
            if (!disposed) applyProviderSnapshot(provider)
            return runtime.claudeRuntimeStatus()
          })
          .then((nextStatus) => { if (!disposed) setStatus(nextStatus) })
          .catch(() => undefined)
      }, 400)
    }
    void (async () => {
      try {
        const [disposeEvents, disposeTransport] = await Promise.all([
          runtime.listenClaudeEvents(handleEvent),
          runtime.listenClaudeTransport(handleTransport),
        ])
        if (disposed) {
          disposeEvents()
          disposeTransport()
          return
        }
        unlistenEvents = disposeEvents
        unlistenTransport = disposeTransport
        const [nextStatus, nextSessions] = await Promise.all([
          runtime.claudeRuntimeStatus(),
          runtime.listClaudeSessions(false),
        ])
        if (disposed) return
        sessionsRef.current = nextSessions
        setStatus(nextStatus)
        setSessions(nextSessions)
        setDetails((current) => {
          const next = { ...current }
          for (const session of nextSessions) {
            next[session.id] ??= emptyThreadDetail(sessionThread(session))
          }
          return next
        })
        if (nextStatus.available) {
          const provider = await runtime.claudeRequest<ClaudeProviderSnapshot>('runtime/status')
          if (!disposed) applyProviderSnapshot(provider)
          const connectedStatus = await runtime.claudeRuntimeStatus()
          if (!disposed) setStatus(connectedStatus)
        }
      } catch (error) {
        if (!disposed) setStatus(unavailableStatus(messageOf(error)))
      } finally {
        if (!disposed) setLoaded(true)
      }
    })()
    return () => {
      disposed = true
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      unlistenEvents?.()
      unlistenTransport?.()
    }
  }, [applyProviderSnapshot, handleEvent])

  const threads = useMemo(
    () => sessions.map((session) => sessionThread(session, Boolean(activeTurnIds[session.id]))),
    [activeTurnIds, sessions],
  )

  const selectSession = useCallback((sessionId: string) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId)
    if (!session) return
    setDetails((current) => current[sessionId]
      ? current
      : { ...current, [sessionId]: emptyThreadDetail(sessionThread(session)) })
  }, [])

  const createSession = useCallback(async (cwd: string) => {
    setBusy((current) => ({ ...current, createThread: true }))
    try {
      const runtimeStatus = await runtime.claudeRuntimeStatus()
      setStatus(runtimeStatus)
      if (!runtimeStatus.available) throw new Error(runtimeStatus.error ?? 'Claude runtime 不可用')
      const session = await runtime.upsertClaudeSession({
        id: `claude:${crypto.randomUUID()}`,
        providerSessionId: null,
        cwd,
        title: 'Claude 会话',
      })
      setSessions((current) => {
        const next = [session, ...current.filter((candidate) => candidate.id !== session.id)]
        sessionsRef.current = next
        return next
      })
      setDetails((current) => ({ ...current, [session.id]: emptyThreadDetail(sessionThread(session)) }))
      setSessionSettings((current) => {
        const next = { ...current, [session.id]: current[session.id] ?? DEFAULT_CLAUDE_SESSION_SETTINGS }
        settingsRef.current = next
        return next
      })
      return session.id
    } catch (error) {
      notify(`无法创建 Claude 会话：${messageOf(error)}`, 'error')
      throw error
    } finally {
      setBusy((current) => ({ ...current, createThread: false }))
    }
  }, [notify])

  const stopTurn = useCallback(async (sessionId: string) => {
    if (!activeTurnIdsRef.current[sessionId]) return
    manualStopRef.current.add(sessionId)
    setBusy((current) => ({ ...current, stop: true }))
    try {
      await runtime.interruptClaudeTurn(sessionId)
    } catch (error) {
      manualStopRef.current.delete(sessionId)
      notify(`无法停止 Claude turn：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, stop: false }))
    }
  }, [notify])

  const answerApproval = useCallback(async (request: ApprovalRequest, decision: unknown) => {
    const allow = decision === 'accept' || decision === 'approved' || decision === 'acceptForSession'
    const input = request.params.input && typeof request.params.input === 'object'
      ? request.params.input as Record<string, unknown>
      : undefined
    try {
      const result = await runtime.answerClaudeApproval(String(request.id), allow, input)
      if (typeof result?.resolvedSeq === 'number' && Number.isSafeInteger(result.resolvedSeq)) {
        approvalResolvedSeqRef.current[String(request.id)] = result.resolvedSeq
      }
      removeApproval(request.threadId, String(request.id))
    } catch (error) {
      notify(`无法提交 Claude 审批：${messageOf(error)}`, 'error')
    }
  }, [notify, removeApproval])

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId)
    if (!session) return
    const saved = await runtime.upsertClaudeSession({
      id: session.id,
      providerSessionId: session.providerSessionId,
      cwd: session.cwd,
      title: title.trim() || 'Claude 会话',
    })
    setSessions((current) => {
      const next = current.map((candidate) => candidate.id === saved.id ? saved : candidate)
      sessionsRef.current = next
      return next
    })
  }, [])

  const setArchived = useCallback(async (sessionId: string, archived: boolean) => {
    await runtime.setClaudeSessionArchived(sessionId, archived)
    setSessions((current) => {
      const next = current.filter((session) => session.id !== sessionId)
      sessionsRef.current = next
      return next
    })
    if (archived) {
      const nextQueues = { ...queuesRef.current }
      delete nextQueues[sessionId]
      queuesRef.current = nextQueues
      setQueues(nextQueues)
    }
    notify(archived ? '已归档 Claude 会话' : '已恢复 Claude 会话')
  }, [notify])

  return {
    status,
    loaded,
    sessions,
    threads,
    details,
    activeTurnIds,
    approvals,
    queues,
    models,
    sessionSettings,
    busy,
    toast,
    refresh,
    settingsForSession,
    updateSessionSettings,
    refreshContext,
    onTurnCompleted,
    selectSession,
    createSession,
    sendMessage,
    stopTurn,
    editQueue: (sessionId: string, queueId: string, text: string) => editQueue(sessionId, queueId, text),
    removeQueue: (sessionId: string, queueId: string) => removeQueue(sessionId, queueId),
    promoteQueue: (sessionId: string, item: QueuedSubmission) => promoteQueue(sessionId, item),
    startQueue: (sessionId: string) => startQueue(sessionId),
    answerApproval,
    renameSession,
    archiveSession: (sessionId: string) => setArchived(sessionId, true),
    unarchiveSession: (sessionId: string) => setArchived(sessionId, false),
  }
}

function sessionThread(session: ClaudeSessionRecord, active = false): Thread {
  return {
    id: session.id,
    provider: 'claude',
    preview: '',
    cwd: session.cwd,
    name: session.title,
    createdAt: session.createdAt / 1_000,
    updatedAt: session.updatedAt / 1_000,
    recencyAt: session.updatedAt / 1_000,
    status: active ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    ephemeral: false,
    canAcceptDirectInput: true,
    gitInfo: null,
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseSessionSettings(value: string | null): Record<string, ClaudeSessionSettings> {
  if (!value) return {}
  try {
    const raw = JSON.parse(value)
    if (!raw || typeof raw !== 'object') return {}
    const result: Record<string, ClaudeSessionSettings> = {}
    for (const [sessionId, candidate] of Object.entries(raw)) {
      if (!candidate || typeof candidate !== 'object') continue
      const input = candidate as Record<string, unknown>
      const permissionMode = input.permissionMode === 'acceptEdits' || input.permissionMode === 'plan'
        || input.permissionMode === 'dontAsk' || input.permissionMode === 'bypassPermissions'
        ? input.permissionMode
        : 'default'
      result[sessionId] = {
        model: typeof input.model === 'string' && input.model ? input.model : null,
        effort: typeof input.effort === 'string' && input.effort ? input.effort : null,
        permissionMode,
      }
    }
    return result
  } catch {
    return {}
  }
}

function emptyTokenBreakdown() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  }
}

function unavailableStatus(error: string): ClaudeRuntimeStatus {
  return {
    available: false,
    managed: false,
    running: false,
    nodePath: null,
    claudePath: null,
    daemonPath: null,
    socketPath: null,
    error,
  }
}

function eventSequence(event: ClaudeAdapterEvent): number | null {
  return typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : null
}
