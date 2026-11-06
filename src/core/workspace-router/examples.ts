import { itemText, type UserInput } from '../domain/codex'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import type { RouterCorrection, RouterExample, RouterPromptCandidate, RouterFeedbackRow } from './types'
import type { RouterSettings } from './settings'

interface Source { threadId: string; sourceTurnId: string | null; sourceMessageId: string | null }
interface Message { text: string | null; hasAttachments: boolean }
const messages = new Map<string, Message>()
function clean(text: string): string { return text.replace(/<!-- harness-session:[\s\S]*?-->/g, '').trim() }
function terms(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []
  return new Set(tokens.flatMap(t => /[\u4e00-\u9fff]/.test(t) ? Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2)) : [t]))
}
async function sourceMessage(source: Source): Promise<Message> {
  if (!source.sourceTurnId || !source.sourceMessageId) return { text: null, hasAttachments: false }
  const key = `${source.threadId}:${source.sourceTurnId}:${source.sourceMessageId}`
  if (messages.has(key)) return messages.get(key)!
  const page = await appServer.listTurns({ threadId: source.threadId, sortDirection: 'asc', limit: 1, itemsView: 'full' })
  const turn = page.data.find(t => t.id === source.sourceTurnId)
  const item = turn?.items.find(i => i.type === 'userMessage' && (i.clientId === source.sourceMessageId || i.id === source.sourceMessageId))
  if (!item) return { text: null, hasAttachments: false }
  const text = clean(itemText(item))
  const message = { text: text && text.length <= 32000 ? text : null, hasAttachments: item.content?.some(i => i.type !== 'text') ?? false }
  if (messages.size >= 40) messages.delete(messages.keys().next().value!)
  messages.set(key, message)
  return message
}
/** Bound provider reads to four at a time; source text stays out of SQLite. */
async function withMessages<T extends Source>(sources: T[]): Promise<Array<T & Message>> {
  const result: Array<T & Message> = []
  for (let i = 0; i < sources.length; i += 4) {
    result.push(...await Promise.all(sources.slice(i, i + 4).map(async source => {
      try { return { ...source, ...await sourceMessage(source) } }
      catch { return { ...source, text: null, hasAttachments: false } }
    })))
  }
  return result
}
export async function readRouterFeedback(offset = 0): Promise<{ data: RouterFeedbackRow[]; hasMore: boolean }> {
  const page = await runtime.routerFeedback(offset, 20)
  const sources = await withMessages(page.data)
  return { data: sources.map(({ text, ...row }) => ({ ...row, request: text })), hasMore: page.hasMore }
}
export async function routingExamples(input: UserInput[], candidates: RouterPromptCandidate[], settings?: Pick<RouterSettings, 'feedbackCount' | 'feedbackRule'>): Promise<RouterExample[]> {
  const limit = settings?.feedbackCount ?? 3
  if (limit === 0) return []
  const corrections: RouterCorrection[] = await runtime.routerCorrections()
  const allowed = new Set(candidates.map(c => c.root))
  const eligible = corrections.filter(c => c.wrong !== c.correct && (c.correct === null || allowed.has(c.correct)) && (c.wrong === null || allowed.has(c.wrong))).slice(0, 20)
  const query = terms(clean(input.filter(i => i.type === 'text').map(i => i.text).join('\n')))
  const sources = await withMessages(eligible)
  const recent = settings?.feedbackRule === 'recent'
  return sources.flatMap(c => {
    if (!c.text || c.hasAttachments) return []
    const overlap = [...terms(c.text)].filter(t => query.has(t)).length
    return recent || overlap ? [{ request: c.text, wrong: c.wrong, correct: c.correct, overlap }] : []
  }).sort((a, b) => recent ? 0 : b.overlap - a.overlap).slice(0, limit).map(({ request, wrong, correct }) => ({ request, wrong, correct }))
}
