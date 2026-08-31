import type { JsonObject } from '../../core/domain/codex'

export function isApprovalRequestMethod(method: string): boolean {
  return method === 'execCommandApproval'
    || method === 'applyPatchApproval'
    || method.endsWith('/requestApproval')
    || method === 'item/tool/requestUserInput'
}

export function approvalResponse(method: string, decision: unknown): JsonObject {
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: decision === 'accept' ? 'approved' : { denied: { rejection: 'Denied in Codex Harness' } } }
  }
  if (method === 'item/tool/requestUserInput') return { answers: {} }
  return { decision }
}
