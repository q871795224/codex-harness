import type {
  ActivePermissionProfile,
  JsonObject,
  SandboxPolicy,
  ThreadCodexSettings,
  ThreadItem,
  ThreadTokenUsage,
  TurnPlanStep,
} from '../../core/domain/codex'
import { sandboxModeForPolicy } from './threadLifecycle'

export function eventThreadId(params: JsonObject): string | null {
  if (typeof params.threadId === 'string') return params.threadId
  return typeof params.conversationId === 'string' ? params.conversationId : null
}

export function eventThreadItem(value: unknown): ThreadItem | null {
  if (!value || typeof value !== 'object') return null
  const item = value as JsonObject
  return typeof item.type === 'string' ? item as ThreadItem : null
}

export function eventThreadSettings(value: JsonObject): Partial<ThreadCodexSettings> {
  const settings: Partial<ThreadCodexSettings> = {}
  if (typeof value.model === 'string') settings.model = value.model
  if (typeof value.effort === 'string') settings.effort = value.effort
  if (typeof value.serviceTier === 'string' || value.serviceTier === null) settings.serviceTier = value.serviceTier
  if (value.approvalPolicy === 'untrusted' || value.approvalPolicy === 'on-request' || value.approvalPolicy === 'never') {
    settings.approvalPolicy = value.approvalPolicy
  }
  if (value.approvalsReviewer === 'user' || value.approvalsReviewer === 'auto_review') settings.approvalsReviewer = value.approvalsReviewer
  const sandbox = eventSandboxPolicy(value.sandboxPolicy)
  if (sandbox) settings.sandboxMode = sandboxModeForPolicy(sandbox)
  return settings
}

export function eventSandboxPolicy(value: unknown): SandboxPolicy | undefined {
  if (!value || typeof value !== 'object') return undefined
  const policy = value as JsonObject
  if (policy.type === 'dangerFullAccess') return { type: 'dangerFullAccess' }
  if (policy.type === 'readOnly' && typeof policy.networkAccess === 'boolean') {
    return { type: 'readOnly', networkAccess: policy.networkAccess }
  }
  if (policy.type === 'externalSandbox') {
    return { type: 'externalSandbox', networkAccess: policy.networkAccess }
  }
  if (policy.type === 'workspaceWrite'
    && Array.isArray(policy.writableRoots)
    && policy.writableRoots.every((root) => typeof root === 'string')
    && typeof policy.networkAccess === 'boolean'
    && typeof policy.excludeTmpdirEnvVar === 'boolean'
    && typeof policy.excludeSlashTmp === 'boolean') {
    return {
      type: 'workspaceWrite',
      writableRoots: policy.writableRoots,
      networkAccess: policy.networkAccess,
      excludeTmpdirEnvVar: policy.excludeTmpdirEnvVar,
      excludeSlashTmp: policy.excludeSlashTmp,
    }
  }
  return undefined
}

export function eventPermissionProfile(value: unknown): ActivePermissionProfile | null {
  if (!value || typeof value !== 'object') return null
  const profile = value as JsonObject
  if (typeof profile.id !== 'string') return null
  return { id: profile.id, extends: typeof profile.extends === 'string' ? profile.extends : null }
}

export function parseEventTokenUsage(value: unknown): ThreadTokenUsage | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as JsonObject
  const breakdown = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return null
    const source = candidate as JsonObject
    const number = (key: string, fallback = 0) => {
      const next = source[key]
      return typeof next === 'number' && Number.isFinite(next) ? Math.max(0, next) : fallback
    }
    if (typeof source.totalTokens !== 'number' || !Number.isFinite(source.totalTokens)) return null
    return {
      totalTokens: number('totalTokens'),
      inputTokens: number('inputTokens'),
      cachedInputTokens: number('cachedInputTokens'),
      cacheWriteInputTokens: number('cacheWriteInputTokens'),
      outputTokens: number('outputTokens'),
      reasoningOutputTokens: number('reasoningOutputTokens'),
    }
  }
  const total = breakdown(raw.total)
  const last = breakdown(raw.last)
  if (!total || !last) return null
  const modelContextWindow = typeof raw.modelContextWindow === 'number' && Number.isFinite(raw.modelContextWindow)
    ? Math.max(0, raw.modelContextWindow)
    : null
  return { total, last, modelContextWindow }
}

export function parseEventTurnPlan(value: unknown): TurnPlanStep[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((step): step is TurnPlanStep => {
    if (!step || typeof step !== 'object') return false
    const candidate = step as Partial<TurnPlanStep>
    return typeof candidate.step === 'string'
      && (candidate.status === 'pending' || candidate.status === 'inProgress' || candidate.status === 'completed')
  })
}
