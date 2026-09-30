import type { AgentProvider, AgentRun, AgentRunService } from '../agent-runs/types'
import type { CodexSkill, ThreadCodexSettings } from '../domain/codex'

export interface TeamDocument { revision: number; content: string }
export interface AgentMember {
  id: string
  name: string
  description: string
  instructions: string
  provider: AgentProvider
  model: string
  effort: string
  skills: Array<{ name: string; path: string }>
  access: 'read-only' | 'isolated-delivery'
  archived: boolean
}
export interface AgentTeam { id: string; name: string; leaderId: string; memberIds: string[]; instructions: string; archived: boolean }
export type TaskStatus = 'draft' | 'running' | 'paused' | 'review' | 'done' | 'stopped'
export interface TaskLimits { maxRuns: number; maxReworks: number; maxMinutes: number }
export interface TeamStep {
  id: string
  member: AgentMember
  role: 'leader' | 'worker'
  instruction: string
  runId: string | null
  consumed: boolean
  createdAt: number
}
export interface TeamTask {
  id: string
  title: string
  brief: string
  workspaceRoot: string
  executionRoot: string | null
  parentThreadId: string | null
  target: { kind: 'member' | 'team'; id: string }
  // Freeze team/identity configuration per task. Edits only affect new tasks.
  members: AgentMember[]
  team: AgentTeam | null
  status: TaskStatus
  owner: string | null
  limits: TaskLimits
  reworks: number
  steps: TeamStep[]
  note: string
  createdAt: number
  updatedAt: number
  deadline: number | null
}
export interface TeamState { schemaVersion: 1; members: AgentMember[]; teams: AgentTeam[]; tasks: TeamTask[] }
export interface TeamSnapshot { state: TeamState; loading: boolean; error: string | null }
export interface LeaderDecision { action: 'delegate' | 'review' | 'blocked'; memberId?: string; instruction?: string; reason: string }
export interface CreateTeamTask {
  title: string; brief: string; workspaceRoot: string; parentThreadId: string | null
  target: TeamTask['target']; limits: TaskLimits
}
export interface TeamsService {
  snapshot(): TeamSnapshot
  isCoordinating(taskId: string): boolean
  subscribe(listener: () => void): () => void
  initialize(): Promise<void>
  refresh(): Promise<void>
  saveMember(member: AgentMember): Promise<void>
  saveTeam(team: AgentTeam): Promise<void>
  createTask(input: CreateTeamTask): Promise<string>
  startTask(id: string): Promise<void>
  pauseTask(id: string): Promise<void>
  stopTask(id: string): Promise<void>
  approveTask(id: string): Promise<void>
  reworkTask(id: string, feedback: string): Promise<void>
  extendLimits(id: string, limits: TaskLimits): Promise<void>
  readMemory(memberId: string, workspaceRoot?: string): Promise<TeamDocument>
  saveMemory(memberId: string, expectedRevision: number, text: string, workspaceRoot?: string): Promise<TeamDocument>
  result(step: TeamStep): Promise<string>
  models(): Promise<Array<{ id: string; name: string; efforts: string[]; provider: AgentProvider }>>
  skills(cwd: string): Promise<CodexSkill[]>
  runs: AgentRunService
}
export interface TeamDependencies {
  read(key: string): Promise<TeamDocument>
  write(key: string, revision: number, content: string): Promise<TeamDocument>
  runs: AgentRunService
  settings(member: AgentMember, readOnly: boolean, cwd: string): Promise<ThreadCodexSettings>
  models: TeamsService['models']
  skills: TeamsService['skills']
  now?: () => number
  notify?(title: string, message: string): void
}
export const DEFAULT_TASK_LIMITS: TaskLimits = { maxRuns: 12, maxReworks: 2, maxMinutes: 60 }
export const emptyTeamState = (): TeamState => ({ schemaVersion: 1, members: [], teams: [], tasks: [] })
export const activeRun = (run: AgentRun) => ['starting', 'running', 'waitingApproval'].includes(run.status)
