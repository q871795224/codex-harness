import { textInput, type ThreadItem, type ThreadItemEntry, type Turn } from '../domain/codex'
import type { SuperbotSnapshot } from './types'

/** Adapt remote IDs/statuses to the same transcript consumed by Codex and Claude. */
export function superbotTranscript(snapshot?: SuperbotSnapshot): { turns: Turn[]; items: ThreadItemEntry[]; activeTurnId: string | null } {
  if (!snapshot) return { turns: [], items: [], activeTurnId: null }
  const turns: Turn[] = []
  const byId = new Map<string, Turn>()
  const getTurn = (id: string): Turn => {
    const known = byId.get(id)
    if (known) return known
    const turn: Turn = { id, status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null, items: [] }
    turns.push(turn); byId.set(id, turn)
    return turn
  }
  for (const message of snapshot.page.messages) {
    const id = message.task_id ?? (message.role === 'assistant' ? turns.at(-1)?.id : undefined) ?? `message:${message.id}`
    const turn = getTurn(id)
    const time = Date.parse(message.created_at) / 1000
    if (Number.isFinite(time)) {
      turn.startedAt = turn.startedAt === null ? time : Math.min(turn.startedAt, time)
      turn.completedAt = turn.completedAt === null ? time : Math.max(turn.completedAt, time)
    }
    if (message.task_status === 'failed') turn.status = 'failed'
    else if (message.task_status === 'cancelled') turn.status = 'interrupted'
    if (message.failure_reason) { turn.status = 'failed'; turn.error = { message: message.failure_reason } }
    turn.items.push(message.role === 'user'
      ? { id: message.id, type: 'userMessage', providerMessageId: message.id, content: [textInput(message.content)] }
      : { id: message.id, type: 'agentMessage', text: message.content, phase: 'final_answer' })
  }
  const activeTurnId = snapshot.pending.task_id ?? null
  if (activeTurnId) {
    const turn = getTurn(activeTurnId)
    turn.status = 'inProgress'; turn.completedAt = null
    const calls = new Map<string, ThreadItem>()
    for (const event of snapshot.events) {
      const id = event.call_id ?? `event:${event.seq}`
      if (event.type === 'text') {
        const text = event.content ?? event.text
        if (text) turn.items.push({ id, type: 'agentMessage', text, phase: 'commentary' })
      } else if (event.type === 'tool_use' || event.type === 'tool_result') {
        let call = calls.get(id)
        if (!call) {
          call = { id, type: 'dynamicToolCall', tool: event.tool ?? 'Superbot', status: 'inProgress' }
          calls.set(id, call); turn.items.push(call)
        }
        if (event.type === 'tool_use') call.arguments = event.input
        else { call.status = 'completed'; call.contentItems = event.output ?? event.result ?? event.content ?? event.input }
      }
    }
  }
  return { turns, items: turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))), activeTurnId }
}
