import type { ThreadItemEntry } from './codex'

export interface MessageLocator {
  threadId: string
  turnId: string
  itemId: string
}

/** Provider IDs are scoped; copy all three IDs so no history scan or UI selection is needed. */
export function messageLocator(threadId: string | null | undefined, entry: ThreadItemEntry): string | undefined {
  if (!threadId || threadId.startsWith('claude:') || !entry.turnId || !entry.item.id) return undefined
  return `harness-message://codex/${[threadId, entry.turnId, entry.item.id].map(encodeURIComponent).join('/')}`
}

export function parseMessageLocator(reference: string): MessageLocator {
  const url = new URL(reference)
  const parts = url.pathname.slice(1).split('/').map(decodeURIComponent)
  if (url.protocol !== 'harness-message:' || url.host !== 'codex' || url.username || url.password
    || url.search || url.hash || parts.length !== 3 || parts.some(p => !p.trim() || p.length > 512)) {
    throw new Error('无效的 Harness 消息引用')
  }
  const [threadId, turnId, itemId] = parts
  return { threadId, turnId, itemId }
}
