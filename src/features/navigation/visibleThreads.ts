import type { Thread } from '../../core/domain/codex'

export function visibleThreads(threads: Thread[], requestedCount?: number, now = Date.now() / 1_000, pinnedThreadIds: string[] = []): Thread[] {
  const defaultCount = initialVisibleCount(threads, now, pinnedThreadIds)
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
  pinnedThreadIds: string[]
  listSections?: { key: string; threads: Thread[] }[]
}): string[] {
  if (options.layout === 'list') {
    const sections = options.listSections ?? [{ key: 'all', threads: options.orderedThreads }]
    return sections.flatMap((section) =>
      visibleThreads(section.threads, options.visibleCounts[section.key], undefined, options.pinnedThreadIds).map((thread) => thread.id),
    )
  }
  const ids: string[] = []
  for (const root of options.orderedWorkspaceRoots) {
    if (!(options.expanded[root] ?? true)) continue
    ids.push(...visibleThreads(options.groupedByRoot.get(root) ?? [], options.visibleCounts[root], undefined, options.pinnedThreadIds).map((thread) => thread.id))
  }
  ids.push(...visibleThreads(options.unsorted, options.visibleCounts.unsorted, undefined, options.pinnedThreadIds).map((thread) => thread.id))
  return ids
}

function initialVisibleCount(threads: Thread[], now: number, pinnedThreadIds: string[] = []): number {
  const pinnedCount = pinnedThreadIds.length === 0 ? 0 : threads.filter((thread) => pinnedThreadIds.includes(thread.id)).length
  if (threads.length <= 5) return threads.length
  const cutoff = now - 3 * 24 * 60 * 60
  const recentCount = threads.filter((thread) => (thread.recencyAt ?? thread.updatedAt) >= cutoff).length
  return Math.min(threads.length, Math.max(3, Math.min(5, recentCount), pinnedCount))
}
