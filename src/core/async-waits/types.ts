export interface CreateAsyncWait {
  id: string
  threadId: string
  title: string
  continuation: string
  checkerPath: string
}
export interface AsyncWaitTask {
  id: string
  threadId: string
  title: string
  continuation: string
  cwd: string
  status: 'waiting' | 'ready' | 'paused' | 'expired' | 'dispatching' | 'uncertain' | 'delivered' | 'cancelled' | 'closed'
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
