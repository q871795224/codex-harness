import { describe, expect, it, vi } from 'vitest'
import type { Thread } from '../../core/domain/codex'
import {
  archiveThreadsBefore,
  listAllActiveThreads,
  listThreadPage,
  type ThreadCatalogTransport,
} from './threadCatalog'

function thread(id: string, recencyAt: number): Thread {
  return {
    id, recencyAt, cwd: '/repo', name: null, preview: '', ephemeral: false,
    createdAt: recencyAt, updatedAt: recencyAt, status: { type: 'idle' }, canAcceptDirectInput: true,
  }
}

function transport(): ThreadCatalogTransport {
  return {
    listThreads: vi.fn(),
    archiveThread: vi.fn().mockResolvedValue(undefined),
  }
}

describe('thread catalog listing', () => {
  it('uses the state DB and trims search terms for visible pages', async () => {
    const client = transport()
    vi.mocked(client.listThreads).mockResolvedValue({ data: [], nextCursor: null })

    await listThreadPage(client, 'archived', '  delivery  ')

    expect(client.listThreads).toHaveBeenCalledWith({
      limit: 100,
      sortKey: 'recency_at',
      sortDirection: 'desc',
      archived: true,
      modelProviders: [],
      useStateDbOnly: true,
      searchTerm: 'delivery',
    })
  })

  it.each(['active', 'archived'] as const)('keeps %s history visible after the configured provider changes', async (mode) => {
    const client = transport()
    const history = [
      { ...thread('recent-openai', 200), modelProvider: 'openai' },
      { ...thread('old-custom', 10), modelProvider: 'custom' },
    ]
    vi.mocked(client.listThreads).mockImplementation(async (params) => {
      // App Server defaults to the configured provider when this field is omitted.
      const providers = (params.modelProviders as string[] | undefined) ?? ['custom']
      return {
        data: history.filter((item) => providers.length === 0 || providers.includes(item.modelProvider)),
        nextCursor: null,
      }
    })

    await expect(listThreadPage(client, mode)).resolves.toEqual({ data: history, nextCursor: null })
  })

  it('reads every active page until the cursor is exhausted', async () => {
    const client = transport()
    vi.mocked(client.listThreads)
      .mockResolvedValueOnce({ data: [thread('thread-1', 10)], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ data: [thread('thread-2', 9)], nextCursor: null })

    await expect(listAllActiveThreads(client)).resolves.toEqual([thread('thread-1', 10), thread('thread-2', 9)])
    expect(client.listThreads).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: null, archived: false, modelProviders: [] }))
    expect(client.listThreads).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'page-2', archived: false, modelProviders: [] }))
  })
})

describe('old thread archiving', () => {
  it('preserves pinned old threads across pages and excludes them from counts', async () => {
    const client = transport()
    vi.mocked(client.listThreads)
      .mockResolvedValueOnce({ data: [thread('pinned-1', 10), thread('old', 20)], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ data: [thread('pinned-2', 30), thread('recent', 200)], nextCursor: null })

    await expect(archiveThreadsBefore(client, 100, ['pinned-1', 'pinned-2'])).resolves.toEqual({
      candidateCount: 1, archivedIds: ['old'], failedCount: 0,
    })
    expect(client.archiveThread).toHaveBeenCalledExactlyOnceWith('old')
  })

  it('does not archive when all old threads are pinned', async () => {
    const client = transport()
    vi.mocked(client.listThreads).mockResolvedValue({ data: [thread('pinned', 10)], nextCursor: null })
    await expect(archiveThreadsBefore(client, 100, ['pinned'])).resolves.toEqual({
      candidateCount: 0, archivedIds: [], failedCount: 0,
    })
    expect(client.archiveThread).not.toHaveBeenCalled()
  })

  it('returns successful and failed IDs without aborting the batch', async () => {
    const client = transport()
    vi.mocked(client.listThreads).mockResolvedValue({
      data: [thread('old-1', 10), thread('old-2', 20), thread('recent', 200)],
      nextCursor: null,
    })
    vi.mocked(client.archiveThread).mockImplementation(async (threadId) => {
      if (threadId === 'old-2') throw new Error('archive failed')
    })

    await expect(archiveThreadsBefore(client, 100)).resolves.toEqual({
      candidateCount: 2,
      archivedIds: ['old-1'],
      failedCount: 1,
    })
    expect(client.archiveThread).toHaveBeenCalledTimes(2)
  })

  it('does not issue archive calls when no thread is old enough', async () => {
    const client = transport()
    vi.mocked(client.listThreads).mockResolvedValue({ data: [thread('recent', 200)], nextCursor: null })

    await expect(archiveThreadsBefore(client, 100)).resolves.toEqual({
      candidateCount: 0, archivedIds: [], failedCount: 0,
    })
    expect(client.archiveThread).not.toHaveBeenCalled()
  })
})
