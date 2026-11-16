import { parseMessageLocator } from '../domain/messageLocator'
import { appServer } from '../runtime/appServerClient'

/** Read the precise persisted item, including unloaded history, without resuming a thread. */
export async function readMessage(reference: string) {
  const locator = parseMessageLocator(reference)
  const { thread } = await appServer.readThread({ threadId: locator.threadId, includeTurns: false })
  if (thread.id !== locator.threadId) throw new Error('消息引用与返回会话不匹配')
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page = await appServer.listItems({ threadId: locator.threadId, turnId: locator.turnId, cursor, limit: 1, sortDirection: 'asc' })
    const entry = page.data.find(e => e.turnId === locator.turnId && e.item.id === locator.itemId)
    if (entry) return {
      reference, ...locator, provider: 'codex',
      session: { id: thread.id, name: thread.name, cwd: thread.cwd },
      item: entry.item,
    }
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) throw new Error('消息历史分页未前进，请重试')
    if (cursor) seen.add(cursor)
  } while (cursor)
  throw new Error('消息不存在，或尚未持久化；请核对消息引用')
}
