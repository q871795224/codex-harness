import { textInput, type JsonObject, type ThreadDetail, type ThreadItem, type ThreadItemEntry, type Turn, type UserInput } from '../domain/codex'
import type { ClaudeSessionMessage } from './types'

export interface ClaudeHistoryDetail {
  turns: Turn[]
  items: ThreadItemEntry[]
}

export function hydrateClaudeHistory(
  messages: ClaudeSessionMessage[],
): ClaudeHistoryDetail {
  const turns: Turn[] = []
  let currentTurn: Turn | null = null

  messages.forEach((message, index) => {
    if (message.type === 'user') {
      const content = userInputs(message)
      if (content.length > 0) {
        const messageId = messageUuid(message, index)
        const turnId = `claude-history:${messageId}`
        currentTurn = createTurn(turnId, message.timestamp)
        turns.push(currentTurn)
        addTurnItem(currentTurn, {
          id: `${turnId}:user`,
          type: 'userMessage',
          providerMessageId: message.uuid || null,
          content,
        })
      } else if (currentTurn) {
        applyToolResults(currentTurn, message)
        touchTurn(currentTurn, message.timestamp)
      }
      return
    }

    if (message.type !== 'assistant' || !currentTurn) return
    touchTurn(currentTurn, message.timestamp)
    applyAssistantContent(currentTurn, message, index)
  })

  for (const turn of turns) {
    turn.items = turn.items.map((item) => item.status === 'inProgress' ? { ...item, status: 'completed' } : item)
  }

  return {
    turns,
    items: turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))),
  }
}

export function mergeClaudeHistory(detail: ThreadDetail, history: ClaudeHistoryDetail): ThreadDetail {
  history = alignHistoryTurns(detail, history)
  const items: ThreadItemEntry[] = []
  for (const entry of history.items) upsertEntry(items, entry)
  for (const turn of history.turns) {
    for (const item of turn.items) upsertEntry(items, { turnId: turn.id, item })
  }
  for (const entry of detail.items) upsertEntry(items, entry)
  for (const turn of detail.turns) {
    for (const item of turn.items) upsertEntry(items, { turnId: turn.id, item })
  }

  const turns = history.turns.map((turn) => ({ ...turn, items: [...turn.items] }))
  for (const currentTurn of detail.turns) {
    const index = turns.findIndex((turn) => turn.id === currentTurn.id)
    if (index < 0) {
      turns.push({ ...currentTurn, items: [...currentTurn.items] })
      continue
    }
    turns[index] = {
      ...turns[index],
      ...currentTurn,
      items: [...turns[index].items, ...currentTurn.items],
    }
  }

  const itemsByTurn = new Map<string, ThreadItem[]>()
  for (const entry of items) {
    const current = itemsByTurn.get(entry.turnId) ?? []
    current.push(entry.item)
    itemsByTurn.set(entry.turnId, current)
  }
  const nextTurns = turns.map((turn) => ({
    ...turn,
    items: itemsByTurn.get(turn.id) ?? turn.items,
  }))
  return {
    ...detail,
    turns: nextTurns,
    items,
  }
}

function alignHistoryTurns(detail: ThreadDetail, history: ClaudeHistoryDetail): ClaudeHistoryDetail {
  // SDK UUIDs survive transcript reloads; prompt text and local turn IDs do not identify a submission.
  const liveTurnIds = new Map<string, string>()
  for (const entry of [...detail.items, ...detail.turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })))]) {
    if (entry.item.type === 'userMessage' && typeof entry.item.providerMessageId === 'string') {
      liveTurnIds.set(entry.item.providerMessageId, entry.turnId)
    }
  }
  const turnIds = new Map<string, string>()
  for (const turn of history.turns) {
    const user = turn.items.find((item) => item.type === 'userMessage')
    const liveTurnId = typeof user?.providerMessageId === 'string' ? liveTurnIds.get(user.providerMessageId) : null
    if (liveTurnId) turnIds.set(turn.id, liveTurnId)
  }
  const alignEntry = (entry: ThreadItemEntry): ThreadItemEntry => {
    const turnId = turnIds.get(entry.turnId)
    if (!turnId) return entry
    const item = entry.item
    const id = item.id === `${entry.turnId}:user` ? `${turnId}:user`
      : item.id === `${entry.turnId}:assistant` ? `${turnId}:assistant` : item.id
    return { ...entry, turnId, item: { ...item, id } }
  }
  return {
    turns: history.turns.map((turn) => ({
      ...turn,
      id: turnIds.get(turn.id) ?? turn.id,
      items: turn.items.map((item) => alignEntry({ turnId: turn.id, item }).item),
    })),
    items: history.items.map(alignEntry),
  }
}

function createTurn(id: string, timestamp: string | null): Turn {
  const time = parseTimestamp(timestamp)
  return {
    id,
    items: [],
    status: 'completed',
    error: null,
    startedAt: time,
    completedAt: time,
    durationMs: null,
  }
}

