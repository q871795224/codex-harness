import { appServer } from '../../core/runtime/appServerClient'
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ApprovalRequest, Thread, ThreadDetail } from '../../core/domain/codex'
import type { TurnCompletedEvent } from '../../core/conversations/types'
import type { AsyncWaitTask } from '../../core/async-waits/types'
import { runtime } from '../../core/runtime/bridge'
import { notifications } from '../../core/notifications/service'
import { questionRequestIdentity } from '../../core/questions/identity'

interface Sources {
  threads: Thread[]
  waitingThreadIds: Record<string, boolean>
  activeTurnIds: Record<string, string>
  approvals: Record<string, ApprovalRequest[]>
  details: Record<string, ThreadDetail>
  onTurnCompleted(listener: (event: TurnCompletedEvent) => void): () => void
}
export function useReminderSources(sources: Sources) {
  const loaded = useSyncExternalStore(notifications.subscribe, notifications.snapshot).loaded
  const seenWaiting = useRef(new Set<string>())
  const waits = useRef<AsyncWaitTask[]>([])
  const completions = useRef(new Map<string, TurnCompletedEvent>())
  const liveRevisions = useRef(new Map<string, number>())
  const processCompletion = useRef<(event: TurnCompletedEvent, includeWatch?: boolean) => void>(() => {})
  const recovery = useRef({ active: 0, pending: new Map<string, string>(), seen: new Set<string>(), disposed: false })
  const recover = useRef<(threadId: string, key: string) => void>(() => {})
  recover.current = (threadId, key) => {
    if (threadId.startsWith('claude:') || recovery.current.seen.has(key) || recovery.current.disposed) return
    recovery.current.seen.add(key); recovery.current.pending.set(threadId, key)
    const drain = () => {
      while (recovery.current.active < 2 && recovery.current.pending.size) {
        const [id, recoveryKey] = recovery.current.pending.entries().next().value!
        recovery.current.pending.delete(id); recovery.current.active++
        const revision = liveRevisions.current.get(id)
        void appServer.listTurns({ threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'summary' }).then((page) => {
          if (recovery.current.disposed || liveRevisions.current.get(id) !== revision) return
          const turn = page.data[0]
          if (!turn || !['completed', 'failed'].includes(turn.status)) return
          const watch = notifications.snapshot().records.find((record) => record.id === `watch:${id}` && record.watchThread)
          const at = turn.completedAt == null ? 0 : turn.completedAt < 1_000_000_000_000 ? turn.completedAt * 1000 : turn.completedAt
          const watched = Boolean(watch && at >= (watch.watchSince ?? watch.createdAt))
          if (watched || waits.current.some((task) => task.threadId === id && task.turnId === turn.id && task.status === 'delivered')) {
            processCompletion.current({ threadId: id, turnId: turn.id, status: turn.status, title: watch?.title ?? '会话处理结果' }, watched)
          }
        }).catch(() => { recovery.current.seen.delete(recoveryKey) }).finally(() => { recovery.current.active--; if (!recovery.current.disposed) drain() })
      }
    }
    drain()
  }
  useEffect(() => {
    recovery.current.disposed = false
    return () => { recovery.current.disposed = true; recovery.current.pending.clear() }
  }, [])
  useEffect(() => {
    if (!loaded) return
    for (const record of notifications.snapshot().records) if (record.watchThread && record.threadId) recover.current(record.threadId, `watch:${record.threadId}:${record.watchSince ?? record.createdAt}`)
  }, [loaded])
  useEffect(() => {
    const state = notifications.snapshot()
    if (!state.loaded) return
    for (const [threadId, waiting] of Object.entries(sources.waitingThreadIds)) {
      if (!waiting) continue
      seenWaiting.current.add(threadId)
      const thread = sources.threads.find((item) => item.id === threadId)
      const turnId = sources.activeTurnIds[threadId] ?? sources.details[threadId]?.activeTurnId
      const requests = (sources.approvals[threadId] ?? []).map(questionRequestIdentity).sort()
      const asyncItems = sources.details[threadId]?.items.filter(({ turnId: id, item }) => id === turnId && item.type === 'agentMessage' && item.delivery === 'async').map(({ item }) => item.id) ?? []
      const eventKey = `${turnId ?? 'pending'}:${requests.join(',')}:${asyncItems.join(',')}`
      if (state.records.some((record) => record.id === `attention:${threadId}` && record.state === 'pending' && record.eventKey === eventKey && !record.resolved)) continue
      notifications.publish({ id: `attention:${threadId}`, source: '会话', threadId, workspaceRoot: thread?.cwd, title: thread?.name || '会话需要回应',
        message: '有问题或操作等待你确认，打开原会话处理。', level: 'warning', attention: 'action', state: 'pending', eventKey })
    }
    for (const record of state.records) {
      const id = record.threadId
      if (!id || !record.id.startsWith('attention:') || record.resolved || sources.waitingThreadIds[id]) continue
      const detail = sources.details[id]
      // Missing/unloaded sessions are not evidence that a request was answered.
      if (seenWaiting.current.has(id) || (detail && !detail.activeTurnId && !sources.activeTurnIds[id])) notifications.resolve(record.id)
    }
  }, [sources.waitingThreadIds, sources.approvals, sources.activeTurnIds, sources.details, sources.threads, loaded])

  const publishWait = (task: AsyncWaitTask) => {
    const id = `async-wait:${task.id}`
    if (['awaitingApproval', 'paused', 'expired', 'uncertain'].includes(task.status) && task.summary !== '用户已暂停') {
      const label = task.status === 'awaitingApproval' ? '自定义异步任务等待你确认' : task.status === 'expired' ? '等待已到期' : task.status === 'uncertain' ? '续跑结果需要核对' : '等待已暂停'
      notifications.publish({ id, source: '异步等待', threadId: task.threadId, workspaceRoot: task.cwd, title: task.title,
        message: `${label}，请打开原会话查看并处理。`, level: 'warning', state: 'pending', attention: 'action', eventKey: `${task.status}:${task.revision}` })
    } else {
      notifications.resolve(id)
      if (task.status === 'notified') notifications.publish({ id: `async-result:${task.id}`, source: '异步等待', threadId: task.threadId, workspaceRoot: task.cwd,
        title: task.title, message: task.lastObservation ?? task.summary, level: 'info', attention: 'result', eventKey: task.id })
      if (task.status === 'delivered' && task.turnId) {
        const event = completions.current.get(`${task.threadId}:${task.turnId}`)
        if (event?.status === 'completed') notifications.publish({ id: `async-result:${task.id}`, source: '异步等待', threadId: task.threadId, workspaceRoot: task.cwd,
          title: task.title, message: '等待已就绪，Agent 后续处理已结束，可以查看结果。', level: 'info', attention: 'result', eventKey: task.turnId })
      }
    }
  }
  const publishWaitRef = useRef(publishWait); publishWaitRef.current = publishWait
  processCompletion.current = (event, includeWatch = true) => {
    const key = `${event.threadId}:${event.turnId}`
    completions.current.set(key, event)
    if (completions.current.size > 256) completions.current.delete(completions.current.keys().next().value!)
    const pending = notifications.snapshot().records.find((record) => record.id === `attention:${event.threadId}`)
    if (pending?.eventKey?.startsWith(`${event.turnId}:`)) notifications.resolve(pending.id)
    if (event.status === 'failed') {
      notifications.publish({ id: `failure:${event.threadId}`, source: '会话', threadId: event.threadId, title: event.title,
        message: '这一轮执行失败，请查看原会话后处理。', attention: 'action', level: 'error', eventKey: event.turnId })
    } else if (event.status === 'completed') {
      notifications.resolve(`failure:${event.threadId}`)
      if (includeWatch && notifications.snapshot().records.some((record) => record.id === `watch:${event.threadId}` && record.watchThread)) {
        notifications.publish({ id: `watch:${event.threadId}`, source: '会话关注', threadId: event.threadId, title: event.title,
          message: '新一轮处理已结束，可以查看结果。', attention: 'result', level: 'info', eventKey: event.turnId, state: 'done' })
      }
    }
    for (const task of waits.current) if (task.threadId === event.threadId && task.turnId === event.turnId) publishWaitRef.current(task)
  }
  useEffect(() => sources.onTurnCompleted((event) => {
    liveRevisions.current.set(event.threadId, (liveRevisions.current.get(event.threadId) ?? 0) + 1)
    processCompletion.current(event)
  }), [sources.onTurnCompleted])
  useEffect(() => {
    if (!runtime.listAsyncWaits || !runtime.listenAsyncWaits) return
    let disposed = false, sequence = 0
    let unlisten: (() => void) | undefined
    const refresh = async () => {
      const version = ++sequence
      try {
        const snapshot = await runtime.listAsyncWaits()
        if (disposed || version !== sequence || !snapshot) return
        notifications.resolve('async-wait:read')
        waits.current = snapshot.data
        if (snapshot.schedulerError) notifications.publish({ id: 'async-wait:scheduler', source: '异步等待', title: '后台等待检查异常', message: '请打开异步任务查看状态。', level: 'error', attention: 'action', state: 'pending' })
        else notifications.resolve('async-wait:scheduler')
        snapshot.data.forEach((task) => {
          publishWaitRef.current(task)
          if (task.status === 'delivered' && task.turnId && !completions.current.has(`${task.threadId}:${task.turnId}`)) recover.current(task.threadId, `wait:${task.id}:${task.turnId}`)
        })
      } catch (error) {
        if (!disposed) notifications.publish({ id: 'async-wait:read', source: '异步等待', title: '无法读取异步等待状态', message: '将继续尝试读取，已有任务状态请在原会话核对。', level: 'warning' })
      }
    }
    void runtime.listenAsyncWaits(() => { void refresh() }).then((stop) => {
      if (disposed) stop(); else { unlisten = stop; void notifications.initialize().then(refresh) }
    }).catch(() => { if (!disposed) void refresh() })
    return () => { disposed = true; unlisten?.() }
  }, [])
}
