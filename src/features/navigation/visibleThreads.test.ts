import { describe, expect, it } from 'vitest'
import type { Thread } from '../../core/domain/codex'
import { visibleThreadOrder, visibleThreads } from './visibleThreads'

const thread = (id: string, recencyAt: number): Thread => ({ id, recencyAt, updatedAt: recencyAt } as Thread)

describe('visible sidebar threads', () => {
  it('uses the exact rendered prefix and respects show more', () => {
    const threads = Array.from({ length: 8 }, (_, index) => thread(`thread-${index + 1}`, 1))
    expect(visibleThreads(threads, undefined, 1_000_000).map(({ id }) => id)).toEqual(['thread-1', 'thread-2', 'thread-3'])
    expect(visibleThreads(threads, 6, 1_000_000).map(({ id }) => id)).toHaveLength(6)
  })

  it('flattens only expanded workspace groups in their rendered order', () => {
    const first = thread('first', 1)
    const hidden = thread('hidden', 1)
    const loose = thread('loose', 1)
    expect(visibleThreadOrder({
      layout: 'workspace', orderedThreads: [first, hidden, loose], orderedWorkspaceRoots: ['/a', '/b'],
      groupedByRoot: new Map([['/a', [first]], ['/b', [hidden]]]), unsorted: [loose],
      expanded: { '/b': false }, visibleCounts: {},
    })).toEqual(['first', 'loose'])
  })
})
