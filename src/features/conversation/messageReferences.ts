import type { MessageReference, UserInput } from '../../core/domain/codex'
import { runtime } from '../../core/runtime/bridge'

const key = (clientId: string) => `message.references.v1:${clientId}`

async function fingerprint(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Store only UI ranges and paths, never a copy of the submitted text or pasted content. */
export async function saveMessageReferences(clientId: string, input: UserInput[], references: MessageReference[]): Promise<void> {
  if (!references.length) return
  const text = input.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
  await runtime.setAppState(key(clientId), JSON.stringify({ fingerprint: await fingerprint(text), references: references.map(({ kind, start, end, path }) => ({ kind, start, end, ...(path ? { path } : {}) })) }))
}

export async function loadMessageReferences(clientId: string, text: string): Promise<MessageReference[]> {
  const stored = await runtime.getAppState(key(clientId))
  if (!stored) return []
  const value = JSON.parse(stored)
  // A queue edit can reuse the client id. Never apply old ranges to changed text.
  if (value.fingerprint !== await fingerprint(text) || !Array.isArray(value.references)) return []
  let end = 0
  return value.references.filter((item: MessageReference) => {
    if (!item || !['file', 'image', 'skill', 'paste'].includes(item.kind)
      || !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end)
      || item.start < end || item.end <= item.start || item.end > text.length
      || (item.kind !== 'paste' && typeof item.path !== 'string')) return false
    end = item.end
    return true
  })
}

/** Interrupted steers are combined into a fresh message; rebase their display ranges. */
export async function restartedMessageReferences(messages: Array<{ clientUserMessageId: string; input: UserInput[] }>): Promise<MessageReference[]> {
  const references: MessageReference[] = []
  let offset = 0
  let textItems = 0
  for (const message of messages) {
    const parts = message.input.filter((item) => item.type === 'text')
    if (!parts.length) continue
    if (textItems) offset += 1
    const text = parts.map((item) => item.text).join('\n')
    const stored = await loadMessageReferences(message.clientUserMessageId, text).catch(() => [])
    references.push(...stored.map((reference) => ({ ...reference, start: reference.start + offset, end: reference.end + offset })))
    offset += text.length
    textItems += parts.length
  }
  return references
}
