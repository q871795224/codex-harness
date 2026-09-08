import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ComposerDraft } from './Composer'
import { ComposerDraftWriter, restoreComposerDrafts, storedComposerDraft } from './composerDraftStorage'

const draft = (text = '保留这段内容'): ComposerDraft => ({
  text,
  collapsedPastes: [{ start: 0, end: 4, content: '完整粘贴内容', label: '[Pasted text]' }],
  attachments: [{ path: '/tmp/image.png', name: 'image.png', kind: 'image' }],
})

describe('composer draft persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('restores valid versioned drafts and ignores malformed records', () => {
    expect(restoreComposerDrafts([
      { conversationId: 'thread-1', draft: storedComposerDraft(draft()), updatedAt: 1 },
      { conversationId: 'thread-2', draft: { version: 2, text: 'old' }, updatedAt: 2 },
    ])).toEqual({ 'thread-1': draft() })
  })

  it('serializes updates and deletes an empty draft', async () => {
    const storage = {
      listComposerDrafts: vi.fn().mockResolvedValue([]),
      upsertComposerDraft: vi.fn().mockResolvedValue(undefined),
      deleteComposerDraft: vi.fn().mockResolvedValue(undefined),
    }
    const writer = new ComposerDraftWriter(storage)
    writer.update('thread-1', draft())
    writer.update('thread-2', { text: '', collapsedPastes: [], attachments: [] })
    await writer.flush()

    expect(storage.upsertComposerDraft).toHaveBeenCalledWith('thread-1', storedComposerDraft(draft()))
    expect(storage.deleteComposerDraft).toHaveBeenCalledWith('thread-2')
  })

  it('coalesces a newer value queued while a write is active', async () => {
    let releaseFirstWrite!: () => void
    const storage = {
      listComposerDrafts: vi.fn().mockResolvedValue([]),
      upsertComposerDraft: vi.fn()
        .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirstWrite = resolve }))
        .mockResolvedValue(undefined),
      deleteComposerDraft: vi.fn().mockResolvedValue(undefined),
    }
    const writer = new ComposerDraftWriter(storage, () => {}, 0) // 无防抖
    writer.update('thread-1', draft('first'))
    await vi.waitFor(() => expect(storage.upsertComposerDraft).toHaveBeenCalledTimes(1))
    writer.update('thread-1', draft('latest'))
    releaseFirstWrite()
    await writer.flush()

    expect(storage.upsertComposerDraft).toHaveBeenLastCalledWith('thread-1', storedComposerDraft(draft('latest')))
  })

  it('debounces writes and persists after timeout', async () => {
    const storage = {
      listComposerDrafts: vi.fn().mockResolvedValue([]),
      upsertComposerDraft: vi.fn().mockResolvedValue(undefined),
      deleteComposerDraft: vi.fn().mockResolvedValue(undefined),
    }
    const writer = new ComposerDraftWriter(storage, () => {}, 1000)
    writer.update('thread-1', draft('first'))

    // 防抖期间不应写入
    expect(storage.upsertComposerDraft).not.toHaveBeenCalled()

    // 快进 1 秒
    await vi.advanceTimersByTimeAsync(1000)
    expect(storage.upsertComposerDraft).toHaveBeenCalledWith('thread-1', storedComposerDraft(draft('first')))
  })

  it('flush clears pending debounce and writes immediately', async () => {
    const storage = {
      listComposerDrafts: vi.fn().mockResolvedValue([]),
      upsertComposerDraft: vi.fn().mockResolvedValue(undefined),
      deleteComposerDraft: vi.fn().mockResolvedValue(undefined),
    }
    const writer = new ComposerDraftWriter(storage, () => {}, 1000)
    writer.update('thread-1', draft('immediate'))
    await writer.flush()

    expect(storage.upsertComposerDraft).toHaveBeenCalledWith('thread-1', storedComposerDraft(draft('immediate')))
    // flush 后不应再有定时器触发
    await vi.advanceTimersByTimeAsync(2000)
    expect(storage.upsertComposerDraft).toHaveBeenCalledTimes(1)
  })
})
