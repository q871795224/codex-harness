import { useEffect, useRef, useSyncExternalStore } from 'react'
import { notifications } from '../../core/notifications/service'
import { runtime } from '../../core/runtime/bridge'
import { RELEASE_PHASE_LABELS, type ReleaseRunStatus } from '../../core/release-command/types'
import type { NotificationInput } from '../../core/notifications/store'

export function releaseNotification(status: ReleaseRunStatus): NotificationInput {
  const running = status.status === 'running'
  const failed = status.status === 'failed'
  const phase = RELEASE_PHASE_LABELS[status.phase]
  const reason = status.failureSummary ?? status.error
  const message = running ? phase : failed
    ? `在「${phase}」阶段停止。${reason ? reason : '该阶段没有返回具体错误，可以打开日志查看。'}`
    : status.warning ? (status.error ?? '发布已完成，仍有后续事项需要核对。') : '发布流程已完成。'
  return {
    id: `release:${status.runId}`,
    source: '发布',
    diagnostic: failed || status.warning,
    workspaceRoot: status.workspaceRoot,
    createdAt: status.startedAt,
    updatedAt: status.updatedAt,
    level: failed ? 'error' : status.warning ? 'warning' : 'info',
    title: `发布 ${status.version}${running ? ' 进行中' : failed ? ' 未完成' : status.warning ? ' 基本完成' : ' 已完成'}`,
    message,
    details: [status.error, status.logPath ? `日志：${status.logPath}` : null].filter(Boolean).join('\n') || undefined,
    actions: [{ kind: 'release-log', label: '查看日志', target: status.workspaceRoot, runId: status.runId }],
    state: running ? 'running' : 'done',
  }
}

/** Keep observing active releases when the user switches conversations or opens the center. */
export function useReleaseNotifications(status: ReleaseRunStatus | null) {
  const state = useSyncExternalStore(notifications.subscribe, notifications.snapshot)
  const roots = useRef(new Set<string>())
  useEffect(() => {
    if (!state.loaded) return
    for (const record of state.records) {
      if (record.source === '发布' && record.state === 'running' && record.workspaceRoot) roots.current.add(record.workspaceRoot)
    }
  }, [state.loaded])
  useEffect(() => {
    if (!status || !state.loaded) return
    notifications.publish(releaseNotification(status))
    if (status.status === 'running') roots.current.add(status.workspaceRoot)
    else roots.current.delete(status.workspaceRoot)
  }, [status, state.loaded])
  useEffect(() => {
    let disposed = false
    const pending = new Set<string>()
    const poll = () => {
      for (const root of roots.current) {
        if (pending.has(root)) continue
        pending.add(root)
        void runtime.releaseCommandStatus(root).then((next) => {
          if (disposed) return
          if (!next) { roots.current.delete(root); return }
          notifications.publish(releaseNotification(next))
          if (next.status !== 'running') roots.current.delete(root)
        }).catch((error) => {
          if (!disposed) console.warn('暂时无法读取发布进度', error)
        }).finally(() => pending.delete(root))
      }
    }
    const timer = window.setInterval(poll, 2000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])
}
