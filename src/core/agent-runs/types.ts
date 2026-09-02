import type { AppServerEvent, ThreadCodexSettings } from '../domain/codex'
import type { WorkspaceDeliveryContext } from '../app-launcher/types'

export type AgentRunMode = 'detached' | 'delegated'
export type AgentProvider = 'codex' | 'claude'
export type AgentWorkspaceAccess = 'read-only' | 'shared-write' | 'isolated-delivery'
export type AgentRunStatus = 'starting' | 'running' | 'waitingApproval' | 'completed' | 'failed' | 'cancelled'

export interface AgentRun {
  runId: string
  instanceId: string
  /** Older persisted runs do not have this field; callers must infer Codex for those. */
  provider?: AgentProvider
  mode: AgentRunMode
  workspaceAccess: AgentWorkspaceAccess
  status: AgentRunStatus
  title: string
  workspaceRoot: string
  parentThreadId: string | null
  childThreadId: string | null
  turnId: string | null
  errorSummary: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  returnedAt: number | null
  workspaceRemovedAt: number | null
}

export interface StartAgentRunInput {
  instanceId: string
  provider?: AgentProvider
  title?: string
  mode: AgentRunMode
  workspaceAccess: AgentWorkspaceAccess
  workspaceRoot: string
  parentThreadId?: string | null
  prompt: string
  settings?: ThreadCodexSettings
}

export interface AgentRunService {
  initialize(): Promise<void>
  snapshot(): AgentRun[]
  subscribe(listener: () => void): () => void
  start(input: StartAgentRunInput): Promise<AgentRun>
  cancel(runId: string): Promise<void>
  loadResult(runId: string): Promise<string>
  returnToParent(runId: string): Promise<void>
  openWorkspace(runId: string): Promise<void>
  deliveryContext(runId: string): Promise<WorkspaceDeliveryContext>
  removeWorkspace(runId: string): Promise<void>
  openThread(threadId: string): void
  handleEvent(event: AppServerEvent): void
}

export interface ThreadInspection {
  active: boolean
  lastTurnStatus: 'completed' | 'interrupted' | 'failed' | 'inProgress' | null
}

export interface AgentRunTransport {
  listRuns(): Promise<AgentRun[]>
  saveRun(run: AgentRun): Promise<AgentRun>
  prepareWorkspace(workspaceRoot: string, access: AgentWorkspaceAccess, runId: string): Promise<string>
  startThread(workspaceRoot: string, provider?: AgentProvider): Promise<string>
  configureThread(threadId: string, settings: ThreadCodexSettings, provider?: AgentProvider): Promise<void>
  startTurn(threadId: string, prompt: string, provider?: AgentProvider): Promise<string>
  interruptTurn(threadId: string, turnId: string, provider?: AgentProvider): Promise<void>
  inspectThread(threadId: string, provider?: AgentProvider): Promise<ThreadInspection>
  readLastAgentMessage(threadId: string, provider?: AgentProvider): Promise<string>
  openWorkspace(workspaceRoot: string): Promise<void>
  deliveryContext(workspaceRoot: string): Promise<WorkspaceDeliveryContext>
  removeWorkspace(workspaceRoot: string, runId: string): Promise<void>
}
