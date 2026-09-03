import type { AppServerEvent, JsonObject, ThreadTokenUsage, UserInput } from '../domain/codex'

export interface ClaudeRuntimeStatus {
  available: boolean
  managed: boolean
  running: boolean
  nodePath: string | null
  claudePath: string | null
  daemonPath: string | null
  socketPath: string | null
  error: string | null
}

export interface ClaudeTransportEvent {
  kind: 'connected' | 'disconnected'
  managed?: boolean
  daemonPid?: number
}

export interface ClaudePendingApproval {
  requestId: string
  sessionId: string
  turnId: string
  toolName: string
  input: JsonObject
  suggestions: unknown[]
}

export interface ClaudeProviderSnapshot {
  daemonPid: number
  daemonInstanceId: string
  latestEventSeq: number
  snapshotSeq: number
  activeTurns: Array<{ sessionId: string, turnId: string }>
  pendingApprovals: ClaudePendingApproval[]
}

export interface ClaudeSessionRecord {
  id: string
  providerSessionId: string | null
  cwd: string
  title: string
  archived: boolean
  createdAt: number
  updatedAt: number
}

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'

export interface ClaudeModel {
  value: string
  resolvedModel: string | null
  displayName: string
  description: string
  supportsEffort: boolean
  supportedEffortLevels: string[]
  supportsAdaptiveThinking: boolean
  supportsFastMode: boolean
  supportsAutoMode: boolean
}

export interface ClaudeSessionSettings {
  model: string | null
  effort: string | null
  permissionMode: ClaudePermissionMode
}

export const DEFAULT_CLAUDE_SESSION_SETTINGS: ClaudeSessionSettings = {
  model: null,
  effort: null,
  // 默认 Dangerous：会话未显式设置过时直接绕过权限审批；用户可在输入框切回 Ask。
  permissionMode: 'bypassPermissions',
}

export interface ClaudeModelResponse {
  models: ClaudeModel[]
}

export interface ClaudeContextUsage {
  totalTokens: number
  maxTokens: number
  rawMaxTokens: number
  percentage: number
  model: string
}

export interface ClaudeSessionInput {
  id: string
  providerSessionId: string | null
  cwd: string
  title: string
}

export interface ClaudeTurnStartInput {
  sessionId: string
  providerSessionId: string | null
  turnId: string
  cwd: string
  input: UserInput[]
  model?: string
  permissionMode?: ClaudePermissionMode
  effort?: string
  maxTurns?: number
}

export function claudeTurnPermissionOptions(input: Pick<ClaudeTurnStartInput, 'permissionMode'>): { permissionMode: NonNullable<ClaudeTurnStartInput['permissionMode']>; allowDangerouslySkipPermissions?: true } {
  const permissionMode = input.permissionMode ?? 'default'
  return permissionMode === 'bypassPermissions'
    ? { permissionMode, allowDangerouslySkipPermissions: true }
    : { permissionMode }
}

export function parseClaudeModel(value: unknown): ClaudeModel | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as JsonObject
  if (typeof raw.value !== 'string' || typeof raw.displayName !== 'string') return null
  return {
    value: raw.value,
    resolvedModel: typeof raw.resolvedModel === 'string' ? raw.resolvedModel : null,
    displayName: raw.displayName,
    description: typeof raw.description === 'string' ? raw.description : '',
    supportsEffort: raw.supportsEffort === true,
    supportedEffortLevels: Array.isArray(raw.supportedEffortLevels)
      ? raw.supportedEffortLevels.filter((entry): entry is string => typeof entry === 'string')
      : [],
    supportsAdaptiveThinking: raw.supportsAdaptiveThinking === true,
    supportsFastMode: raw.supportsFastMode === true,
    supportsAutoMode: raw.supportsAutoMode === true,
  }
}

export function parseClaudeTokenUsage(value: unknown): ThreadTokenUsage | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as JsonObject
  const parseBreakdown = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return null
    const source = candidate as JsonObject
    const number = (key: string) => typeof source[key] === 'number' && Number.isFinite(source[key])
      ? Math.max(0, source[key] as number)
      : 0
    if (typeof source.totalTokens !== 'number' || !Number.isFinite(source.totalTokens)) return null
    return {
      totalTokens: Math.max(0, source.totalTokens),
      inputTokens: number('inputTokens'),
      cachedInputTokens: number('cachedInputTokens'),
      cacheWriteInputTokens: number('cacheWriteInputTokens'),
      outputTokens: number('outputTokens'),
      reasoningOutputTokens: number('reasoningOutputTokens'),
    }
  }
  const total = parseBreakdown(raw.total)
  const last = parseBreakdown(raw.last)
  if (!total || !last) return null
  const modelContextWindow = typeof raw.modelContextWindow === 'number' && Number.isFinite(raw.modelContextWindow)
    ? Math.max(0, raw.modelContextWindow)
    : null
  return { total, last, modelContextWindow }
}

export interface ClaudeAdapterEvent extends AppServerEvent {
  method: string
  seq?: number
  replayed?: boolean
}
