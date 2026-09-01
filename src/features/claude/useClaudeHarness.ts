import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { emptyThreadDetail, type ApprovalRequest, type Thread, type ThreadDetail, type Turn, type UserInput } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'
import type { ClaudeAdapterEvent, ClaudeRuntimeStatus, ClaudeSessionRecord } from '../../core/claude/types'
import { reduceClaudeEvent } from '../../core/claude/eventReducer'
import { reduceThreadDetailEvent } from '../conversation/conversationEventReducer'

interface ClaudeToast {
  kind: 'error' | 'info'
  message: string
}

export function useClaudeHarness() {
  const [status, setStatus] = useState<ClaudeRuntimeStatus | null>(null)
  const [sessions, setSessions] = useState<ClaudeSessionRecord[]>([])
  const [details, setDetails] = useState<Record<string, ThreadDetail>>({})
  const [activeTurnIds, setActiveTurnIds] = useState<Record<string, string>>({})
  const [approvals, setApprovals] = useState<Record<string, ApprovalRequest[]>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<ClaudeToast | null>(null)
  const sessionsRef = useRef<ClaudeSessionRecord[]>([])

  useEffect(() => { sessionsRef.current = sessions }, [sessions])
  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), toast.kind === 'error' ? 6_000 : 3_500)
    return () => window.clearTimeout(timer)
  }, [toast])

  const notify = useCallback((message: string, kind: ClaudeToast['kind'] = 'info') => {
    setToast({ message, kind })
  }, [])

  const refresh = useCallback(async (archived = false) => {
    const next = await runtime.listClaudeSessions(archived)
    setSessions(next)
    return next
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
    setSessions((sessions) => sessions.map((session) => session.id === saved.id ? saved : session))
  }, [])

  const handleEvent = useCallback((event: ClaudeAdapterEvent) => {
    const params = event.params ?? {}
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null
    if (!sessionId) return
    if (event.method === 'session/started' && typeof params.providerSessionId === 'string') {
      void persistProviderSession(sessionId, params.providerSessionId).catch((error) => notify(messageOf(error), 'error'))
      return
    }
    if (event.method === 'approval/requested' && typeof params.requestId === 'string') {
      const toolName = typeof params.toolName === 'string' ? params.toolName : 'Tool'
      const input = params.input && typeof params.input === 'object' ? params.input as Record<string, unknown> : {}
      const command = toolName === 'Bash' && typeof input.command === 'string' ? input.command : undefined
      const request: ApprovalRequest = {
        id: params.requestId,
        method: 'claude/tool/requestApproval',
        threadId: sessionId,
        params: {
          toolName,
          input,
          ...(command ? { command } : {}),
          reason: `Claude 请求使用 ${toolName}`,
        },
      }
      setApprovals((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), request] }))
      return
    }
    setDetails((current) => {
      const detail = current[sessionId]
      if (!detail) return current
      return { ...current, [sessionId]: reduceClaudeEvent(detail, event) }
    })
    if (event.method === 'turn/started' && typeof params.turnId === 'string') {
      setActiveTurnIds((current) => ({ ...current, [sessionId]: params.turnId as string }))
      setSessions((current) => current.map((session) => session.id === sessionId
        ? { ...session, updatedAt: Date.now() }
        : session))
    }
    if (event.method === 'turn/completed' || event.method === 'turn/failed' || event.method === 'turn/interrupted') {
      setActiveTurnIds((current) => {
        const next = { ...current }
        delete next[sessionId]
        return next
      })
      setApprovals((current) => ({ ...current, [sessionId]: [] }))
      if (event.method === 'turn/failed') notify(typeof params.message === 'string' ? params.message : 'Claude turn 失败', 'error')
    }
  }, [notify, persistProviderSession])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void Promise.all([runtime.claudeRuntimeStatus(), runtime.listClaudeSessions(false)])
      .then(([nextStatus, nextSessions]) => {
        if (disposed) return
        setStatus(nextStatus)
        setSessions(nextSessions)
      })
      .catch((error) => {
        if (!disposed) setStatus({ available: false, nodePath: null, claudePath: null, adapterPath: null, error: messageOf(error) })
      })
    void runtime.listenClaudeEvents(handleEvent).then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [handleEvent])

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
      setSessions((current) => [session, ...current.filter((candidate) => candidate.id !== session.id)])
      setDetails((current) => ({ ...current, [session.id]: emptyThreadDetail(sessionThread(session)) }))
      return session.id
    } catch (error) {
      notify(`无法创建 Claude 会话：${messageOf(error)}`, 'error')
      throw error
    } finally {
      setBusy((current) => ({ ...current, createThread: false }))
    }
  }, [notify])

  const sendMessage = useCallback(async (sessionId: string, input: UserInput[]) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId)
    if (!session || input.length === 0) return
    if (activeTurnIds[sessionId]) throw new Error('Claude 会话当前正在运行')
    const turnId = `claude-turn:${crypto.randomUUID()}`
    const userItemId = `claude-user:${crypto.randomUUID()}`
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
    setBusy((current) => ({ ...current, composer: true }))
    setActiveTurnIds((current) => ({ ...current, [sessionId]: turnId }))
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
    try {
      await runtime.startClaudeTurn({
        sessionId,
        providerSessionId: session.providerSessionId,
        turnId,
        cwd: session.cwd,
        input,
        permissionMode: 'default',
        maxTurns: 40,
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
      setActiveTurnIds((current) => {
        const next = { ...current }
        delete next[sessionId]
        return next
      })
      notify(`无法发送 Claude 消息：${messageOf(error)}`, 'error')
      throw error
    } finally {
      setBusy((current) => ({ ...current, composer: false }))
    }
  }, [activeTurnIds, notify])

  const stopTurn = useCallback(async (sessionId: string) => {
    if (!activeTurnIds[sessionId]) return
    setBusy((current) => ({ ...current, stop: true }))
    try {
      await runtime.interruptClaudeTurn(sessionId)
    } catch (error) {
      notify(`无法停止 Claude turn：${messageOf(error)}`, 'error')
    } finally {
      setBusy((current) => ({ ...current, stop: false }))
    }
  }, [activeTurnIds, notify])

  const answerApproval = useCallback(async (request: ApprovalRequest, decision: unknown) => {
    const allow = decision === 'accept' || decision === 'approved' || decision === 'acceptForSession'
    const input = request.params.input && typeof request.params.input === 'object'
      ? request.params.input as Record<string, unknown>
      : undefined
    try {
      await runtime.answerClaudeApproval(String(request.id), allow, input)
      setApprovals((current) => ({
        ...current,
        [request.threadId]: (current[request.threadId] ?? []).filter((item) => item.id !== request.id),
      }))
    } catch (error) {
      notify(`无法提交 Claude 审批：${messageOf(error)}`, 'error')
    }
  }, [notify])

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId)
    if (!session) return
    const saved = await runtime.upsertClaudeSession({
      id: session.id,
      providerSessionId: session.providerSessionId,
      cwd: session.cwd,
      title: title.trim() || 'Claude 会话',
    })
    setSessions((current) => current.map((candidate) => candidate.id === saved.id ? saved : candidate))
  }, [])

  const setArchived = useCallback(async (sessionId: string, archived: boolean) => {
    await runtime.setClaudeSessionArchived(sessionId, archived)
    setSessions((current) => current.filter((session) => session.id !== sessionId))
    notify(archived ? '已归档 Claude 会话' : '已恢复 Claude 会话')
  }, [notify])

  return {
    status,
    sessions,
    threads,
    details,
    activeTurnIds,
    approvals,
    busy,
    toast,
    refresh,
    selectSession,
    createSession,
    sendMessage,
    stopTurn,
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
