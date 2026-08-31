export type JsonObject = Record<string, unknown>

export interface Workspace {
  root: string
  checkoutRoot: string
  name: string
  branch: string | null
  sha: string | null
  createdAt: number
  lastOpenedAt: number
}

export type NavigationLayout = 'workspace' | 'list'
export type ThreadSort = 'recent' | 'manual'
export type WorkspaceSort = 'stable' | 'recent'

export interface NavigationPreferences {
  layout: NavigationLayout
  sort: ThreadSort
  manualThreadOrder: string[]
  workspaceSort: WorkspaceSort
  pinnedThreadIds: string[]
  pinnedWorkspaceRoots: string[]
  sidebarWidth: number
  sidebarCollapsed: boolean
}

export const MIN_SIDEBAR_WIDTH = 214
export const DEFAULT_SIDEBAR_WIDTH = 284
export const MAX_SIDEBAR_WIDTH = 480

export function normalizeSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)))
}

export const MIN_FONT_SIZE = 13
export const DEFAULT_FONT_SIZE = 15
export const MAX_FONT_SIZE = 19

export type FontSize = number
export type FontSizeArea = 'navigation' | 'conversation' | 'settings' | 'plugins'

export interface FontSizePreferences {
  navigation: FontSize
  conversation: FontSize
  settings: FontSize
  plugins: FontSize
}

export const DEFAULT_FONT_SIZES: FontSizePreferences = {
  navigation: 13,
  conversation: DEFAULT_FONT_SIZE,
  settings: DEFAULT_FONT_SIZE,
  plugins: DEFAULT_FONT_SIZE,
}

export function normalizeFontSize(value: unknown): FontSize {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)))
  }
  if (value === 'compact') return 14
  if (value === 'large') return 16
  return DEFAULT_FONT_SIZE
}

export function defaultFontSizePreferences(): FontSizePreferences {
  return { ...DEFAULT_FONT_SIZES }
}

export function normalizeFontSizePreferences(value: unknown): FontSizePreferences {
  const raw = value && typeof value === 'object' ? value as JsonObject : {}
  const saved = raw.fontSizes && typeof raw.fontSizes === 'object' ? raw.fontSizes as JsonObject : null
  if (saved) {
    return {
      navigation: normalizeFontSize(saved.navigation ?? DEFAULT_FONT_SIZES.navigation),
      conversation: normalizeFontSize(saved.conversation ?? DEFAULT_FONT_SIZES.conversation),
      settings: normalizeFontSize(saved.settings ?? DEFAULT_FONT_SIZES.settings),
      plugins: normalizeFontSize(saved.plugins ?? DEFAULT_FONT_SIZES.plugins),
    }
  }

  const offset = normalizeFontSize(raw.fontSize) - DEFAULT_FONT_SIZE
  return {
    navigation: normalizeFontSize(DEFAULT_FONT_SIZES.navigation + offset),
    conversation: normalizeFontSize(DEFAULT_FONT_SIZES.conversation + offset),
    settings: normalizeFontSize(DEFAULT_FONT_SIZES.settings + offset),
    plugins: normalizeFontSize(DEFAULT_FONT_SIZES.plugins + offset),
  }
}

export interface AppearancePreferences {
  theme: Theme
  fontSizes: FontSizePreferences
}

export type Theme = 'light' | 'dark'
export type SendShortcut = 'mod-enter' | 'enter'
export type FollowUpMode = 'queue' | 'interject'
export type HarnessActionId = 'thread.new' | `thread.select.${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | 'sidebar.toggle' | 'composer.focus' | 'tab.focus.toggle'
export type HarnessActionShortcuts = Record<HarnessActionId, string>

export interface KeyboardPreferences {
  sendShortcut: SendShortcut
  followUpMode: FollowUpMode
  actionShortcuts: HarnessActionShortcuts
}

export interface ThreadTitleGenerationSettings {
  model: string
  effort: string
  prompt: string
}

export const DEFAULT_THREAD_TITLE_PROMPT = `Generate a concise, single-line task title of at most 80 characters and under five words where possible.
Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise.
Preserve ticket references exactly. Write in the user's language. Do not use quotes, Markdown, or trailing punctuation.
Return only the title. Do not answer the user's request.`

export const DEFAULT_THREAD_TITLE_GENERATION: ThreadTitleGenerationSettings = {
  model: 'gpt-5.6-luna',
  effort: 'low',
  prompt: DEFAULT_THREAD_TITLE_PROMPT,
}

export function normalizeTheme(value: unknown): Theme {
  return value === 'dark' ? 'dark' : 'light'
}

export function normalizeSendShortcut(value: unknown): SendShortcut {
  return value === 'enter' ? 'enter' : 'mod-enter'
}

export function normalizeFollowUpMode(value: unknown): FollowUpMode {
  return value === 'interject' ? 'interject' : 'queue'
}

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: string[] }

