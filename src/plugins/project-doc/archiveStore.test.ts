import { describe, expect, it } from 'vitest'
import { createArchiveStore } from './archiveStore'
import type { ArchiveDraft } from './config'

const draft: ArchiveDraft = {
  projectId: 'demo',
  threadId: 'thread-1',
  statusDraft: '新 Status',
  baseStatus: '旧 Status',
  baseSeq: 2,
  createdAt: 1,
}

describe('archiveStore selectRequest', () => {
  it('exposes selectRequest as null by default', () => {
    const store = createArchiveStore()
    expect(store.getState().selectRequest).toBeNull()
  })

  it('requestSelect sets a selectRequest without touching openRequest or notices', () => {
    const store = createArchiveStore()
    store.setPending('demo', 'thread-1', draft)
    const before = store.getState()

    store.requestSelect('demo')

    const after = store.getState()
    expect(after.selectRequest).toEqual({ projectId: 'demo' })
    expect(after.openRequest).toBe(before.openRequest)
    expect(after.notices).toBe(before.notices)
  })

  it('clearSelect empties selectRequest and is idempotent', () => {
    const store = createArchiveStore()
    store.requestSelect('demo')
    expect(store.getState().selectRequest).not.toBeNull()

    store.clearSelect()
    expect(store.getState().selectRequest).toBeNull()
    store.clearSelect()
    expect(store.getState().selectRequest).toBeNull()
  })

  it('notifies subscribers on requestSelect and clearSelect', () => {
    const store = createArchiveStore()
    let calls = 0
    const unsubscribe = store.subscribe(() => { calls += 1 })

    store.requestSelect('demo')
    expect(calls).toBe(1)
    store.clearSelect()
    expect(calls).toBe(2)
    unsubscribe()
  })
})
