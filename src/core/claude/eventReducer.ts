import type { JsonObject, ThreadDetail, ThreadItem, Turn, UserInput } from '../domain/codex'
import { reduceThreadDetailEvent } from '../../features/conversation/conversationEventReducer'
import type { ClaudeAdapterEvent } from './types'

export function reduceClaudeEvent(detail: ThreadDetail, event: ClaudeAdapterEvent): ThreadDetail {
  const params = event.params ?? {}
  const turnId = stringParam(params, 'turnId')
  if (!turnId) return detail

  if (event.method === 'turn/started') {
    return {
      ...reduceThreadDetailEvent(detail, { type: 'turnStarted', turn: turn(detail, turnId, 'inProgress') }),
      activeTurnId: turnId,
    }
  }
  if (event.method === 'message/user') {
    const itemId = stringParam(params, 'itemId')
    if (!itemId || !Array.isArray(params.content)) return detail
    return reduceThreadDetailEvent(detail, {
      type: 'itemUpserted',
      turnId,
      item: { id: itemId, type: 'userMessage', content: params.content as UserInput[] },
    })
  }
  if (event.method === 'message/delta') {
    const itemId = stringParam(params, 'itemId')
    const delta = stringParam(params, 'delta') ?? ''
    if (!itemId || !delta) return detail
    const withItem = detail.items.some((entry) => entry.item.id === itemId)
      ? detail
      : reduceThreadDetailEvent(detail, {
        type: 'itemUpserted',
        turnId,
        item: { id: itemId, type: 'agentMessage', text: '', phase: 'final_answer' },
      })
    return reduceThreadDetailEvent(withItem, { type: 'agentMessageDelta', itemId, delta })
  }
  if (event.method === 'message/completed') {
    const itemId = stringParam(params, 'itemId')
    const text = stringParam(params, 'text') ?? ''
    if (!itemId) return detail
    return reduceThreadDetailEvent(detail, {
      type: 'itemUpserted',
      turnId,
      item: { id: itemId, type: 'agentMessage', text, phase: 'final_answer' },
    })
  }
  if (event.method === 'tool/started') {
    const itemId = stringParam(params, 'itemId')
    const toolName = stringParam(params, 'toolName')
    if (!itemId || !toolName) return detail
    return reduceThreadDetailEvent(detail, {
      type: 'itemUpserted',
      turnId,
      item: toolItem(itemId, toolName, params.input, 'inProgress'),
    })
  }
  if (event.method === 'tool/completed') {
    const itemId = stringParam(params, 'itemId')
    if (!itemId) return detail
    const existing = detail.items.find((entry) => entry.item.id === itemId)?.item
    return reduceThreadDetailEvent(detail, {
      type: 'itemUpserted',
      turnId,
      item: { ...(existing ?? { id: itemId, type: 'dynamicToolCall' }), status: params.isError ? 'failed' : 'completed' },
    })
  }
  if (event.method === 'turn/completed') {
    return completedTurn(detail, turnId, 'completed')
  }
  if (event.method === 'turn/interrupted') {
    return completedTurn(detail, turnId, 'interrupted')
  }
  if (event.method === 'turn/failed') {
    const message = stringParam(params, 'message') ?? 'Claude turn failed'
    return completedTurn(detail, turnId, 'failed', message)
  }
  return detail
}

function completedTurn(detail: ThreadDetail, turnId: string, status: Turn['status'], error?: string): ThreadDetail {
  return {
    ...reduceThreadDetailEvent(detail, { type: 'turnCompleted', turn: turn(detail, turnId, status, error) }),
    activeTurnId: null,
  }
}

function turn(detail: ThreadDetail, id: string, status: Turn['status'], error?: string): Turn {
  const current = detail.turns.find((candidate) => candidate.id === id)
  const now = Date.now()
  return {
    id,
    items: current?.items ?? [],
    status,
    error: error ? { message: error } : null,
    startedAt: current?.startedAt ?? now,
    completedAt: status === 'inProgress' ? null : now,
    durationMs: status === 'inProgress' || !current?.startedAt ? null : now - current.startedAt,
  }
}

function toolItem(id: string, tool: string, input: unknown, status: string): ThreadItem {
  const record = input && typeof input === 'object' ? input as JsonObject : {}
  if (tool === 'Bash' && typeof record.command === 'string') {
    return { id, type: 'commandExecution', command: record.command, status }
  }
  if ((tool === 'Edit' || tool === 'Write') && typeof record.file_path === 'string') {
    return { id, type: 'fileChange', tool, status, changes: [{ path: record.file_path, kind: tool.toLowerCase() }] }
  }
  return { id, type: 'dynamicToolCall', tool, status, prompt: safeInputSummary(record) }
}

function safeInputSummary(input: JsonObject): string | null {
  const keys = Object.keys(input)
  return keys.length > 0 ? keys.join(', ') : null
}

function stringParam(params: JsonObject, key: string): string | null {
  return typeof params[key] === 'string' ? params[key] : null
}
