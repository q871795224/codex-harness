import type { CodexModel, FollowUpMode, FontSizePreferences, KeyboardPreferences, MessageReference, PendingSteer, QueuedSubmission, Theme, ThreadCodexSettings, ThreadDetail, ThreadTokenUsage, UserInput } from '../domain/codex'
import type { AssistantSession, SessionRequest } from '../../features/assistant/sessionAssistant'

export type AssistantMutation = 'archive' | 'pin' | 'unpin'
export interface DesktopAssistantSnapshot {
  sequence: number
  disabled: boolean
  theme: Theme
  fontSizes: FontSizePreferences
  threadId: string | null
  detail?: ThreadDetail
  submitting: boolean
  busy: Record<string, boolean>
  working: boolean
  queue: QueuedSubmission[]
  pendingSteers: PendingSteer[]
  usage: ThreadTokenUsage | null
  keyboard: KeyboardPreferences
  pinned: string[]
  models: CodexModel[]
  loading: boolean
  settings: ThreadCodexSettings
}

export interface DesktopAssistantOperations {
  state: { args: null; result: DesktopAssistantSnapshot }
  create: { args: null; result: string }
  send: { args: { threadId: string; input: UserInput[]; mode: 'interject' | 'queue'; references?: MessageReference[] }; result: void }
  stop: { args: { threadId: string }; result: void }
  removeQueue: { args: { threadId: string; queueId: string }; result: void }
  promoteQueue: { args: { threadId: string; queueId: string }; result: void }
  startQueue: { args: { threadId: string }; result: void }
  settings: { args: { threadId: string; model?: string; effort?: string }; result: void }
  followUp: { args: { mode: FollowUpMode }; result: void }
  query: { args: SessionRequest; result: { rows: AssistantSession[]; unavailable: Array<AssistantSession['provider']> } }
  mutate: { args: { id: string; action: AssistantMutation }; result: void }
}

export type DesktopAssistantRequest = {
  [Action in keyof DesktopAssistantOperations]: { id: string; action: Action; args: DesktopAssistantOperations[Action]['args'] }
}[keyof DesktopAssistantOperations]
