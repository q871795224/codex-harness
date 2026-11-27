import { CornerUpLeft, Network } from 'lucide-react'
import type { Thread, ThreadUiState } from '../../core/domain/codex'
import { truncate } from '../../core/domain/format'
import { StatusDot } from './Sidebar'
import { relayNeighbors } from './relayTree'
import { resolveThreadBadge } from './threadBadge'

interface RelayDockProps {
  current: Thread | null
  threads: Thread[]
  threadStates: Record<string, ThreadUiState>
  workingThreadIds: Record<string, boolean>
  waitingThreadIds?: Record<string, boolean>
  onOpen: (threadId: string) => void
}

const titleOf = (thread: Thread) => thread.name || thread.preview || '新会话'

/** Right-side jump list: a relay shows its children, a child shows its relay. */
export function RelayDock({ current, threads, threadStates, workingThreadIds, waitingThreadIds = {}, onOpen }: RelayDockProps) {
  const { parent, children } = relayNeighbors(current, threads)
  if (!current || (!parent && children.length === 0)) return null
  const badgeOf = (thread: Thread) => resolveThreadBadge(thread, threadStates[thread.id]?.badge ?? null,
    workingThreadIds[thread.id] === true, waitingThreadIds[thread.id] === true)
  return (
    <nav className="relay-dock" aria-label={parent ? '所属路由会话' : '子会话'}>
      {parent ? (
        <button type="button" className="relay-dock-chip" onClick={() => onOpen(parent.id)} title={`返回路由会话：${titleOf(parent)}`}>
          <CornerUpLeft size={13} aria-hidden />
          <StatusDot badge={badgeOf(parent)} />
          <span>{truncate(titleOf(parent), 24)}</span>
        </button>
      ) : (
        <>
          <span className="relay-dock-label"><Network size={12} aria-hidden />子会话 {children.length}</span>
          {children.map((child) => (
            <button key={child.id} type="button" className="relay-dock-chip" onClick={() => onOpen(child.id)} title={titleOf(child)}>
              <StatusDot badge={badgeOf(child)} />
              <span>{truncate(titleOf(child), 24)}</span>
            </button>
          ))}
        </>
      )}
    </nav>
  )
}
