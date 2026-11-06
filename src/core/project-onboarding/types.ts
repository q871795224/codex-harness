import type { EntryMutation, ProjectMeta, ProjectDocSnapshot } from '../../features/project-doc/types'

export interface OnboardingPlan {
  status: string | null
  log: string[]
  decisions: string[]
  openQuestions: string[]
  mutations: EntryMutation[]
}
export interface OnboardingCommit extends OnboardingPlan {
  requestId: string; projectId: string; threadId: string; name: string | null; baseSeq: number | null
}
export interface OnboardingReceipt { projectId: string; seq: number }
export interface OnboardingSource { threadId: string; title: string; cwd: string }
export interface OnboardingState {
  id: string; source: OnboardingSource; mode: 'create' | 'join'; name: string; projectId: string
  phase: 'confirm' | 'reading' | 'running' | 'saving' | 'binding' | 'done' | 'error'
  requestedBy: 'user' | 'agent'; error?: string; detail?: string; receipt?: OnboardingReceipt
  messages?: number; chunks?: number; completedChunks?: number
}
export interface OnboardingSettings { instanceId: string; model: string; effort: string }
export interface ProjectOnboardingService {
  snapshot(): ReadonlyMap<string, OnboardingState>
  subscribe(listener: () => void): () => void
  request(threadId: string, options?: { mode?: 'create' | 'join'; name?: string; projectId?: string; requestedBy?: 'user' | 'agent' }): Promise<{ requestId: string; phase: string }>
  confirm(threadId: string, selection: { mode: 'create' | 'join'; name: string; projectId: string }, settings: OnboardingSettings): Promise<void>
  dismiss(threadId: string): void
  resumeBindings(): Promise<void>
  restoreSaved(): Promise<void>
  listProjects(): Promise<ProjectMeta[]>
}
export interface OnboardingPorts {
  saved?(): Promise<Array<OnboardingReceipt & { requestId: string; threadId: string; name: string }>>
  source(threadId: string): Promise<OnboardingSource>
  busy(threadId: string): boolean
  history(source: OnboardingSource): Promise<string[]>
  project(projectId: string): Promise<ProjectDocSnapshot>
  binding(threadId: string): Promise<unknown>
  commit(input: OnboardingCommit): Promise<OnboardingReceipt>
  finish(requestId: string, threadId: string, cwd: string): Promise<string>
}
