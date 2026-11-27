import type { Thread } from '../../core/domain/codex'

export interface RelayTree {
  /** Threads shown at the top level; relay children whose parent is listed are nested instead. */
  roots: Thread[]
  /** Relay parent ID → its children, in the incoming order. */
  childrenOf: Map<string, Thread[]>
}

// A child stays at the top level when its parent is not in this list (archived, filtered or
// not loaded), so it is never hidden. Children ignore the parent's workspace grouping.
export function relayTree(threads: Thread[]): RelayTree {
  const ids = new Set(threads.map((thread) => thread.id))
  const roots: Thread[] = []
  const childrenOf = new Map<string, Thread[]>()
  for (const thread of threads) {
    const parent = thread.harnessRelayParent
    if (parent && parent !== thread.id && ids.has(parent)) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), thread])
    else roots.push(thread)
  }
  return { roots, childrenOf }
}

/** Flatten root order so nested children follow their parent (keyboard numbering, visible order). */
export function withRelayChildren(rootIds: string[], childrenOf: Map<string, Thread[]>): string[] {
  return rootIds.flatMap((id) => [id, ...(childrenOf.get(id) ?? []).map((child) => child.id)])
}

/** Children of a relay parent, or the parent of a relay child, for the conversation-side dock. */
export function relayNeighbors(current: Thread | null, threads: Thread[]): { parent: Thread | null; children: Thread[] } {
  if (!current) return { parent: null, children: [] }
  if (current.harnessRelay) return { parent: null, children: threads.filter((thread) => thread.harnessRelayParent === current.id) }
  const parentId = current.harnessRelayParent
  return { parent: parentId ? threads.find((thread) => thread.id === parentId) ?? null : null, children: [] }
}
