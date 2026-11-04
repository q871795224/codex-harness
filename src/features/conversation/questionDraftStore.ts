import { questionRequestIdentity } from '../../core/questions/identity'
import { runtime } from '../../core/runtime/bridge'
import { createQuestionDrafts } from '../../core/questions/drafts'
import type { ApprovalRequest } from '../../core/domain/codex'
export const questionDrafts = createQuestionDrafts({
  load: (key) => runtime.getAppState(key),
  save: (key, value) => runtime.setAppState(key, value),
})
export function questionDraftKey(request: ApprovalRequest): string {
  return `questions.draft:${JSON.stringify([request.threadId, request.params.turnId ?? '', request.method, questionRequestIdentity(request)])}`
}
