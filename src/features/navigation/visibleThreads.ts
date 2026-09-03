import type { Thread } from '../../core/domain/codex'

export function visibleThreads(threads: Thread[], requestedCount?: number, now = Date.now() / 1_000, pinnedThreadIds: string[] = []): Thread[] {
  // Keep the timestamp argument for callers that still pass it while the
  // sidebar count is governed solely by the five-session cap.
  void now
  const pinned = new Set(pinnedThreadIds)
  const pinnedThreads = threads.filter((thread) => pinned.has(thread.id))
  const unpinnedThreads = threads.filter((thread) => !pinned.has(thread.id))
  const defaultCount = Math.min(threads.length, 5)
  const shown = Math.min(
    threads.length,
    Math.max(defaultCount, requestedCount ?? defaultCount, pinnedThreads.length),
  )
  return [...pinnedThreads, ...unpinnedThreads].slice(0, shown)
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
