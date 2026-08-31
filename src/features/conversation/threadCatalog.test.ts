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
      useStateDbOnly: true,
      searchTerm: 'delivery',
    })
  })

  it('reads every active page until the cursor is exhausted', async () => {
    const client = transport()
    vi.mocked(client.listThreads)
      .mockResolvedValueOnce({ data: [thread('thread-1', 10)], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ data: [thread('thread-2', 9)], nextCursor: null })

    await expect(listAllActiveThreads(client)).resolves.toEqual([thread('thread-1', 10), thread('thread-2', 9)])
    expect(client.listThreads).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: null, archived: false }))
    expect(client.listThreads).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'page-2', archived: false }))
  })
})

describe('old thread archiving', () => {
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
