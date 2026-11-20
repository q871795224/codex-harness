import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { desktopPetActivity } from '../../core/desktop-pet/activity'
import type { DesktopPetOpenTarget } from '../../core/desktop-pet/types'
import { notifications } from '../../core/notifications/service'
import { runtime } from '../../core/runtime/bridge'
import type { useUnifiedHarness } from '../conversation/useUnifiedHarness'
import { useReminderSources } from '../notifications/useReminderSources'

export function useDesktopPet(onOpen: (target: DesktopPetOpenTarget) => void, onError: (error: unknown) => void) {
  const [visible, setVisible] = useState(false)
  const callbacks = useRef({ onOpen, onError })
  callbacks.current = { onOpen, onError }
  useEffect(() => {
    let disposed = false
    const listeners: Array<() => void> = []
    const attach = async (listen: Promise<() => void>) => {
      const remove = await listen
      if (disposed) remove()
      else listeners.push(remove)
    }
    void Promise.all([
      attach(runtime.listenDesktopPetVisibility(next => { if (!disposed) setVisible(next) })),
      attach(runtime.listenDesktopPetOpen(target => { if (!disposed) callbacks.current.onOpen(target) })),
    ]).then(async () => {
      if (disposed) return
      const next = await runtime.desktopPetVisibility()
      if (!disposed) setVisible(next)
    }).catch(error => { if (!disposed) callbacks.current.onError(error) })
    return () => {
      disposed = true
      listeners.forEach(remove => remove())
    }
  }, [])
  return visible
}

type PetHarness = Pick<ReturnType<typeof useUnifiedHarness>, 'threads' | 'waitingThreadIds' | 'workingThreadIds' | 'selectedThreadId' | 'activeTurnIds' | 'approvals' | 'details' | 'onTurnCompleted'>

export function HarnessNotificationSources({ harness, petVisible }: { harness: PetHarness; petVisible: boolean }) {
  // Keep source-owned approval/watch resolution active when the main window is hidden.
  const waitingThreadIds = useMemo(() => Object.fromEntries(Object.entries(harness.waitingThreadIds)
    .filter(([id]) => !harness.details[id]?.thread.harnessAssistant)), [harness.waitingThreadIds, harness.details])
  useReminderSources({ ...harness, waitingThreadIds })
  const focusedThread = harness.selectedThreadId
  useEffect(() => {
    const syncFocus = () => {
      notifications.setFocusedThread(document.visibilityState === 'visible' && document.hasFocus() ? focusedThread : null)
      notifications.tick()
    }
    syncFocus()
    window.addEventListener('focus', syncFocus)
    window.addEventListener('blur', syncFocus)
    document.addEventListener('visibilitychange', syncFocus)
    return () => {
      window.removeEventListener('focus', syncFocus)
      window.removeEventListener('blur', syncFocus)
      document.removeEventListener('visibilitychange', syncFocus)
      notifications.setFocusedThread(null)
    }
  }, [focusedThread])
  const { records } = useSyncExternalStore(notifications.subscribe, notifications.snapshot)
  const working = Object.values(harness.workingThreadIds).some(Boolean)
  useEffect(() => {
    if (!petVisible) return
    void runtime.desktopPetPublish(desktopPetActivity(records, working)).catch(() => undefined)
  }, [records, working, petVisible])
  useEffect(() => {
    const next = records.reduce((due, record) =>
      !record.resolved && record.remindAt ? Math.min(due, record.remindAt) : due, Infinity)
    if (!Number.isFinite(next)) return
    const timer = window.setTimeout(() => notifications.tick(), Math.min(2_147_483_647, Math.max(0, next - Date.now())))
    return () => window.clearTimeout(timer)
  }, [records])
  return null
}
