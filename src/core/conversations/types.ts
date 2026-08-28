import type { Turn } from '../domain/codex'

export interface TurnCompletedEvent {
  threadId: string
  turnId: string
  title: string
  status: Turn['status']
}

export interface ConversationService {
  onTurnCompleted(listener: (event: TurnCompletedEvent) => void): () => void
  openThread(threadId: string): Promise<void>
}
