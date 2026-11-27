import type { JsonObject, Thread } from '../../core/domain/codex'
import { threadsOlderThan } from '../../core/domain/codex'

export type ThreadViewMode = 'active' | 'archived'

export interface ThreadCatalogTransport {
  listThreads(params: JsonObject): Promise<{ data: Thread[]; nextCursor: string | null }>
  archiveThread(threadId: string): Promise<unknown>
}

export async function listThreadPage(
  transport: ThreadCatalogTransport,
  mode: ThreadViewMode,
  searchTerm = '',
  cursor?: string | null,
): Promise<{ data: Thread[]; nextCursor: string | null }> {
  const page = await transport.listThreads({
    // The state DB already backs normal Codex session navigation. Avoid the
    // expensive JSONL scan-and-repair path on every Harness refresh.
    ...(cursor === undefined ? {} : { cursor }),
    limit: 100,
    sortKey: 'recency_at',
    sortDirection: 'desc',
    archived: mode === 'archived',
    // Omission filters by the configured provider and hides history after a switch.
    modelProviders: [],
    useStateDbOnly: true,
    ...(searchTerm.trim() ? { searchTerm: searchTerm.trim() } : {}),
  })
  return { ...page, data: page.data.filter(thread => !thread.ephemeral && !thread.harnessAssistant) }
}

export function listAllActiveThreads(transport: ThreadCatalogTransport): Promise<Thread[]> {
  return listAllThreads(transport, 'active')
}

export async function listAllThreads(transport: ThreadCatalogTransport, mode: ThreadViewMode, searchTerm = ''): Promise<Thread[]> {
  const threads: Thread[] = []
  let cursor: string | null = null

  do {
    const response = await listThreadPage(transport, mode, searchTerm, cursor)
    threads.push(...response.data)
    cursor = response.nextCursor
  } while (cursor)

  return threads
}

export async function archiveThreadsBefore(
  transport: ThreadCatalogTransport,
  cutoff: number,
  pinnedThreadIds: readonly string[] = [],
): Promise<{ candidateCount: number; archivedIds: string[]; failedCount: number }> {
  const pinned = new Set(pinnedThreadIds)
  const candidates = threadsOlderThan(await listAllActiveThreads(transport), cutoff)
    .filter((thread) => !pinned.has(thread.id))
  const archivedIds: string[] = []
  let failedCount = 0

  for (const thread of candidates) {
    try {
      await transport.archiveThread(thread.id)
      archivedIds.push(thread.id)
    } catch {
      failedCount += 1
    }
  }

  return { candidateCount: candidates.length, archivedIds, failedCount }
}
