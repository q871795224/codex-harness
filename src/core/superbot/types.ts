import type { Thread } from '../domain/codex'

export const SUPERBOT_PREFIX = 'superbot:'
export interface SuperbotRunConfig { reset?: boolean; model?: string | null; thinking_level?: string | null }
export interface SuperbotSession {
  seatalk_kind?: 'root' | 'thread' | null; seatalk_following?: boolean | null; parent_session_id?: string | null
  id: string; title: string; status: string; read_only: boolean; runtime_id: string | null
  run_config: SuperbotRunConfig | null; created_at: string; updated_at: string
}
export interface SuperbotModel {
  id: string; label: string; default?: boolean
  thinking?: { supported_levels: { value: string; label: string }[]; default_level?: string }
}
export interface SuperbotMessage {
  id: string; role: string; content: string; task_id?: string | null; task_status?: string
  created_at: string; failure_reason?: string | null
}
export interface SuperbotCursor { created_at: string; id: string }
export interface SuperbotTaskEvent {
  seq: number; call_id?: string; type: string; tool?: string; content?: string; text?: string
  input?: unknown; output?: unknown; result?: unknown
}
export interface SuperbotSnapshot {
  session: SuperbotSession
  page: { messages: SuperbotMessage[]; has_more: boolean; next_cursor: SuperbotCursor | null }
  pending: { task_id?: string; status?: string }
  events: SuperbotTaskEvent[]
}
export type SuperbotRequest =
  | { type: 'list'; archived: boolean }
  | { type: 'catalog' }
  | { type: 'create' }
  | { type: 'read'; id: string; before_created_at?: string; before_id?: string }
  | { type: 'send'; id: string; content: string; run_config: SuperbotRunConfig }
  | { type: 'stop'; id: string; task_id: string }
  | { type: 'rename'; id: string; title: string }
  | { type: 'archive'; id: string; archived: boolean }

export function superbotId(id: string): string { return SUPERBOT_PREFIX + id }
export function remoteSuperbotId(id: string): string {
  if (!id.startsWith(SUPERBOT_PREFIX)) throw new Error('无效的 Superbot 会话')
  return id.slice(SUPERBOT_PREFIX.length)
}
export function superbotThread(session: SuperbotSession, taskId?: string): Thread {
  return {
    id: superbotId(session.id), provider: 'superbot', channelSource: session.seatalk_kind ? 'seatalk' : undefined, name: session.title, preview: '', cwd: '',
    createdAt: Date.parse(session.created_at) / 1000, updatedAt: Date.parse(session.updated_at) / 1000,
    recencyAt: Date.parse(session.updated_at) / 1000,
    status: taskId ? { type: 'active', activeFlags: [] } : { type: 'idle' },
    ephemeral: false, canAcceptDirectInput: !session.read_only && session.status !== 'archived',
  }
}
export function mergeSuperbotMessages(previous: SuperbotMessage[], incoming: SuperbotMessage[]): SuperbotMessage[] {
  const rows = new Map(previous.map(message => [message.id, message]))
  for (const message of incoming) rows.set(message.id, message)
  return [...rows.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
}
