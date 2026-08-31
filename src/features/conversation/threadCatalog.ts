import type { JsonObject, Thread } from '../../core/domain/codex'
import { threadsOlderThan } from '../../core/domain/codex'

export type ThreadViewMode = 'active' | 'archived'

export interface ThreadCatalogTransport {
  listThreads(params: JsonObject): Promise<{ data: Thread[]; nextCursor: string | null }>
  archiveThread(threadId: string): Promise<unknown>
}

export function listThreadPage(
  transport: ThreadCatalogTransport,
  mode: ThreadViewMode,
  searchTerm = '',
): Promise<{ data: Thread[]; nextCursor: string | null }> {
  return transport.listThreads({
    // The state DB already backs normal Codex session navigation. Avoid the
    // expensive JSONL scan-and-repair path on every Harness refresh.
    limit: 100,
    sortKey: 'recency_at',
    sortDirection: 'desc',
    archived: mode === 'archived',
    useStateDbOnly: true,
    ...(searchTerm.trim() ? { searchTerm: searchTerm.trim() } : {}),
  })
}

export async function listAllActiveThreads(transport: ThreadCatalogTransport): Promise<Thread[]> {
  const threads: Thread[] = []
  let cursor: string | null = null

  do {
    const response = await transport.listThreads({
      cursor,
      limit: 100,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: false,
      useStateDbOnly: true,
    })
    threads.push(...response.data)
    cursor = response.nextCursor
  } while (cursor)

  return threads
}

export async function archiveThreadsBefore(
  transport: ThreadCatalogTransport,
  cutoff: number,
): Promise<{ candidateCount: number; archivedIds: string[]; failedCount: number }> {
  const candidates = threadsOlderThan(await listAllActiveThreads(transport), cutoff)
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
