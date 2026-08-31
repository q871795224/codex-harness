import type {
  JsonObject,
  SandboxPolicy,
  Thread,
  ThreadCodexSettings,
  ThreadDetail,
  UserInput,
} from '../../core/domain/codex'
import { emptyThreadDetail, rebaseSandboxPolicy } from '../../core/domain/codex'
import type { ResumeThreadResponse, StartThreadResponse, ThreadSettingsResponse } from '../../core/runtime/appServerClient'

export function runtimeThreadSettings(response: ThreadSettingsResponse): Partial<ThreadCodexSettings> {
  return {
    model: response.model,
    ...(response.reasoningEffort ? { effort: response.reasoningEffort } : {}),
    // Older App Server versions may omit this newly added field. Treat that as
    // the standard tier instead of letting an undefined value leak into state.
    serviceTier: response.serviceTier ?? null,
    approvalPolicy: response.approvalPolicy,
    approvalsReviewer: response.approvalsReviewer,
    sandboxMode: sandboxModeForPolicy(response.sandbox),
  }
}

export function resumedThreadDetail(response: ResumeThreadResponse): ThreadDetail {
  const initialTurns = response.initialTurnsPage?.data ?? response.thread.turns ?? []
  const turns = response.initialTurnsPage ? [...initialTurns].reverse() : initialTurns
  const activeTurnId = turns.find((turn) => turn.status === 'inProgress')?.id ?? null

  return {
    thread: response.thread,
    turns,
    items: turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))),
    nextTurnsCursor: response.initialTurnsPage?.nextCursor ?? null,
    activeTurnId,
    foreignActive: activeTurnId !== null,
    runtimeWorkspaceRoots: response.runtimeWorkspaceRoots,
    sandbox: response.sandbox,
    activePermissionProfile: response.activePermissionProfile,
    model: response.model,
    threadSettings: runtimeThreadSettings(response),
  }
}

export function startedThreadDetail(response: StartThreadResponse): ThreadDetail {
  return emptyThreadDetail(response.thread, {
    runtimeWorkspaceRoots: response.runtimeWorkspaceRoots,
    sandbox: response.sandbox,
    activePermissionProfile: response.activePermissionProfile,
    model: response.model,
    threadSettings: runtimeThreadSettings(response),
  })
}

export function resolveNewThreadWorkspaceRoot(
  selectedThreadId: string | null,
  threads: Thread[],
  fallbackWorkspaceRoot: string | null,
): string | null {
  return (selectedThreadId ? threads.find((thread) => thread.id === selectedThreadId)?.cwd : null) ?? fallbackWorkspaceRoot
}

export function threadTurnContext(detail: ThreadDetail | undefined, cwd: string): JsonObject {
  return {
    cwd,
    runtimeWorkspaceRoots: [cwd],
    ...threadPermissionOverrides(detail, detail?.thread.cwd ?? cwd, cwd),
  }
}

export function turnStartRequest(
  threadId: string,
  clientUserMessageId: string,
  input: UserInput[],
  thread: Thread | undefined,
  detail: ThreadDetail | undefined,
): JsonObject {
  return {
    threadId,
    clientUserMessageId,
    input,
    ...(thread ? threadTurnContext(detail, thread.cwd) : {}),
  }
}

export function threadPermissionOverrides(
  detail: ThreadDetail | undefined,
  previousCwd: string,
  nextCwd: string,
): JsonObject {
  if (detail?.activePermissionProfile) return { permissions: detail.activePermissionProfile.id }
  if (!detail?.sandbox) return {}
  if (detail.sandbox.type === 'externalSandbox' && previousCwd !== nextCwd) {
    throw new Error('当前会话由外部 sandbox 管理，不能在原会话中扩大可写目录；请在目标目录新建会话。')
  }
  return { sandboxPolicy: rebaseSandboxPolicy(detail.sandbox, previousCwd, nextCwd) }
}

export function isFirstUserTurn(detail: ThreadDetail | undefined): boolean {
  if (!detail) return false
  return !detail.items.some((entry) => entry.item.type === 'userMessage')
    && !detail.turns.some((turn) => turn.items.some((item) => item.type === 'userMessage'))
}

export function threadTitlePrompt(userText: string): string | null {
  const text = userText.trim()
  if (!text) return null
  return `Generate a title for this user's request:\n\nUser: ${text.slice(0, 8_000)}`
}

export function shouldDiscardDraftThread(unstarted: boolean, hasContent: boolean): boolean {
  return unstarted && !hasContent
}

export function sandboxModeForPolicy(policy: SandboxPolicy): ThreadCodexSettings['sandboxMode'] {
  if (policy.type === 'dangerFullAccess') return 'danger-full-access'
  if (policy.type === 'readOnly') return 'read-only'
  return 'workspace-write'
}
