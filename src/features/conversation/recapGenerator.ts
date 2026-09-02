import type { JsonObject, Turn } from '../../core/domain/codex'
import { itemText } from '../../core/domain/codex'
import { eventThreadItem, eventTurn } from './conversationEventParser'
import type { TranscriptTurn } from './transcript'

export const RECAP_TEXT_MAX_CHARS = 320
export const RECAP_HISTORY_MAX_BYTES = 900

export interface RecapGeneratorState {
  targetThreadId: string
  attemptId: string
  text: string
  startedAt: number
}

export type RecapGeneratorEventResult =
  | { kind: 'pending'; state: RecapGeneratorState }
  | { kind: 'completed'; state: RecapGeneratorState; turn: Turn | null; generatedText: string; recap: string | null }

export function reduceRecapGeneratorEvent(
  state: RecapGeneratorState,
  method: string,
  params: JsonObject,
): RecapGeneratorEventResult {
  if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
    return { kind: 'pending', state: { ...state, text: `${state.text}${params.delta}` } }
  }
  if (method === 'item/completed') {
    const item = eventThreadItem(params.item)
    const text = item?.type === 'agentMessage' ? itemText(item) : ''
    return { kind: 'pending', state: text ? { ...state, text } : state }
  }
  if (method === 'turn/completed') {
    const turn = eventTurn(params.turn)
    const fallback = turn?.items.find((item) => item.type === 'agentMessage')
    const generatedText = state.text || (fallback ? itemText(fallback) : '')
    return {
      kind: 'completed',
      state,
      turn,
      generatedText,
      recap: parseGeneratedRecap(generatedText),
    }
  }
  return { kind: 'pending', state }
}

export function parseGeneratedRecap(value: string): string | null {
  const recap = value.trim()
  if (!recap) return null
  return [...recap].slice(0, RECAP_TEXT_MAX_CHARS).join('')
}

/** A labelled recent-conversation message used to build the recap prompt. */
export interface RecapHistoryMessage {
  role: 'User' | 'Assistant'
  content: string
}

/** Flatten the most recent turns into labelled user/assistant messages. */
export function recapHistoryText(turns: TranscriptTurn[], maxTurns: number): RecapHistoryMessage[] {
  const messages: RecapHistoryMessage[] = []
  for (const turn of turns.slice(-maxTurns)) {
    const userText = turn.userRows
      .map((row) => itemText(row.entry.item).trim())
      .filter((text) => text.length > 0)
      .join('\n')
    if (userText) messages.push({ role: 'User', content: userText })
    const assistantText = turn.finalRows
      .map((row) => (row.agentText ?? row.entry.item.text ?? '').trim())
      .filter((text) => text.length > 0)
      .join('\n\n')
    if (assistantText) messages.push({ role: 'Assistant', content: assistantText })
  }
  return messages
}

/**
 * Assemble the recap prompt, mirroring the Codex TUI: the latest user message
 * reserves half the byte budget, then older messages fill from newest to oldest.
 */
export function recapPrompt(behavior: string, messages: RecapHistoryMessage[]): string {
  const history = recapHistory(messages)
  return `${behavior.trim()}\n\nRecent conversation:\n${history}`
}

function recapHistory(messages: RecapHistoryMessage[]): string {
  const budget = RECAP_HISTORY_MAX_BYTES
  const latestUserIndex = findLatestUserIndex(messages)
  const latestBudget = Math.floor(budget / 2)
  const selected: Array<{ index: number; text: string }> = []
  const latest = renderMessage(messages[latestUserIndex], latestBudget)
  selected.push({ index: latestUserIndex, text: latest })
  let remaining = budget - latest.length

  for (let index = messages.length - 1; index >= 0 && remaining > 2; index -= 1) {
    if (index === latestUserIndex) continue
    const rendered = renderMessage(messages[index], remaining - 2)
    if (!rendered) continue
    remaining -= rendered.length + 2
    selected.push({ index, text: rendered })
  }

  selected.sort((a, b) => a.index - b.index)
  return selected.map((entry) => entry.text).filter((text) => text.trim()).join('\n\n')
}

function findLatestUserIndex(messages: RecapHistoryMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'User') return index
  }
  return messages.length - 1
}

function renderMessage(message: RecapHistoryMessage, maxBytes: number): string {
  const prefix = `${message.role}: `
  const budget = Math.max(0, maxBytes - byteLength(prefix))
  const content = truncateToBytes(message.content.trim(), budget)
  return content ? `${prefix}${content}` : ''
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value
  let result = ''
  let used = 0
  for (const char of value) {
    const size = byteLength(char)
    if (used + size > maxBytes) break
    result += char
    used += size
  }
  return result
}
