export type AsyncWaitTarget =
  | { type: 'custom' }
  | { type: 'sleep'; wakeAt: number }
  | { type: 'gitlabCi'; project: string; pipeline: number; sha: string }
  | { type: 'githubCi'; repo: string; pr: number; sha: string }
  | { type: 'sdp'; service: string; environment: string; callback: string; sha: string; tasks: string[] }
  | { type: 'seatalk'; reference: string; after: string; excludeSender: string }
export interface CreateAsyncWait {
  id: string
  threadId: string
  title: string
  continuation: string
  condition?: string
  checkerPath?: string
  target?: AsyncWaitTarget
}
export interface AsyncWaitTask {
  id: string
  threadId: string
  title: string
  continuation: string
  condition?: string
  cwd: string
  status: 'awaitingApproval' | 'notified' | 'waiting' | 'ready' | 'paused' | 'expired' | 'dispatching' | 'uncertain' | 'delivered' | 'cancelled' | 'closed'
  target?: AsyncWaitTarget
  approved?: boolean
  checkerSource?: string | null
  draftStaged?: boolean
  revision: number
  createdAt: number
  updatedAt: number
  deadline: number
  nextCheckAt: number
  lastCheckedAt: number | null
  failures: number
  summary: string
  lastObservation: string | null
  deliveryFailures: number
  nextDeliveryAt: number
  turnId: string | null
  deliveryId: string | null
}
export type AsyncWaitAction = 'check' | 'pause' | 'resume' | 'cancel' | 'acknowledge'
export interface AsyncWaitSnapshot { data: AsyncWaitTask[]; schedulerError: string | null }
