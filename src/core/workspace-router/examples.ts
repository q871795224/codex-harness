import { itemText, type UserInput } from '../domain/codex'
import { appServer } from '../runtime/appServerClient'
import { runtime } from '../runtime/bridge'
import type { RouterCorrection, RouterExample, RouterPromptCandidate } from './types'

const messages = new Map<string, string>()
function clean(text: string): string { return text.replace(/<!-- harness-session:[\s\S]*?-->/g, '').trim() }
function terms(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []
  return new Set(tokens.flatMap(t => /[\u4e00-\u9fff]/.test(t) ? Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2)) : [t]))
}
async function sourceText(correction: RouterCorrection): Promise<string | null> {
  const key = `${correction.threadId}:${correction.sourceTurnId}:${correction.sourceMessageId}`
  if (messages.has(key)) return messages.get(key)!
  // Routing is only applied to the first submission. Never scan entire histories.
  const page = await appServer.listTurns({ threadId: correction.threadId, sortDirection: 'asc', limit: 1, itemsView: 'full' })
  const turn = page.data.find(t => t.id === correction.sourceTurnId)
  const item = turn?.items.find(i => i.type === 'userMessage' && (i.clientId === correction.sourceMessageId || i.id === correction.sourceMessageId))
  if (!item) return null
  // Image-dependent corrections cannot be represented by a text-only example.
  if (item.content?.some(i => i.type !== 'text')) return null
  const text = clean(itemText(item))
  if (!text || text.length > 32000) return null
  if (messages.size >= 20) messages.delete(messages.keys().next().value!)
  messages.set(key, text)
  return text
}
export async function routingExamples(input: UserInput[], candidates: RouterPromptCandidate[]): Promise<RouterExample[]> {
  const corrections = await runtime.routerCorrections()
  const allowed = new Set(candidates.map(c => c.root))
  const eligible = corrections.filter(c => c.wrong !== c.correct && (c.correct === null || allowed.has(c.correct)) && (c.wrong === null || allowed.has(c.wrong))).slice(0, 10)
  const query = terms(clean(input.filter(i => i.type === 'text').map(i => i.text).join('\n')))
  const texts = await Promise.all(eligible.map(async c => {
    try { const request = await sourceText(c); return request ? { ...c, request } : null } catch { return null }
  }))
  return texts.flatMap(c => {
    if (!c) return []
    const overlap = [...terms(c.request)].filter(t => query.has(t)).length
    return overlap ? [{ request: c.request, wrong: c.wrong, correct: c.correct, overlap }] : []
  }).sort((a, b) => b.overlap - a.overlap).slice(0, 3).map(({ request, wrong, correct }) => ({ request, wrong, correct }))
}
