import type { JsonObject } from '../../core/domain/codex'

export function isApprovalRequestMethod(method: string): boolean {
  return method === 'execCommandApproval'
    || method === 'applyPatchApproval'
    || method.endsWith('/requestApproval')
}

export function isServerRequestMethod(method: string): boolean {
  return isApprovalRequestMethod(method)
    || method === 'item/tool/requestUserInput'
}

export function approvalResponse(method: string, decision: unknown): JsonObject {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: decision === 'accept' ? 'approved' : { denied: { rejection: 'Denied in Codex Harness' } } }
  }
  return { decision }
}

export function serverRequestResponse(method: string, decision: unknown): JsonObject {
  if (method === 'item/tool/requestUserInput') {
    return decision && typeof decision === 'object' && !Array.isArray(decision)
      ? decision as JsonObject
      : { answers: {} }
  }
  return approvalResponse(method, decision)
}