export interface Thread {
  id: string
  sessionId?: string
  forkedFromId?: string | null
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

export interface RuntimeVersions {
  harness: string
  appServer: string | null
  codexCli: string | null
}

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export type ApprovalsReviewer = 'user' | 'auto_review'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'externalSandbox'; networkAccess: unknown }
  | {
    type: 'workspaceWrite'
    writableRoots: string[]
    networkAccess: boolean
    excludeTmpdirEnvVar: boolean
    excludeSlashTmp: boolean
  }

export interface ActivePermissionProfile {
  id: string
  extends: string | null
}

export interface ThreadCodexSettings {
  model: string
  effort: string
  serviceTier: string | null
  approvalPolicy: ApprovalPolicy
  approvalsReviewer: ApprovalsReviewer
  sandboxMode: SandboxMode
}

export interface ReasoningEffortOption {
  reasoningEffort: string
  description: string
}

export interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  supportedReasoningEfforts: ReasoningEffortOption[]
  defaultReasoningEffort: string
  inputModalities: string[]
  isDefault: boolean
  serviceTiers?: CodexServiceTier[]
  defaultServiceTier?: string | null
}

export interface CodexServiceTier {
  id: string
  name: string
  description: string
}

export interface CodexConfig {
  model: string | null
  model_reasoning_effort: string | null
  service_tier?: string | null
  approval_policy: ApprovalPolicy | null
  approvals_reviewer?: ApprovalsReviewer | null
  sandbox_mode?: SandboxMode | null
  mcp_servers?: Record<string, { enabled?: boolean }>
  project_doc_fallback_filenames?: string[] | null
  project_doc_max_bytes?: number | null
}

export interface CodexSkill {
  name: string
  description: string
  path: string
  scope: string
  enabled: boolean
  pluginId: string | null
}

export interface McpServerStatus {
  name: string
  runtimeStatus: McpRuntimeStatus | null
  pluginId: string | null
  tools: Record<string, unknown>
  resources: unknown[]
  authStatus: string | { state?: string; [key: string]: unknown }
  startupError?: string | null
}

export type McpRuntimeStatus =
  | 'notStarted'
  | 'starting'
  | 'connected'
  | 'authenticationRequired'
  | 'failed'
  | 'cancelled'
  | 'disabled'

export interface Turn {
  id: string
  items: ThreadItem[]
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
  error: { message?: string } | null
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string }

