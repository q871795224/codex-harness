import type {
  JsonObject,
  CodexTurnTrigger,
  SandboxPolicy,
  Thread,
  ThreadCodexSettings,
  ThreadDetail,
  UserInput,
} from '../../core/domain/codex'
import { emptyThreadDetail, rebaseSandboxPolicy } from '../../core/domain/codex'
import type { ResumeThreadResponse, StartThreadResponse, ThreadSettingsResponse } from '../../core/runtime/appServerClient'

export async function resumeThreadWithRetry<T>(resume: () => Promise<T>): Promise<T> {
  try {
    return await resume()
  } catch (error) {
    if (!isAppServerTransportError(error)) throw error
    return resume()
  }
}

function isAppServerTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(connection|socket|websocket|closed|连接|断开)/i.test(message)
}

export function resumeThreadRequest(threadId: string, cwd?: string): JsonObject {
  return {
    threadId,
    ...(cwd ? { cwd, runtimeWorkspaceRoots: [cwd] } : {}),
    excludeTurns: true,
    initialTurnsPage: { limit: 5, sortDirection: 'desc', itemsView: 'full' },
  }
}

export function activeThreadIdsForRecovery(
  threads: Thread[],
  activeTurnIds: Record<string, string>,
  details: Record<string, ThreadDetail>,
  selectedThreadId: string | null,
): string[] {
  const activeThreadIds = new Set([
    ...threads.filter((thread) => thread.status.type === 'active').map((thread) => thread.id),
    ...Object.keys(activeTurnIds),
    ...Object.entries(details)
      .filter(([, detail]) => detail.activeTurnId !== null)
      .map(([threadId]) => threadId),
  ])
  if (selectedThreadId) activeThreadIds.delete(selectedThreadId)
  return [...activeThreadIds]
}

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
  nextThreadCwd: string | null,
): string | null {
  return (selectedThreadId ? threads.find((thread) => thread.id === selectedThreadId)?.cwd : null) ?? nextThreadCwd
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
  trigger?: CodexTurnTrigger,
): JsonObject {
  return {
    threadId,
    clientUserMessageId,
    input,
    ...(trigger ? { turnTrigger: trigger } : {}),
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
