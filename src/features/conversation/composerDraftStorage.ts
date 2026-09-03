import type { PersistedComposerDraftRecord } from '../../core/runtime/bridge'
import type { ComposerDraft } from './Composer'

const DRAFT_VERSION = 1

export interface ComposerDraftStorage {
  listComposerDrafts(): Promise<PersistedComposerDraftRecord[]>
  upsertComposerDraft(conversationId: string, draft: unknown): Promise<void>
  deleteComposerDraft(conversationId: string): Promise<void>
}

interface StoredComposerDraft extends ComposerDraft {
  version: typeof DRAFT_VERSION
}

export function restoreComposerDrafts(records: PersistedComposerDraftRecord[]): Record<string, ComposerDraft> {
  return Object.fromEntries(records.flatMap((record) => {
    const draft = parseComposerDraft(record.draft)
    return draft ? [[record.conversationId, draft]] : []
  }))
}

export function storedComposerDraft(draft: ComposerDraft): StoredComposerDraft {
  return { version: DRAFT_VERSION, ...draft }
}

export function composerDraftHasContent(draft: ComposerDraft): boolean {
  return Boolean(draft.text.trim() || draft.attachments.length)
}

export class ComposerDraftWriter {
  private readonly pending = new Map<string, ComposerDraft>()
  private draining: Promise<void> | null = null

  constructor(
    private readonly storage: ComposerDraftStorage,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  update(conversationId: string, draft: ComposerDraft): void {
    this.pending.set(conversationId, draft)
    this.draining ??= this.drain()
  }

  async flush(): Promise<void> {
    while (this.draining) await this.draining
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const batch = [...this.pending]
        this.pending.clear()
        for (const [conversationId, draft] of batch) {
          try {
            if (composerDraftHasContent(draft)) {
              await this.storage.upsertComposerDraft(conversationId, storedComposerDraft(draft))
            } else {
              await this.storage.deleteComposerDraft(conversationId)
            }
          } catch (error) {
            this.onError(error)
          }
        }
      }
    } finally {
      this.draining = null
      if (this.pending.size > 0) this.draining = this.drain()
    }
  }
}

function parseComposerDraft(value: unknown): ComposerDraft | null {
  if (!isRecord(value) || value.version !== DRAFT_VERSION || typeof value.text !== 'string') return null
  if (!Array.isArray(value.collapsedPastes) || !Array.isArray(value.attachments)) return null
  const collapsedPastes = value.collapsedPastes.filter((item): item is ComposerDraft['collapsedPastes'][number] => (
    isRecord(item)
    && Number.isSafeInteger(item.start)
    && Number.isSafeInteger(item.end)
    && typeof item.content === 'string'
    && typeof item.label === 'string'
  ))
  const attachments = value.attachments.filter((item): item is ComposerDraft['attachments'][number] => (
    isRecord(item)
    && typeof item.path === 'string'
    && typeof item.name === 'string'
    && (item.kind === 'image' || item.kind === 'file' || item.kind === 'skill')
  ))
  return { text: value.text, collapsedPastes, attachments }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
