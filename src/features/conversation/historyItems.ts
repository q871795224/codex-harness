import type { ThreadItemEntry } from '../../core/domain/codex'
import { appServer } from '../../core/runtime/appServerClient'

export async function readHistoryTurn(threadId: string, turnId: string, signal: AbortSignal): Promise<ThreadItemEntry[]> {
  const entries: ThreadItemEntry[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    signal.throwIfAborted()
    // One full item per response: a turn can contain arbitrarily many images.
    const page = await appServer.listItems({ threadId, turnId, cursor, limit: 1, sortDirection: 'asc' })
    signal.throwIfAborted()
    entries.push(...page.data)
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error('执行过程分页未前进，请重试')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return entries
}
