import type { AppServerEvent, UserInput } from '../domain/codex'

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
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk'
  maxTurns?: number
}

export interface ClaudeAdapterEvent extends AppServerEvent {
  method: string
  seq?: number
}
