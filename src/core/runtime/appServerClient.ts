import type {
  ActivePermissionProfile,
  ApprovalPolicy,
  ApprovalsReviewer,
  CodexConfig,
  CodexModel,
  CodexSkill,
  JsonObject,
  McpServerStatus,
  QueuedSubmission,
  SandboxPolicy,
  Thread,
  Turn,
  UserInput,
} from '../domain/codex'
import { runtime } from './bridge'

export interface ThreadSettingsResponse {
  approvalPolicy: ApprovalPolicy
  approvalsReviewer: ApprovalsReviewer
  model: string
  reasoningEffort: string | null
  serviceTier: string | null
  sandbox: SandboxPolicy
}

export interface ResumeThreadResponse extends ThreadSettingsResponse {
  thread: Thread
  initialTurnsPage?: { data: Turn[]; nextCursor: string | null } | null
  runtimeWorkspaceRoots: string[]
  activePermissionProfile: ActivePermissionProfile | null
}

export interface StartThreadResponse extends ThreadSettingsResponse {
  thread: Thread
  runtimeWorkspaceRoots: string[]
  activePermissionProfile: ActivePermissionProfile | null
}

export interface ForkThreadResponse extends ThreadSettingsResponse {
  thread: Thread
}

export interface FuzzyFileSearchResult {
  root: string
  path: string
  match_type: 'file' | 'directory'
  file_name: string
}

export const appServer = {
  listThreads: (params: JsonObject) => runtime.request<{ data: Thread[]; nextCursor: string | null }>('thread/list', params),
  resumeThread: (params: JsonObject) => runtime.request<ResumeThreadResponse>('thread/resume', params),
  startThread: (params: JsonObject) => runtime.request<StartThreadResponse>('thread/start', params),
  forkThread: (threadId: string, lastTurnId: string) => runtime.request<ForkThreadResponse>('thread/fork', { threadId, lastTurnId }),
  deleteThread: (threadId: string) => runtime.request<void>('thread/delete', { threadId }),
  archiveThread: (threadId: string) => runtime.request<void>('thread/archive', { threadId }),
  unarchiveThread: (threadId: string) => runtime.request<void>('thread/unarchive', { threadId }),
  renameThread: (threadId: string, name: string) => runtime.request<void>('thread/name/set', { threadId, name }),
  updateThreadSettings: (params: JsonObject) => runtime.request<void>('thread/settings/update', params),
  updateThreadMetadata: (params: JsonObject) => runtime.request<void>('thread/metadata/update', params),
  listTurns: (params: JsonObject) => runtime.request<{ data: Turn[]; nextCursor: string | null }>('thread/turns/list', params),
  startTurn: (params: JsonObject) => runtime.request<{ turn: Turn }>('turn/start', params),
  steerTurn: (params: { threadId: string; expectedTurnId: string; clientUserMessageId: string; input: UserInput[] }) => runtime.request<void>('turn/steer', params),
  interruptTurn: (threadId: string, turnId: string) => runtime.request<void>('turn/interrupt', { threadId, turnId }),
  listQueue: (threadId: string) => runtime.request<{ data: QueuedSubmission[] }>('thread/queue/list', { threadId, limit: 100 }),
  addQueue: (params: { threadId: string; clientUserMessageId: string; input: UserInput[] }) => runtime.request<void>('thread/queue/add', params),
  updateQueue: (threadId: string, queuedSubmissionId: string, input: UserInput[]) => runtime.request<void>('thread/queue/update', { threadId, queuedSubmissionId, input }),
  deleteQueue: (threadId: string, queuedSubmissionId: string) => runtime.request<void>('thread/queue/delete', { threadId, queuedSubmissionId }),
  startQueue: (threadId: string, queuedSubmissionId: string) => runtime.request<{ turn: Turn }>('thread/queue/start', { threadId, queuedSubmissionId }),
  listModels: () => runtime.request<{ data: CodexModel[]; nextCursor: string | null }>('model/list', { limit: 100, includeHidden: false }),
  readConfig: () => runtime.request<{ config: CodexConfig }>('config/read', { includeLayers: false }),
  listMcpServers: () => runtime.request<{ data: McpServerStatus[] }>('mcpServerStatus/list', { limit: 100, detail: 'toolsAndAuthOnly' }),
  reloadMcpServers: () => runtime.request<void>('config/mcpServer/reload'),
  writeConfigValue: (keyPath: string, value: unknown) => runtime.request<void>('config/value/write', { keyPath, value, mergeStrategy: 'upsert' }),
  listSkills: (workspaceRoot: string, forceReload = false) => runtime.request<{ data: Array<{ skills: CodexSkill[]; errors?: Array<{ path: string; message: string }> }> }>('skills/list', { cwds: [workspaceRoot], forceReload }),
  setSkillEnabled: (path: string, enabled: boolean) => runtime.request<void>('skills/config/write', { path, enabled }),
  fuzzyFileSearch: (query: string, roots: string[], cancellationToken?: string) => runtime.request<{ files: FuzzyFileSearchResult[] }>('fuzzyFileSearch', { query, roots, ...(cancellationToken ? { cancellationToken } : {}) }),
}
