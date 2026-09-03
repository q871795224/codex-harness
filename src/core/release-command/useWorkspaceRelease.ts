import { useCallback, useEffect, useRef, useState } from 'react'
import { runtime } from '../runtime/bridge'
import type { ReleaseCommandInfo, ReleaseRunStatus, WorkspaceReleaseController } from './types'

const EMPTY_INFO: ReleaseCommandInfo = {
  supported: false,
  currentVersion: null,
  versions: [],
  status: null,
}

export function useWorkspaceRelease(workspaceRoot: string | null): WorkspaceReleaseController {
  const [info, setInfo] = useState<ReleaseCommandInfo>(EMPTY_INFO)
  const [loading, setLoading] = useState(false)
  const rootRef = useRef(workspaceRoot)
  rootRef.current = workspaceRoot

  useEffect(() => {
    let disposed = false
    setInfo(EMPTY_INFO)
    if (!workspaceRoot) return undefined
    setLoading(true)
    void runtime.releaseCommandInfo(workspaceRoot, false)
      .then((next) => {
        if (!disposed) setInfo(next)
      })
      .catch(() => {
        if (!disposed) setInfo(EMPTY_INFO)
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => { disposed = true }
  }, [workspaceRoot])

  useEffect(() => {
    if (!workspaceRoot || info.status?.status !== 'running') return undefined
    let disposed = false
    const poll = () => {
      void runtime.releaseCommandStatus(workspaceRoot).then((status) => {
        if (disposed || rootRef.current !== workspaceRoot || !status) return
        setInfo((current) => ({ ...current, status }))
      }).catch(() => undefined)
    }
    const timer = window.setInterval(poll, 1_000)
    poll()
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [info.status?.status, workspaceRoot])

  useEffect(() => {
    if (!workspaceRoot || info.status?.status !== 'succeeded') return
    void runtime.releaseCommandInfo(workspaceRoot, false).then((next) => {
      if (rootRef.current === workspaceRoot) setInfo(next)
    }).catch(() => undefined)
  }, [info.status?.runId, info.status?.status, workspaceRoot])

  const refresh = useCallback(async () => {
    if (!workspaceRoot) return
    setLoading(true)
    try {
      const next = await runtime.releaseCommandInfo(workspaceRoot, true)
      if (rootRef.current === workspaceRoot) setInfo(next)
    } finally {
      if (rootRef.current === workspaceRoot) setLoading(false)
    }
  }, [workspaceRoot])

  const start = useCallback(async (version: string) => {
    if (!workspaceRoot) return
    const status = await runtime.startReleaseCommand(workspaceRoot, version)
    if (rootRef.current === workspaceRoot) {
      setInfo((current) => ({ ...current, status }))
    }
  }, [workspaceRoot])

  const dismissFailure = useCallback(async () => {
    if (!workspaceRoot) return
    const status = await runtime.dismissReleaseFailure(workspaceRoot)
    if (rootRef.current === workspaceRoot) {
      setInfo((current) => ({ ...current, status }))
    }
  }, [workspaceRoot])

  const openLog = useCallback(async () => {
    if (workspaceRoot) await runtime.openReleaseLog(workspaceRoot)
  }, [workspaceRoot])

  return { ...info, loading, refresh, start, dismissFailure, openLog }
}

export function releaseFailureVisible(status: ReleaseRunStatus | null): boolean {
  return status?.status === 'failed' && !status.dismissed
}
