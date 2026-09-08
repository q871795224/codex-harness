import { describe, expect, it, vi } from 'vitest'
import { createNotificationStore, type AppNotification } from './store'

const input = { source: '测试', title: '操作未完成', level: 'error' as const, details: 'RAW_ERROR\nline 2' }
function storage(initial: string | null = null) {
  let value = initial
  return { load: vi.fn(async () => value), save: vi.fn(async (next: string) => { value = next }) }
}

describe('notification history', () => {
  it('retains every notification and its raw details after dismissing, reading and restarting', async () => {
    const disk = storage()
    const store = createNotificationStore(disk)
    await store.initialize()
    const ids = Array.from({ length: 7 }, (_, index) => store.publish({ ...input, title: `操作 ${index}`, createdAt: 1 }))
    ids.forEach(store.dismiss)
    store.markRead(ids[0])
    await store.flushed()
    const restored = createNotificationStore(disk)
    await restored.initialize()
    expect(restored.snapshot().floating).toEqual([])
    expect(restored.snapshot().records).toHaveLength(7)
    expect(restored.snapshot().records.find((item) => item.id === ids[0])).toMatchObject({ read: true, details: 'RAW_ERROR\nline 2', createdAt: 1 })
  })

  it('merges notifications arriving during startup with saved history', async () => {
    const old: AppNotification = { ...input, id: 'old', createdAt: 1, updatedAt: 1, read: true }
    let resolve!: (value: string) => void
    const disk = { load: () => new Promise<string>((done) => { resolve = done }), save: vi.fn(async (_value: string) => undefined) }
    const store = createNotificationStore(disk)
    const loading = store.initialize()
    store.publish({ ...input, id: 'new' })
    expect(disk.save).not.toHaveBeenCalled()
    resolve(JSON.stringify([old]))
    await loading
    await store.flushed()
    expect(store.snapshot().records.map((record) => record.id)).toEqual(['new', 'old'])
    expect(JSON.parse(disk.save.mock.calls[0][0] as string)).toHaveLength(2)
  })

  it('updates a task once per meaningful change without reopening identical dismissed notifications', async () => {
    const store = createNotificationStore(storage())
    await store.initialize()
    store.publish({ ...input, id: 'run' })
    store.dismiss('run')
    store.markRead('run')
    store.publish({ ...input, id: 'run' })
    expect(store.snapshot().floating).toEqual([])
    expect(store.snapshot().records[0].read).toBe(true)
    store.publish({ ...input, id: 'run', title: '完成', level: 'info' })
    expect(store.snapshot().records).toHaveLength(1)
    expect(store.snapshot().floating).toHaveLength(1)
    expect(store.snapshot().records[0]).toMatchObject({ read: false, level: 'info' })
  })

  it('does not replace unreadable history and retries without losing new events', async () => {
    const disk = storage()
    disk.load.mockRejectedValueOnce(new Error('database locked'))
    const store = createNotificationStore(disk)
    await store.initialize()
    store.publish(input)
    expect(disk.save).not.toHaveBeenCalled()
    expect(store.snapshot().storageError).toContain('database locked')
    await store.retryStorage()
    expect(store.snapshot().loaded).toBe(true)
    expect(store.snapshot().storageError).toBeNull()
    expect(store.snapshot().records).toHaveLength(1)
  })

  it('serializes disk writes and recovers after a failed write', async () => {
    const disk = storage()
    const store = createNotificationStore(disk)
    await store.initialize()
    await store.flushed()
    disk.save.mockRejectedValueOnce(new Error('disk full'))
    store.publish({ ...input, id: 'a' })
    await store.flushed()
    expect(store.snapshot().storageError).toContain('disk full')
    store.publish({ ...input, id: 'b' })
    await store.flushed()
    expect(store.snapshot().storageError).toBeNull()
    expect(JSON.parse((await disk.load())!)).toHaveLength(2)
  })
})
