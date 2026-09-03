import { describe, expect, it } from 'vitest'
import type { Thread } from '../../core/domain/codex'
import { visibleThreadOrder, visibleThreads } from './visibleThreads'

const thread = (id: string, recencyAt: number): Thread => ({ id, recencyAt, updatedAt: recencyAt } as Thread)

describe('visible sidebar threads', () => {
  it('uses the exact rendered prefix and respects show more', () => {
    const threads = Array.from({ length: 8 }, (_, index) => thread(`thread-${index + 1}`, 1))
    expect(visibleThreads(threads, undefined, 1_000_000).map(({ id }) => id)).toEqual(['thread-1', 'thread-2', 'thread-3', 'thread-4', 'thread-5'])
    expect(visibleThreads(threads, 6, 1_000_000).map(({ id }) => id)).toHaveLength(6)
  })

  it('flattens only expanded workspace groups in their rendered order', () => {
    const first = thread('first', 1)
    const hidden = thread('hidden', 1)
    const loose = thread('loose', 1)
    expect(visibleThreadOrder({
      layout: 'workspace', orderedThreads: [first, hidden, loose], orderedWorkspaceRoots: ['/a', '/b'],
      groupedByRoot: new Map([['/a', [first]], ['/b', [hidden]]]), unsorted: [loose],
      expanded: { '/b': false }, visibleCounts: {}, pinnedThreadIds: [],
    })).toEqual(['first', 'loose'])
  })

  it('always shows every pinned thread even when pinned exceed the default count', () => {
    const threads = Array.from({ length: 7 }, (_, index) => thread(`thread-${index + 1}`, 1))
    const pinnedThreadIds = ['thread-2', 'thread-3', 'thread-4', 'thread-5', 'thread-6', 'thread-7']
    const shown = visibleThreads(threads, undefined, 1_000_000, pinnedThreadIds)
    expect(shown).toHaveLength(6)
    expect(shown.map(({ id }) => id)).toEqual(['thread-2', 'thread-3', 'thread-4', 'thread-5', 'thread-6', 'thread-7'])
  })

  it('counts pinned threads toward the five-session default', () => {
    const threads = Array.from({ length: 8 }, (_, index) => thread(`thread-${index + 1}`, 1))
    expect(visibleThreads(threads, undefined, 1_000_000, ['thread-8']).map(({ id }) => id)).toEqual([
      'thread-8', 'thread-1', 'thread-2', 'thread-3', 'thread-4',
    ])
    expect(visibleThreads(threads, undefined, 1_000_000, [])).toHaveLength(5)
  })

  it('only counts threads pinned within the list itself', () => {
    const threads = Array.from({ length: 6 }, (_, index) => thread(`thread-${index + 1}`, 1))
    // pinned ids that are not in this list must not inflate the count
    expect(visibleThreads(threads, undefined, 1_000_000, ['other-a', 'other-b', 'other-c', 'other-d'])).toHaveLength(5)
  })

  it('shows all pinned threads and fills extra slots after five pinned threads', () => {
    const threads = Array.from({ length: 8 }, (_, index) => thread(`thread-${index + 1}`, 1))
    const pinnedThreadIds = ['thread-1', 'thread-2', 'thread-3', 'thread-4', 'thread-5', 'thread-6']

    expect(visibleThreads(threads, undefined, 1_000_000, pinnedThreadIds).map(({ id }) => id)).toEqual([
      'thread-1', 'thread-2', 'thread-3', 'thread-4', 'thread-5', 'thread-6',
    ])
    expect(visibleThreads(threads, 8, 1_000_000, pinnedThreadIds).map(({ id }) => id)).toEqual([
      'thread-1', 'thread-2', 'thread-3', 'thread-4', 'thread-5', 'thread-6', 'thread-7', 'thread-8',
    ])
  })
})
