import type { AppServerEvent, ThreadCodexSettings } from '../domain/codex'
import type { WorkspaceDeliveryContext } from '../app-launcher/types'

export type AgentRunMode = 'detached' | 'delegated'
export type AgentWorkspaceAccess = 'read-only' | 'shared-write' | 'isolated-delivery'
export type AgentRunStatus = 'starting' | 'running' | 'waitingApproval' | 'completed' | 'failed' | 'cancelled'

export interface AgentRun {
  runId: string
  instanceId: string
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
  startThread(workspaceRoot: string): Promise<string>
  configureThread(threadId: string, settings: ThreadCodexSettings): Promise<void>
  startTurn(threadId: string, prompt: string): Promise<string>
  interruptTurn(threadId: string, turnId: string): Promise<void>
  inspectThread(threadId: string): Promise<ThreadInspection>
  readLastAgentMessage(threadId: string): Promise<string>
  openWorkspace(workspaceRoot: string): Promise<void>
  deliveryContext(workspaceRoot: string): Promise<WorkspaceDeliveryContext>
  removeWorkspace(workspaceRoot: string, runId: string): Promise<void>
}
