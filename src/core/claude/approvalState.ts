import type { ApprovalRequest, JsonObject } from '../domain/codex'
import type { ClaudeAdapterEvent, ClaudePendingApproval } from './types'

export interface ClaudeApprovalStateResult {
  approvals: Record<string, ApprovalRequest[]>
  eventSeqById: Record<string, number>
  resolvedSeqById: Record<string, number>
}

export function approvalRequestFromEvent(event: ClaudeAdapterEvent): ApprovalRequest | null {
  const params = event.params ?? {}
  const requestId = typeof params.requestId === 'string' ? params.requestId : null
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : null
  if (!requestId || !sessionId) return null
  const toolName = typeof params.toolName === 'string' ? params.toolName : 'Tool'
  const input = objectValue(params.input)
  return makeApprovalRequest(requestId, sessionId, typeof params.turnId === 'string' ? params.turnId : '', toolName, input, arrayValue(params.suggestions))
}

export function approvalRequestFromSnapshot(approval: ClaudePendingApproval): ApprovalRequest {
  return makeApprovalRequest(
    approval.requestId,
    approval.sessionId,
    approval.turnId,
    approval.toolName,
    approval.input,
    approval.suggestions,
  )
}

export function reconcileClaudeApprovalSnapshot(
  current: Record<string, ApprovalRequest[]>,
  snapshot: ClaudePendingApproval[],
  snapshotSeq: number | null,
  eventSeqById: Readonly<Record<string, number>>,
  resolvedSeqById: Readonly<Record<string, number>>,
  preserveFutureEvents: boolean,
): ClaudeApprovalStateResult {
  const nextEntries = new Map<string, { request: ApprovalRequest, eventSeq: number | undefined }>()
  const snapshotIds = new Set<string>()
  for (const approval of snapshot) {
    const request = approvalRequestFromSnapshot(approval)
    const id = String(request.id)
    const resolvedSeq = resolvedSeqById[id]
    if (snapshotSeq !== null && resolvedSeq !== undefined && resolvedSeq > snapshotSeq) continue
    snapshotIds.add(id)
    nextEntries.set(id, { request, eventSeq: snapshotSeq ?? eventSeqById[id] })
  }

  if (preserveFutureEvents && snapshotSeq !== null) {
    for (const request of Object.values(current).flat()) {
      const id = String(request.id)
      const eventSeq = eventSeqById[id]
      const resolvedSeq = resolvedSeqById[id]
      if (snapshotIds.has(id) || eventSeq === undefined || eventSeq <= snapshotSeq) continue
      if (resolvedSeq !== undefined && resolvedSeq > snapshotSeq) continue
      nextEntries.set(id, { request, eventSeq })
    }
  }

  const approvals: Record<string, ApprovalRequest[]> = {}
  const nextEventSeqById: Record<string, number> = {}
  const nextResolvedSeqById: Record<string, number> = {}
  for (const { request, eventSeq } of nextEntries.values()) {
    const sessionId = request.threadId
    approvals[sessionId] = [...(approvals[sessionId] ?? []), request]
    const id = String(request.id)
    if (eventSeq !== undefined) nextEventSeqById[id] = eventSeq
  }

  for (const [id, eventSeq] of Object.entries(resolvedSeqById)) {
    if (nextEntries.has(id)) continue
    if (snapshotSeq !== null && eventSeq <= snapshotSeq) continue
    nextResolvedSeqById[id] = eventSeq
  }

  return { approvals, eventSeqById: nextEventSeqById, resolvedSeqById: nextResolvedSeqById }
}

function makeApprovalRequest(
  requestId: string,
  sessionId: string,
  turnId: string,
  toolName: string,
  input: JsonObject,
  suggestions: unknown[],
): ApprovalRequest {
  const command = toolName === 'Bash' && typeof input.command === 'string' ? input.command : undefined
  return {
    id: requestId,
    method: 'claude/tool/requestApproval',
    threadId: sessionId,
    params: {
      toolName,
      input,
      ...(turnId ? { turnId } : {}),
      ...(command ? { command } : {}),
      ...(suggestions.length > 0 ? { suggestions } : {}),
      reason: `Claude 请求使用 ${toolName}`,
    },
  }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
