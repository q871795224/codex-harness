import type { AppServerEvent, ThreadCodexSettings } from '../domain/codex'

export type AgentRunMode = 'detached' | 'delegated'
export type AgentRunStatus = 'starting' | 'running' | 'waitingApproval' | 'completed' | 'failed' | 'cancelled'

export interface AgentRun {
  runId: string
  instanceId: string
  mode: AgentRunMode
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
}

export interface StartAgentRunInput {
  instanceId: string
  title?: string
  mode: AgentRunMode
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
  startThread(workspaceRoot: string): Promise<string>
  configureThread(threadId: string, settings: ThreadCodexSettings): Promise<void>
  startTurn(threadId: string, prompt: string): Promise<string>
  interruptTurn(threadId: string, turnId: string): Promise<void>
  inspectThread(threadId: string): Promise<ThreadInspection>
  readLastAgentMessage(threadId: string): Promise<string>
}
