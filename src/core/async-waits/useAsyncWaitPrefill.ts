import { useEffect, useRef, useState } from 'react'
import { runtime } from '../runtime/bridge'
import type { AsyncWaitTask } from './types'
import type { ComposerDraft } from '../../features/conversation/Composer'
import { storedComposerDraft } from '../../features/conversation/composerDraftStorage'

export function asyncWaitPrefill(task: AsyncWaitTask): string {
  return `异步任务「${task.title}」已结束。\n${task.lastObservation ?? task.summary}\n${task.continuation}\n任务 ID：${task.id}`
}

/** Uses the live Composer value; never replaces text, attachments or collapsed pastes. */
export function useAsyncWaitPrefill(drafts: Record<string, ComposerDraft>, apply: (threadId: string, draft: ComposerDraft) => void, loaded: boolean) {
  const live = useRef({ drafts, apply }); live.current = { drafts, apply }
  const [tasks, setTasks] = useState<AsyncWaitTask[]>([])
  const [error, setError] = useState('')
  const applying = useRef(false)
  const stage = async (task: AsyncWaitTask, append: boolean) => {
    if (applying.current) return
    const threadId = task.threadId
    const current = live.current.drafts[threadId] ?? { text: '', attachments: [], collapsedPastes: [] }, text = asyncWaitPrefill(task)
    const already = current.text.split('\n').includes(`任务 ID：${task.id}`)
    if (!append && !already && (current.text || current.attachments.length || current.collapsedPastes.length)) return
    applying.current = true
    try {
      const next = { ...current, text: already ? current.text : [current.text, text].filter(Boolean).join('\n\n') }
      live.current.drafts = { ...live.current.drafts, [threadId]: next }
      live.current.apply(threadId, next)
      // Persist before marking consumed, so a restart cannot silently lose the result.
      await runtime.upsertComposerDraft(threadId, storedComposerDraft(next))
      await runtime.stageAsyncWaitDraft(task.id)
      setTasks(values => values.filter(value => value.id !== task.id)); setError('')
    } catch (cause) { setError(String(cause)) }
    finally { applying.current = false }
  }
  const stageRef = useRef(stage); stageRef.current = stage
  useEffect(() => {
    if (!loaded || !runtime.listenAsyncWaits) return
    let disposed = false, sequence = 0
    let stop: (() => void) | undefined
    const refresh = async () => {
      const version = ++sequence
      try {
        const state = await runtime.listAsyncWaits()
        if (disposed || version !== sequence) return
        const pending = state.data.filter(t => t.status === 'notified' && !t.draftStaged)
        setTasks(pending)
        for (const task of pending) {
          if (disposed) break
          await stageRef.current(task, false)
        }
      } catch (cause) { if (!disposed) setError(String(cause)) }
    }
    void runtime.listenAsyncWaits(() => void refresh()).then(unlisten => { if (disposed) unlisten(); else { stop = unlisten; void refresh() } }).catch(cause => { if (!disposed) setError(String(cause)) })
    return () => { disposed = true; stop?.() }
  }, [loaded])
  return { tasks, error, insert: (task: AsyncWaitTask) => stage(task, true) }
}
