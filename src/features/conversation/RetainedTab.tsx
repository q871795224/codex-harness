import { useEffect, useState, type ReactNode } from 'react'

/** Retain local editor state and scroll position until the thread changes. */
export function RetainedTab({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active)
  useEffect(() => { if (active) setVisited(true) }, [active])
  if (!active && !visited) return null
  return <div className="retained-tab" hidden={!active}>{children}</div>
}
