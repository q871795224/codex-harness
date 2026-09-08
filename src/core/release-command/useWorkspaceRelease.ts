import { useCallback, useEffect, useRef, useState } from 'react'
import { runtime } from '../runtime/bridge'
import type { ReleaseCommandInfo, WorkspaceReleaseController } from './types'

const EMPTY_INFO: ReleaseCommandInfo = {
  supported: false,
  currentVersion: null,
  installedVersion: null,
  versions: [],
  originMainSha: null,
  status: null,
}

type PendingRefresh = {
  workspaceRoot: string
  promise: Promise<void>
}

type FreshSnapshot = {
  workspaceRoot: string
  originMainSha: string
}

export function useWorkspaceRelease(workspaceRoot: string | null): WorkspaceReleaseController {
  const [info, setInfo] = useState<ReleaseCommandInfo>(EMPTY_INFO)
  const [loading, setLoading] = useState(false)
  const rootRef = useRef(workspaceRoot)
  const infoRef = useRef(info)
  const requestIdRef = useRef(0)
  const pendingRefreshRef = useRef<PendingRefresh | null>(null)
  const freshSnapshotRef = useRef<FreshSnapshot | null>(null)
  rootRef.current = workspaceRoot
  infoRef.current = info

  useEffect(() => {
    let disposed = false
    const requestId = ++requestIdRef.current
    freshSnapshotRef.current = null
    infoRef.current = EMPTY_INFO
    setInfo(EMPTY_INFO)
    if (!workspaceRoot) {
      setLoading(false)
      return undefined
    }
    setLoading(true)
    void runtime.releaseCommandInfo(workspaceRoot, false)
      .then((next) => {
        if (!disposed && requestId === requestIdRef.current) {
          infoRef.current = next
          setInfo(next)
        }
      })
      .catch(() => {
        if (!disposed && requestId === requestIdRef.current) {
          infoRef.current = EMPTY_INFO
          setInfo(EMPTY_INFO)
        }
      })
      .finally(() => {
        if (!disposed && requestId === requestIdRef.current) setLoading(false)
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
    freshSnapshotRef.current = null
    const requestId = requestIdRef.current
    void runtime.releaseCommandInfo(workspaceRoot, false).then((next) => {
      if (rootRef.current === workspaceRoot && requestId === requestIdRef.current) {
        infoRef.current = next
        setInfo(next)
      }
    }).catch(() => undefined)
  }, [info.status?.runId, info.status?.status, workspaceRoot])

  const refresh = useCallback(async () => {
    if (!workspaceRoot) return
    const pending = pendingRefreshRef.current
    if (pending?.workspaceRoot === workspaceRoot) {
      await pending.promise
      return
    }

    const requestId = ++requestIdRef.current
    freshSnapshotRef.current = null
    setLoading(true)

    const pendingRequest: PendingRefresh = {
      workspaceRoot,
      promise: Promise.resolve(),
    }
    pendingRefreshRef.current = pendingRequest
    const request = runtime.releaseCommandInfo(workspaceRoot, true)
      .then((next) => {
        if (rootRef.current === workspaceRoot && requestId === requestIdRef.current) {
          infoRef.current = next
          if (next.originMainSha) {
            freshSnapshotRef.current = { workspaceRoot, originMainSha: next.originMainSha }
          }
          setInfo(next)
        }
      })
      .finally(() => {
        if (pendingRefreshRef.current === pendingRequest) pendingRefreshRef.current = null
        if (rootRef.current === workspaceRoot && requestId === requestIdRef.current) setLoading(false)
      })
    pendingRequest.promise = request
    await request
  }, [workspaceRoot])

  const start = useCallback(async (version: string) => {
    if (!workspaceRoot) return
    const pending = pendingRefreshRef.current
    if (pending?.workspaceRoot === workspaceRoot) await pending.promise

    let snapshot = freshSnapshotRef.current
    if (!snapshot || snapshot.workspaceRoot !== workspaceRoot) {
      await refresh()
      snapshot = freshSnapshotRef.current
    }
    if (!snapshot || snapshot.workspaceRoot !== workspaceRoot) {
      throw new Error('无法确认最新的远程 main，请重新刷新发布版本')
    }

    const status = await runtime.startReleaseCommand(workspaceRoot, version, snapshot.originMainSha)
    if (rootRef.current === workspaceRoot) {
      infoRef.current = { ...infoRef.current, status }
      setInfo((current) => ({ ...current, status }))
    }
  }, [refresh, workspaceRoot])

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
