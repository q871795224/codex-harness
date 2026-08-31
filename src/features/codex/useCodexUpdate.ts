import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CodexUpdateStage, CodexUpdateStatus } from '../../core/codex-update/types'
import { runtime } from '../../core/runtime/bridge'

export function useCodexUpdate(threadId: string | null, onUpdated: () => void | Promise<void>) {
  const [status, setStatus] = useState<CodexUpdateStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [updateStage, setUpdateStage] = useState<CodexUpdateStage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deferredThreadIds, setDeferredThreadIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let disposed = false
    void runtime.codexUpdateStatus(false)
      .then((next) => {
        if (!disposed) setStatus(next)
      })
      .catch((nextError) => {
        if (!disposed) setError(messageOf(nextError))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    void runtime.listenCodexUpdateProgress(setUpdateStage).then((next) => { unlisten = next })
    return () => { unlisten?.() }
  }, [])

  const install = useCallback(async () => {
    if (updating) return
    setUpdating(true)
    setUpdateStage('cli')
    setError(null)
    try {
      const next = await runtime.installCodexUpdate()
      setStatus(next)
      await onUpdated()
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setUpdating(false)
    }
  }, [onUpdated, updating])

  const defer = useCallback(() => {
    if (!threadId) return
    setDeferredThreadIds((current) => new Set(current).add(threadId))
    void runtime.recordClientDiagnostic({
      level: 'info',
      area: 'codex-update',
      event: 'decision.deferred',
      threadId,
      status: status?.latestVersion ?? undefined,
    }).catch(() => undefined)
  }, [status?.latestVersion, threadId])

  const skip = useCallback(async () => {
    const version = status?.latestVersion
    if (!version || updating) return
    setUpdating(true)
    setUpdateStage(null)
    setError(null)
    try {
      setStatus(await runtime.skipCodexUpdate(version))
    } catch (nextError) {
      setError(messageOf(nextError))
    } finally {
      setUpdating(false)
    }
  }, [status?.latestVersion, updating])

  const visible = useMemo(
    () => shouldShowCodexUpdate(status, threadId, deferredThreadIds),
    [deferredThreadIds, status, threadId],
  )

  return { status, loading, updating, updateStage, error, visible, install, defer, skip }
}

export function shouldShowCodexUpdate(
  status: CodexUpdateStatus | null,
  threadId: string | null,
  deferredThreadIds: ReadonlySet<string>,
): boolean {
  return Boolean(
    threadId
    && status?.updateAvailable
    && !status.skipped
    && !deferredThreadIds.has(threadId),
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
