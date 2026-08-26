export type JsonObject = Record<string, unknown>

export interface Workspace {
  root: string
  name: string
  createdAt: number
  lastOpenedAt: number
}

export type NavigationLayout = 'workspace' | 'list'
export type ThreadSort = 'recent' | 'manual'

export interface NavigationPreferences {
  layout: NavigationLayout
  sort: ThreadSort
  manualThreadOrder: string[]
}

export type FontSize = 'compact' | 'standard' | 'large'

export interface AppearancePreferences {
  fontSize: FontSize
}

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: string[] }

export interface Thread {
  id: string
  preview: string
  cwd: string
  name: string | null
  createdAt: number
  updatedAt: number
  recencyAt: number | null
  status: ThreadStatus
  ephemeral: boolean
  canAcceptDirectInput: boolean | null
  gitInfo?: { branch?: string | null; sha?: string | null } | null
  turns?: Turn[]
}

export interface Turn {
  id: string
  items: ThreadItem[]
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
  error: { message?: string } | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
}

export type UserInput = {
  type: 'text'
  text: string
  text_elements: unknown[]
}

export interface ThreadItem extends JsonObject {
  type: string
  id?: string
  text?: string
  content?: UserInput[]
  command?: string
  cwd?: string
  status?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
  durationMs?: number | null
  changes?: Array<{ path?: string; kind?: string; [key: string]: unknown }>
}

export interface ThreadItemEntry {
  turnId: string
  item: ThreadItem
}

export interface TokenUsageBreakdown {
  totalTokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown
  last: TokenUsageBreakdown
  modelContextWindow: number | null
}

export interface QueuedSubmission {
  id: string
  input: UserInput[]
  clientUserMessageId: string
}

export interface ThreadDetail {
  thread: Thread
  turns: Turn[]
  items: ThreadItemEntry[]
  nextTurnsCursor: string | null
  activeTurnId: string | null
  foreignActive: boolean
}

export type Badge = 'working' | 'approval' | 'success' | 'error' | null

export interface ThreadUiState {
  threadId: string
  lastReadAt: number | null
  badge: Badge
}

export interface PendingSteer {
  clientUserMessageId: string
  text: string
  createdAt: number
}

export interface ApprovalRequest {
  id: string | number
  method: string
  params: JsonObject
  threadId: string
}

export interface AppServerEvent extends JsonObject {
  id?: string | number
  method?: string
  params?: JsonObject
}

export const textInput = (text: string): UserInput => ({
  type: 'text',
  text,
  text_elements: [],
})

export function itemText(item: ThreadItem): string {
  if (item.type === 'userMessage') {
    return (item.content ?? [])
      .filter((content): content is UserInput => content.type === 'text')
      .map((content) => content.text)
      .join('\n')
  }
  return typeof item.text === 'string' ? item.text : ''
}

export function queueText(queue: QueuedSubmission): string {
  return queue.input
    .filter((content): content is UserInput => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
}

export function threadTitle(thread: Thread): string {
  return thread.name?.trim() || thread.preview?.trim() || '新会话'
}

export function isActive(status: ThreadStatus): boolean {
  return status.type === 'active'
}

export function threadsOlderThan(threads: Thread[], cutoff: number): Thread[] {
  return threads.filter((thread) => (thread.recencyAt ?? thread.updatedAt) < cutoff)
}
