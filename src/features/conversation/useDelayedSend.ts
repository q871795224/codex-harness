import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MessageReference, UserInput } from '../../core/domain/codex'
import type { ComposerDraft } from './Composer'

export interface DelayedMessage {
  input: UserInput[]
  mode: 'interject' | 'queue'
  references?: MessageReference[]
  titleSource?: string
  draft: ComposerDraft
}

export interface DelayedSend {
  dueAt: number
  sending: boolean
  message: DelayedMessage
}

// Owned by App so changing conversations or collapsing the composer keeps the timer alive.
// Only the ordinary unsent draft is persisted; closing the app cancels the timer.
export function useDelayedSend(
  send: (threadId: string, message: DelayedMessage) => Promise<void>,
  onError: (threadId: string, error: unknown) => void,
) {
  const [pending, setPending] = useState<Record<string, DelayedSend>>({})
  const pendingRef = useRef(pending)
  const callbacks = useRef({ send, onError })
  useLayoutEffect(() => { callbacks.current = { send, onError } }, [send, onError])

  const update = (next: Record<string, DelayedSend>) => {
    pendingRef.current = next
    setPending(next)
  }
  const cancel = (threadId: string) => {
    if (!pendingRef.current[threadId] || pendingRef.current[threadId].sending) return
    const next = { ...pendingRef.current }
    delete next[threadId]
    update(next)
  }
  const schedule = (threadId: string, minutes: 1 | 5 | 10, message: DelayedMessage) => {
    if (pendingRef.current[threadId]) return
    update({ ...pendingRef.current, [threadId]: {
      dueAt: Date.now() + minutes * 60_000,
      sending: false,
      message: structuredClone(message),
    } })
  }

  useEffect(() => {
    const waiting = Object.values(pending).filter(job => !job.sending)
    if (!waiting.length) return
    const timer = window.setTimeout(() => {
      for (const [threadId, job] of Object.entries(pendingRef.current)) {
        if (job.sending || job.dueAt > Date.now()) continue
        const running = { ...job, sending: true }
        pendingRef.current = { ...pendingRef.current, [threadId]: running }
        setPending(pendingRef.current)
        void Promise.resolve().then(() => callbacks.current.send(threadId, job.message))
          .catch(error => callbacks.current.onError(threadId, error))
          .finally(() => {
            const next = { ...pendingRef.current }
            delete next[threadId]
            pendingRef.current = next
            setPending(next)
          })
      }
    }, Math.max(0, Math.min(...waiting.map(job => job.dueAt)) - Date.now()))
    return () => window.clearTimeout(timer)
  }, [pending])

  return { pending, schedule, cancel }
}
