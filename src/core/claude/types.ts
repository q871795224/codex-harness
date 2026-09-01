import type { AppServerEvent, JsonObject, UserInput } from '../domain/codex'

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
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'
  maxTurns?: number
}

export function claudeTurnPermissionOptions(input: Pick<ClaudeTurnStartInput, 'permissionMode'>): { permissionMode: NonNullable<ClaudeTurnStartInput['permissionMode']>; allowDangerouslySkipPermissions?: true } {
  const permissionMode = input.permissionMode ?? 'default'
  return permissionMode === 'bypassPermissions'
    ? { permissionMode, allowDangerouslySkipPermissions: true }
    : { permissionMode }
}

export interface ClaudeAdapterEvent extends AppServerEvent {
  method: string
  seq?: number
  replayed?: boolean
}
