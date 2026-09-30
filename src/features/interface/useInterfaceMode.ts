import { useCallback, useEffect, useRef, useState } from 'react'

export type InterfaceMode = 'conversation' | 'team'
export const INTERFACE_MODE_KEY = 'interfaceMode'
interface Storage {
  getAppState(key: string): Promise<string | null>
  setAppState(key: string, value: string): Promise<unknown>
}

/** Mode changes never own, start, cancel or dispose an execution service. */
export function useInterfaceMode(storage: Storage, onError: (error: unknown) => void) {
  const [mode, setMode] = useState<InterfaceMode>('conversation')
  const [teamVisited, setTeamVisited] = useState(false)
  const changed = useRef(false)
  const writes = useRef<Promise<unknown>>(Promise.resolve())
  const report = useRef(onError)
  report.current = onError
  useEffect(() => {
    let disposed = false
    void storage.getAppState(INTERFACE_MODE_KEY).then((saved) => {
      if (disposed || changed.current) return
      if (saved === 'team') { setMode('team'); setTeamVisited(true) }
    }).catch((error) => { if (!disposed) report.current(error) })
    return () => { disposed = true }
  }, [storage])
  const selectMode = useCallback((next: InterfaceMode) => {
    changed.current = true
    setMode(next)
    if (next === 'team') setTeamVisited(true)
    writes.current = writes.current.catch(() => undefined)
      .then(() => storage.setAppState(INTERFACE_MODE_KEY, next))
      .catch((error) => report.current(error))
  }, [storage])
  return { mode, selectMode, teamVisited }
}