export interface ThreadItem extends JsonObject {
  type: string
  id?: string
  text?: string
  phase?: 'commentary' | 'final_answer' | null
  content?: UserInput[]
  command?: string
  cwd?: string
  status?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
  durationMs?: number | null
  changes?: Array<{ path?: string; kind?: string; [key: string]: unknown }>
  tool?: string
  prompt?: string | null
  senderThreadId?: string
  receiverThreadIds?: string[]
  agentsStates?: Record<string, { status?: string; message?: string | null }>
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

export interface TurnPlanStep {
  step: string
  status: 'pending' | 'inProgress' | 'completed'
}

export interface ThreadCreditUsage {
  creditsMicros: number
  usdMicros: number | null
}

export function parseThreadCreditUsage(value: unknown): ThreadCreditUsage | null {
  if (!value || typeof value !== 'object') return null
  const threadUsage = (value as JsonObject).threadUsage
  if (!threadUsage || typeof threadUsage !== 'object') return null
  const raw = threadUsage as JsonObject
  const creditsMicros = finiteNumber(raw.estimatedUsageCreditsMicros)
  if (creditsMicros === null) return null
  return {
    creditsMicros: Math.max(0, creditsMicros),
    usdMicros: finiteNumber(raw.estimatedUsageUsdMicros),
  }
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
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
  runtimeWorkspaceRoots: string[]
  sandbox: SandboxPolicy | null
  activePermissionProfile: ActivePermissionProfile | null
  model: string | null
  threadSettings?: Partial<ThreadCodexSettings> | null
}

export function emptyThreadDetail(
  thread: Thread,
  runtime: Partial<Pick<ThreadDetail, 'runtimeWorkspaceRoots' | 'sandbox' | 'activePermissionProfile' | 'model' | 'threadSettings'>> = {},
): ThreadDetail {
  return {
    thread,
    turns: [],
    items: [],
    nextTurnsCursor: null,
    activeTurnId: null,
    foreignActive: false,
    runtimeWorkspaceRoots: runtime.runtimeWorkspaceRoots ?? [thread.cwd],
    sandbox: runtime.sandbox ?? null,
    activePermissionProfile: runtime.activePermissionProfile ?? null,
    model: runtime.model ?? null,
    threadSettings: runtime.threadSettings ?? null,
  }
}

export function rebaseSandboxPolicy(policy: SandboxPolicy | null, previousCwd: string, nextCwd: string): SandboxPolicy | null {
  if (!policy || policy.type !== 'workspaceWrite') return policy
  const writableRoots = policy.writableRoots.filter((root) => root !== previousCwd && root !== nextCwd)
  return { ...policy, writableRoots: [nextCwd, ...writableRoots] }
}

export function parseGeneratedThreadTitle(value: string): string | null {
  const title = value
    .trim()
    .split(/\r?\n/, 1)[0]
    .replace(/^\s*(?:[-*#]+\s*)/, '')
    .replace(/^["'`“‘]+|["'`”’。.!！?？]+$/g, '')
    .trim()
  return title ? [...title].slice(0, 80).join('') : null
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
      .filter((content): content is Extract<UserInput, { type: 'text' }> => content.type === 'text')
      .map((content) => content.text)
      .join('\n')
  }
  return typeof item.text === 'string' ? item.text : ''
}

export function queueText(queue: QueuedSubmission): string {
  const text = queue.input
    .filter((content): content is Extract<UserInput, { type: 'text' }> => content.type === 'text')
    .map((content) => content.text)
    .join('\n')
  if (text) return text
  const count = queue.input.filter((content) => content.type === 'localImage' || content.type === 'image' || content.type === 'mention').length
  return count ? `${count} 个附件` : ''
}

export function threadTitle(thread: Thread): string {
  return thread.name?.trim() || thread.preview?.trim() || '新会话'
}

export function withInitialThreadPreview(thread: Thread, text: string): Thread {
  if (thread.preview.trim()) return thread
  const preview = text.replace(/\s+/g, ' ').trim()
  return preview ? { ...thread, preview } : thread
}

export function isActive(status: ThreadStatus): boolean {
  return status.type === 'active'
}

export function touchThreadActivity(thread: Thread, timestamp = Math.floor(Date.now() / 1_000)): Thread {
  return { ...thread, updatedAt: timestamp, recencyAt: timestamp }
}

export function sortThreads(threads: Thread[], sort: ThreadSort, manualOrder: string[], pinnedThreadIds: string[] = []): Thread[] {
  const byRecentActivity = (left: Thread, right: Thread) => {
    const activeDifference = Number(isActive(right.status)) - Number(isActive(left.status))
    if (activeDifference !== 0) return activeDifference
    const leftDate = left.recencyAt ?? left.updatedAt
    const rightDate = right.recencyAt ?? right.updatedAt
    return rightDate - leftDate
  }
  const recentFirst = [...threads].sort(byRecentActivity)
  if (sort === 'recent') return prioritizePinned(recentFirst, pinnedThreadIds, (thread) => thread.id)

  const ranks = new Map(manualOrder.map((id, index) => [id, index]))
  const manuallyOrdered = recentFirst.sort((left, right) => {
    const leftRank = ranks.get(left.id)
    const rightRank = ranks.get(right.id)
    if (leftRank === undefined && rightRank === undefined) return 0
    if (leftRank === undefined) return -1
    if (rightRank === undefined) return 1
    return leftRank - rightRank
  })
  return prioritizePinned(manuallyOrdered, pinnedThreadIds, (thread) => thread.id)
}

export function threadsOlderThan(threads: Thread[], cutoff: number): Thread[] {
  return threads.filter((thread) => (thread.recencyAt ?? thread.updatedAt) < cutoff)
}

export function sortWorkspacesByRecentThread(
  workspaces: Workspace[],
  threads: Thread[],
  threadRoots: Record<string, string | null>,
): Workspace[] {
  const workspaceRoots = new Set(workspaces.map((workspace) => workspace.root))
  const latestByRoot = new Map<string, number>()
  const stableIndex = new Map(workspaces.map((workspace, index) => [workspace.root, index]))

  for (const thread of threads) {
    const root = threadRoots[thread.id]
    if (!root || !workspaceRoots.has(root)) continue
    const recency = thread.recencyAt ?? thread.updatedAt
    if (recency > (latestByRoot.get(root) ?? Number.NEGATIVE_INFINITY)) latestByRoot.set(root, recency)
  }

  return [...workspaces].sort((left, right) => {
    const leftRecency = latestByRoot.get(left.root) ?? Number.NEGATIVE_INFINITY
    const rightRecency = latestByRoot.get(right.root) ?? Number.NEGATIVE_INFINITY
    if (leftRecency !== rightRecency) return rightRecency - leftRecency
    return (stableIndex.get(left.root) ?? 0) - (stableIndex.get(right.root) ?? 0)
  })
}

export function sortWorkspaces(
  workspaces: Workspace[],
  sort: WorkspaceSort,
  threads: Thread[],
  threadRoots: Record<string, string | null>,
  pinnedWorkspaceRoots: string[] = [],
): Workspace[] {
  const ordered = sort === 'recent'
    ? sortWorkspacesByRecentThread(workspaces, threads, threadRoots)
    : [...workspaces]
  return prioritizePinned(ordered, pinnedWorkspaceRoots, (workspace) => workspace.root)
}

function prioritizePinned<T>(items: T[], pinnedKeys: string[], keyFor: (item: T) => string): T[] {
  const pinned = new Set(pinnedKeys)
  if (pinned.size === 0) return items
  return [
    ...items.filter((item) => pinned.has(keyFor(item))),
    ...items.filter((item) => !pinned.has(keyFor(item))),
  ]
}
