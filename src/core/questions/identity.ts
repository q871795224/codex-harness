import type { ApprovalRequest } from '../domain/codex'
/** The App Server may assign a fresh JSON-RPC id when replaying the same item. */
export function questionRequestIdentity(request: ApprovalRequest): string {
  return request.method === 'item/tool/requestUserInput' && typeof request.params.itemId === 'string' && request.params.itemId
    ? request.params.itemId : String(request.id)
}
