import { useEffect, useRef } from 'react'
import type { Workspace } from '../domain/codex'
import { refreshRouterSummaries } from './summaries'

export function useRouterSummaries(workspaces: Workspace[], ready: boolean) {
  const latest = useRef(workspaces); latest.current = workspaces
  // New roots are checked promptly; native timestamps enforce the 24h cadence.
  const roots = workspaces.map(w => `${w.root}:${w.checkoutRoot}`).join('\n')
  useEffect(() => {
    if (!ready) return
    let disposed = false
    const refresh = () => { void refreshRouterSummaries(latest.current, () => disposed).catch(() => {}) }
    refresh()
    const timer = window.setInterval(refresh, 5 * 60_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [ready, roots])
}
