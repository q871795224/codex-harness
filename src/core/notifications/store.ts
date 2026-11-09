export type NotificationLevel = 'info' | 'warning' | 'error'
export type NotificationAttention = 'action' | 'result' | 'follow-up'
export interface NotificationAction {
  label: string
  kind: 'thread' | 'release-log' | 'project' | 'codex-provider-restore'
  target: string
  runId?: string
}
export interface NotificationInput {
  /** Keep history without floating alerts or attention badges. */
  silent?: boolean
  id?: string
  level: NotificationLevel
  title: string
  message?: string
  details?: string
  source: string
  state?: 'running' | 'pending' | 'done'
  threadId?: string | null
  workspaceRoot?: string | null
  actions?: NotificationAction[]
  createdAt?: number
  updatedAt?: number
  attention?: NotificationAttention
  /** Stable source revision, not message/response content. */
  eventKey?: string
}
export interface AppNotification extends NotificationInput {
  id: string
  createdAt: number
  updatedAt: number
  read: boolean
  remindAt?: number | null
  resolved?: boolean
  watchThread?: boolean
  watchSince?: number
}
export interface NotificationService {
  publish(input: NotificationInput): string
}
interface Snapshot {
  records: AppNotification[]
  floating: { id: string; expiresAt: number | null }[]
  loaded: boolean
  storageError: string | null
}
interface Storage {
  load(): Promise<string | null>
  save(value: string): Promise<void>
}
export const notificationAttention = (record: NotificationInput): NotificationAttention => record.attention ?? (record.state === 'pending' ? 'action' : 'result')
export function needsAttention(record: AppNotification, now = Date.now()): boolean {
  if (record.silent || record.resolved || (record.remindAt && record.remindAt > now) || record.state === 'running') return false
  return (notificationAttention(record) === 'action' && record.state === 'pending') || !record.read
}
export interface NotificationGroup { key: string; record: AppNotification; records: AppNotification[] }
export function attentionGroups(records: AppNotification[], now = Date.now()): NotificationGroup[] {
  const groups = new Map<string, AppNotification[]>()
  for (const record of records.filter((item) => needsAttention(item, now))) {
    const key = record.threadId ? `thread:${record.threadId}` : record.id
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  const rank = (record: AppNotification) => notificationAttention(record) === 'action' ? 0 : notificationAttention(record) === 'follow-up' ? 1 : 2
  return [...groups].map(([key, items]) => {
    const sorted = [...items].sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
    return { key, record: sorted[0], records: sorted }
  }).sort((a, b) => rank(a.record) - rank(b.record) || b.record.updatedAt - a.record.updatedAt)
}

export function createNotificationStore(storage: Storage) {
  let state: Snapshot = { records: [], floating: [], loaded: false, storageError: null }
  let focusedThread: string | null = null
  const listeners = new Set<() => void>()
  let loading: Promise<void> | null = null
  let writes = Promise.resolve()
  const emit = () => { for (const listener of listeners) listener() }
  const persist = () => {
    if (!state.loaded) return
    const value = JSON.stringify(state.records)
    writes = writes.then(() => storage.save(value)).then(() => {
      if (state.storageError) { state = { ...state, storageError: null }; emit() }
    }).catch((error) => {
      state = { ...state, storageError: String(error) }
      emit()
    })
  }
  const floating = (record: AppNotification, now: number) => record.silent || record.state === 'running' || Boolean(record.threadId && record.threadId === focusedThread)
    ? [] : [{ id: record.id, expiresAt: now + (record.level === 'info' ? 6000 : 10000) }]
  const mutate = (ids: string[], update: (record: AppNotification) => AppNotification) => {
    const keys = new Set(ids)
    state = { ...state, records: state.records.map((record) => keys.has(record.id) ? update(record) : record), floating: state.floating.filter((item) => !keys.has(item.id)) }
    emit(); persist()
  }
  const store = {
    snapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    initialize: (): Promise<void> => {
      if (loading) return loading
      if (state.loaded) return Promise.resolve()
      loading = storage.load().then((value) => {
        const records: AppNotification[] = value ? JSON.parse(value) : []
        if (!Array.isArray(records)) throw new Error('通知历史格式无效')
        const pending = new Map(state.records.map((record) => [record.id, record]))
        const active = new Set(state.floating.map((item) => item.id))
        for (const record of records) {
          const next = pending.get(record.id)
          if (!next || sameContent(record, next)) { pending.set(record.id, record); active.delete(record.id) }
        }
        state = { ...state, records: sortRecords([...pending.values()]), floating: state.floating.filter((item) => active.has(item.id)), loaded: true, storageError: null }
        store.tick(); store.setFocusedThread(focusedThread); emit(); persist()
      }).catch((error) => { state = { ...state, storageError: String(error) }; emit() }).finally(() => { loading = null })
      return loading
    },
    publish: (input: NotificationInput): string => {
      const id = input.id ?? crypto.randomUUID()
      const previous = state.records.find((record) => record.id === id)
      const now = Date.now()
      if (previous && input.updatedAt !== undefined && input.updatedAt < previous.updatedAt) return id
      if (previous && input.eventKey && input.eventKey === previous.eventKey) return id
      const record: AppNotification = { ...input, id, createdAt: previous?.createdAt ?? input.createdAt ?? now, updatedAt: input.updatedAt ?? now,
        read: input.silent === true || input.state === 'running' || Boolean(input.threadId && input.threadId === focusedThread), watchThread: previous?.watchThread, watchSince: previous?.watchSince,
      }
      if (previous && sameContent(previous, record)) return id
      state = { ...state, records: sortRecords([record, ...state.records.filter((item) => item.id !== id)]), floating: [...state.floating.filter((item) => item.id !== id), ...floating(record, now)] }
      emit(); persist(); return id
    },
    dismiss: (id: string) => { state = { ...state, floating: state.floating.filter((item) => item.id !== id) }; emit() },
    tick: (now = Date.now()) => {
      const due: AppNotification[] = []
      const records = state.records.map((record) => {
        if (!record.resolved && record.remindAt && record.remindAt <= now) {
          const next = { ...record, remindAt: null, state: record.state === 'running' && record.attention === 'follow-up' ? 'done' as const : record.state,
            read: Boolean(record.threadId && record.threadId === focusedThread), updatedAt: now }
          due.push(next); return next
        }
        return record
      })
      const ids = new Set(due.map((record) => record.id))
      const floats = state.floating.filter((item) => !ids.has(item.id) && (item.expiresAt === null || item.expiresAt > now))
      if (!due.length && floats.length === state.floating.length) return
      state = { ...state, records: due.length ? sortRecords(records) : state.records, floating: [...floats, ...due.flatMap((record) => floating(record, now))] }
      emit(); if (due.length) persist()
    },
    expire: () => store.tick(),
    markRead: (id?: string) => {
      // Read is deliberately independent from source-owned pending actions.
      const keys = state.records.filter((record) => !id || record.id === id).map((record) => record.id)
      mutate(keys, (record) => ({ ...record, read: true }))
    },
    resolve: (id: string) => {
      if (!state.records.some((record) => record.id === id && !record.resolved)) return
      mutate([id], (record) => ({ ...record, resolved: true, read: true, remindAt: null, state: 'done' }))
    },
    snooze: (ids: string[], at: number) => {
      if (!Number.isFinite(at) || at <= Date.now()) throw new Error('请选择未来的提醒时间')
      mutate(ids, (record) => ({ ...record, remindAt: at }))
    },
    remindThread: (thread: { id: string; title: string; cwd?: string }, at: number) => {
      if (!Number.isFinite(at) || at <= Date.now()) throw new Error('请选择未来的提醒时间')
      const id = `reminder:${thread.id}`
      const previous = state.records.find((record) => record.id === id)
      const now = Date.now()
      const record: AppNotification = { id, source: '会话提醒', title: thread.title, message: '到了约定的跟进时间。', level: 'info', attention: 'follow-up', threadId: thread.id, workspaceRoot: thread.cwd,
        createdAt: previous?.createdAt ?? now, updatedAt: now, read: true, remindAt: at, state: 'running' }
      state = { ...state, records: sortRecords([record, ...state.records.filter((item) => item.id !== id)]), floating: state.floating.filter((item) => item.id !== id) }
      emit(); persist(); return id
    },
    watchThread: (thread: { id: string; title: string; cwd?: string }, watching: boolean) => {
      const id = `watch:${thread.id}`
      if (!watching) {
        mutate([id], (record) => ({ ...record, watchThread: false, read: true, resolved: true, remindAt: null })); return
      }
      const now = Date.now()
      const record: AppNotification = { id, source: '会话关注', title: thread.title, message: '有新一轮结果时提醒。', level: 'info', attention: 'result', threadId: thread.id, workspaceRoot: thread.cwd,
        createdAt: now, updatedAt: now, read: true, watchThread: true, watchSince: now, state: 'running' }
      state = { ...state, records: sortRecords([record, ...state.records.filter((item) => item.id !== id)]), floating: state.floating.filter((item) => item.id !== id) }
      emit(); persist()
    },
    setFocusedThread: (threadId: string | null) => {
      focusedThread = threadId
      if (threadId && state.records.some((record) => record.threadId === threadId && !record.read && !record.remindAt)) {
        mutate(state.records.filter((record) => record.threadId === threadId && !record.remindAt).map((record) => record.id), (record) => ({ ...record, read: true }))
      }
    },
    retryStorage: async () => { if (!state.loaded) await store.initialize(); else persist(); await writes },
    flushed: () => writes,
  }
  return store
}
function sortRecords(records: AppNotification[]) { return records.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt) }
function sameContent(a: AppNotification, b: AppNotification) {
  return Boolean(a.silent) === Boolean(b.silent) && a.id === b.id && a.level === b.level && a.source === b.source && a.title === b.title
    && a.message === b.message && a.details === b.details && a.state === b.state && a.attention === b.attention && a.eventKey === b.eventKey
    && a.threadId === b.threadId && a.workspaceRoot === b.workspaceRoot && JSON.stringify(a.actions) === JSON.stringify(b.actions)
}
export type NotificationStore = ReturnType<typeof createNotificationStore>
export function errorDetails(error: unknown): string { return error instanceof Error ? error.stack || error.message : String(error) }