function touchTurn(turn: Turn, timestamp: string | null): void {
  const time = parseTimestamp(timestamp)
  if (time === null) return
  turn.startedAt = turn.startedAt === null ? time : Math.min(turn.startedAt, time)
  if (turn.status === 'inProgress') return
  turn.completedAt = Math.max(turn.completedAt ?? time, time)
  turn.durationMs = turn.completedAt === null || turn.startedAt === null
    ? null
    : Math.max(0, turn.completedAt - turn.startedAt)
}

function applyAssistantContent(turn: Turn, message: ClaudeSessionMessage, index: number): void {
  const content = messageContent(message)
  if (typeof content === 'string') {
    addAssistantText(turn, content)
    return
  }
  if (!Array.isArray(content)) return

  content.forEach((block, blockIndex) => {
    if (!isRecord(block)) return
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      addAssistantText(turn, block.text)
      return
    }
    if (block.type !== 'tool_use' || typeof block.name !== 'string') return
    const itemId = typeof block.id === 'string' && block.id
      ? block.id
      : `${messageUuid(message, index)}:tool:${blockIndex}`
    addTurnItem(turn, historyToolItem(itemId, block.name, block.input, 'inProgress'))
  })
}

function addAssistantText(turn: Turn, text: string): void {
  const itemId = `${turn.id}:assistant`
  const existing = turn.items.find((item) => item.id === itemId)
  if (existing?.type === 'agentMessage') {
    addTurnItem(turn, { ...existing, text: joinText(existing.text ?? '', text), phase: 'final_answer' })
    return
  }
  addTurnItem(turn, { id: itemId, type: 'agentMessage', text, phase: 'final_answer' })
}

function applyToolResults(turn: Turn, message: ClaudeSessionMessage): void {
  const content = messageContent(message)
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
    const existing = turn.items.find((item) => item.id === block.tool_use_id)
    if (existing) {
      addTurnItem(turn, { ...existing, status: block.is_error === true ? 'failed' : 'completed' })
    } else {
      addTurnItem(turn, {
        id: block.tool_use_id,
        type: 'dynamicToolCall',
        status: block.is_error === true ? 'failed' : 'completed',
      })
    }
  }
}

function historyToolItem(id: string, tool: string, input: unknown, status: string): ThreadItem {
  const record = isRecord(input) ? input : {}
  if (tool === 'Bash' && typeof record.command === 'string') {
    return { id, type: 'commandExecution', command: record.command, status }
  }
  if ((tool === 'Edit' || tool === 'Write') && typeof record.file_path === 'string') {
    return { id, type: 'fileChange', tool, status, changes: [{ path: record.file_path, kind: tool.toLowerCase() }] }
  }
  return { id, type: 'dynamicToolCall', tool, status, prompt: safeInputSummary(record) }
}

function upsertEntry(entries: ThreadItemEntry[], next: ThreadItemEntry): void {
  const id = typeof next.item.id === 'string' ? next.item.id : null
  if (!id) {
    entries.push(next)
    return
  }
  const index = entries.findIndex((entry) => entry.item.id === id)
  if (index < 0) {
    entries.push(next)
    return
  }
  entries[index] = {
    turnId: next.turnId,
    item: { ...entries[index].item, ...next.item },
  }
}

function addTurnItem(turn: Turn, item: ThreadItem): void {
  const index = typeof item.id === 'string' ? turn.items.findIndex((candidate) => candidate.id === item.id) : -1
  if (index < 0) {
    turn.items.push(item)
    return
  }
  turn.items[index] = { ...turn.items[index], ...item }
}

function userInputs(message: ClaudeSessionMessage): UserInput[] {
  const content = messageContent(message)
  if (typeof content === 'string') return content.trim() ? [textInput(content)] : []
  if (!Array.isArray(content)) return []
  const inputs: UserInput[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      inputs.push(textInput(block.text))
    } else if (block.type === 'image') {
      // Transcript images contain their encoded payload, not a stable local path.
      // Keep the turn visible without copying that potentially large payload into UI state.
      inputs.push(textInput('[图片输入]'))
    }
  }
  return inputs
}

function messageContent(message: ClaudeSessionMessage): unknown {
  if (typeof message.message === 'string' || Array.isArray(message.message)) return message.message
  if (!isRecord(message.message)) return null
  return message.message.content
}

function messageUuid(message: ClaudeSessionMessage, index: number): string {
  return message.uuid || `message-${index}`
}

function parseTimestamp(timestamp: string | null): number | null {
  if (!timestamp) return null
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : null
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeInputSummary(input: JsonObject): string | null {
  const keys = Object.keys(input)
  return keys.length > 0 ? keys.join(', ') : null
}

function joinText(left: string, right: string): string {
  if (!left) return right
  if (!right) return left
  return `${left}\n\n${right}`
}
