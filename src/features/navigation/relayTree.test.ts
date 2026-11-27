import { describe, expect, it } from 'vitest'
import type { Thread } from '../../core/domain/codex'
import { relayNeighbors, relayTree, withRelayChildren } from './relayTree'

const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id, name: id, preview: '', cwd: '/repo', createdAt: 1, updatedAt: 1, recencyAt: 1,
  status: { type: 'idle' }, ephemeral: false, canAcceptDirectInput: false, ...extra,
})

describe('relay tree', () => {
  it('nests children under a listed parent and keeps orphans at the top level', () => {
    const threads = [
      thread('child-a', { harnessRelayParent: 'relay' }),
      thread('plain'),
      thread('relay', { harnessRelay: true }),
      thread('child-b', { harnessRelayParent: 'relay', cwd: '/other' }),
      thread('orphan', { harnessRelayParent: 'archived-relay' }),
    ]
    const tree = relayTree(threads)
    expect(tree.roots.map((t) => t.id)).toEqual(['plain', 'relay', 'orphan'])
    expect(tree.childrenOf.get('relay')?.map((t) => t.id)).toEqual(['child-a', 'child-b'])
    expect(withRelayChildren(['plain', 'relay', 'orphan'], tree.childrenOf)).toEqual(['plain', 'relay', 'child-a', 'child-b', 'orphan'])
  })

  it('finds children of the relay and the parent of a child', () => {
    const relay = thread('relay', { harnessRelay: true })
    const child = thread('child', { harnessRelayParent: 'relay' })
    const threads = [relay, child, thread('plain')]
    expect(relayNeighbors(relay, threads)).toEqual({ parent: null, children: [child] })
    expect(relayNeighbors(child, threads)).toEqual({ parent: relay, children: [] })
    expect(relayNeighbors(thread('plain'), threads)).toEqual({ parent: null, children: [] })
    expect(relayNeighbors(null, threads)).toEqual({ parent: null, children: [] })
  })
})
