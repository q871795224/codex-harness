export type ReleaseRunPhase =
  | 'starting'
  | 'preparing-worktree'
  | 'preparing'
  | 'checking'
  | 'submitting'
  | 'publishing'
  | 'completed'

export interface ReleaseRunStatus {
  runId: string
  workspaceRoot: string
  version: string
  status: 'running' | 'succeeded' | 'failed'
  phase: ReleaseRunPhase
  error: string | null
  pid: number
  startedAt: number
  updatedAt: number
  completedAt: number | null
  dismissed: boolean
  logPath?: string
}

export interface ReleaseCommandInfo {
  supported: boolean
  currentVersion: string | null
  versions: string[]
  status: ReleaseRunStatus | null
}

export interface WorkspaceReleaseController extends ReleaseCommandInfo {
  loading: boolean
  refresh(): Promise<void>
  start(version: string): Promise<void>
  dismissFailure(): Promise<void>
  openLog(): Promise<void>
}

export const RELEASE_PHASE_LABELS: Record<ReleaseRunPhase, string> = {
  starting: '正在启动',
  'preparing-worktree': '准备隔离工作区',
  preparing: '更新版本',
  checking: '运行检查',
  submitting: '提交并合并 PR',
  publishing: '构建并发布',
  completed: '发布完成',
}
