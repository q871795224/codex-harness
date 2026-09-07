import { textInput, type JsonObject, type ThreadDetail, type ThreadItem, type ThreadItemEntry, type Turn, type UserInput } from '../domain/codex'
import type { ClaudeSessionMessage } from './types'

export interface ClaudeHistoryOptions {
  activeTurnId?: string | null
  activeUserInput?: UserInput[] | null
}

export interface ClaudeHistoryDetail {
  turns: Turn[]
  items: ThreadItemEntry[]
  activeTurnId: string | null
}

export function hydrateClaudeHistory(
  messages: ClaudeSessionMessage[],
  options: ClaudeHistoryOptions = {},
): ClaudeHistoryDetail {
  const activeTurnId = options.activeTurnId ?? null
  const activePromptUuid = activeTurnId && options.activeUserInput
    ? [...messages].reverse().find((message) => isUserPrompt(message)
      && inputsMatch(userInputs(message), options.activeUserInput ?? []))?.uuid ?? null
    : null
  const turns: Turn[] = []
  let currentTurn: Turn | null = null

  messages.forEach((message, index) => {
    if (message.type === 'user') {
      const content = userInputs(message)
      if (content.length > 0) {
        const messageId = messageUuid(message, index)
        const isActive = activePromptUuid === message.uuid
        const turnId = isActive && activeTurnId ? activeTurnId : `claude-history:${messageId}`
        currentTurn = createTurn(turnId, message.timestamp, isActive)
        turns.push(currentTurn)
        addTurnItem(currentTurn, {
          id: `${turnId}:user`,
          type: 'userMessage',
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
    if (turn.id === activeTurnId) continue
    turn.items = turn.items.map((item) => item.status === 'inProgress' ? { ...item, status: 'completed' } : item)
  }

  return {
    turns,
    items: turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))),
    activeTurnId: activePromptUuid && activeTurnId ? activeTurnId : null,
  }
}

export function mergeClaudeHistory(detail: ThreadDetail, history: ClaudeHistoryDetail): ThreadDetail {
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
  const hydratedActiveTurnId = history.activeTurnId
    && nextTurns.some((turn) => turn.id === history.activeTurnId && turn.status === 'inProgress')
    ? history.activeTurnId
    : null

  return {
    ...detail,
    turns: nextTurns,
    items,
    activeTurnId: detail.activeTurnId ?? hydratedActiveTurnId,
  }
}

function createTurn(id: string, timestamp: string | null, active: boolean): Turn {
  const time = parseTimestamp(timestamp)
  return {
    id,
    items: [],
    status: active ? 'inProgress' : 'completed',
    error: null,
    startedAt: time,
    completedAt: active ? null : time,
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

function isUserPrompt(message: ClaudeSessionMessage): boolean {
  return message.type === 'user' && userInputs(message).length > 0
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

function inputsMatch(left: UserInput[], right: UserInput[]): boolean {
  if (left.length !== right.length) return false
  return left.every((input, index) => inputKey(input) === inputKey(right[index]))
}

function inputKey(input: UserInput): string {
  if (input.type === 'text') return `text:${input.text}`
  if (input.type === 'localImage') return `localImage:${input.path}`
  if (input.type === 'image') return `image:${input.url}`
  if (input.type === 'skill') return `skill:${input.name}:${input.path}`
  return `mention:${input.name}:${input.path}`
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
