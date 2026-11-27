import { parseMessageLocator } from '../domain/messageLocator'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import { hydrateClaudeHistory } from '../claude/history'

/** Read the precise persisted item, including unloaded history, without resuming a thread. */
export async function readMessage(reference: string) {
  const locator = parseMessageLocator(reference)
  if (locator.threadId.startsWith('claude:')) {
    const sessions = await runtime.listClaudeSessions(false)
    const session = sessions.find(s => s.id === locator.threadId)
      ?? (await runtime.listClaudeSessions(true)).find(s => s.id === locator.threadId)
    if (!session?.providerSessionId) throw new Error('Claude 会话不存在，或尚未持久化')
    const history = await runtime.readClaudeHistory(session.id, session.cwd, session.providerSessionId)
    // Native UUIDs survive reloads; local render turn/item IDs do not.
    const messages = history.messages.filter(message => message.sessionId === session.providerSessionId && !message.parentToolUseId)
    const entry = hydrateClaudeHistory(messages).items.find(({ item }) =>
      item.providerTurnId === locator.turnId && item.providerMessageId === locator.itemId)
    const nativeMessage = messages.find(message => message.uuid === locator.itemId)
    if (!entry || !nativeMessage) throw new Error('消息不存在，或尚未持久化；请核对消息引用')
    return { reference, ...locator, provider: 'claude',
      session: { id: session.id, name: session.title, cwd: session.cwd }, item: entry.item, nativeMessage }
  }
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
