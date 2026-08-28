import type { Thread } from '../../core/domain/codex'

export function visibleThreads(threads: Thread[], requestedCount?: number, now = Date.now() / 1_000): Thread[] {
  const defaultCount = initialVisibleCount(threads, now)
  const shown = Math.min(threads.length, Math.max(defaultCount, requestedCount ?? defaultCount))
  return threads.slice(0, shown)
}

export function visibleThreadOrder(options: {
  layout: 'workspace' | 'list'
  orderedThreads: Thread[]
  orderedWorkspaceRoots: string[]
  groupedByRoot: Map<string, Thread[]>
  unsorted: Thread[]
  expanded: Record<string, boolean>
  visibleCounts: Record<string, number>
}): string[] {
  if (options.layout === 'list') return visibleThreads(options.orderedThreads, options.visibleCounts.all).map((thread) => thread.id)
  const ids: string[] = []
  for (const root of options.orderedWorkspaceRoots) {
    if (!(options.expanded[root] ?? true)) continue
    ids.push(...visibleThreads(options.groupedByRoot.get(root) ?? [], options.visibleCounts[root]).map((thread) => thread.id))
  }
  ids.push(...visibleThreads(options.unsorted, options.visibleCounts.unsorted).map((thread) => thread.id))
  return ids
}

function initialVisibleCount(threads: Thread[], now: number): number {
  if (threads.length <= 5) return threads.length
  const cutoff = now - 3 * 24 * 60 * 60
  const recentCount = threads.filter((thread) => (thread.recencyAt ?? thread.updatedAt) >= cutoff).length
  return Math.max(3, Math.min(5, recentCount))
}
