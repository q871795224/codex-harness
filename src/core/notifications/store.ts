export type NotificationLevel = 'info' | 'warning' | 'error'
export interface NotificationAction {
  label: string
  kind: 'thread' | 'release-log' | 'project'
  target: string
  runId?: string
}
export interface NotificationInput {
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
}
export interface AppNotification extends NotificationInput {
  id: string
  createdAt: number
  updatedAt: number
  read: boolean
}
export interface NotificationService {
  publish(input: NotificationInput): string
}
interface Snapshot {
  records: AppNotification[]
  floating: { id: string; expiresAt: number }[]
  loaded: boolean
  storageError: string | null
}
interface Storage {
  load(): Promise<string | null>
  save(value: string): Promise<void>
}

export function createNotificationStore(storage: Storage) {
  let state: Snapshot = { records: [], floating: [], loaded: false, storageError: null }
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
        const floating = new Set(state.floating.map((item) => item.id))
        for (const record of records) {
          const next = pending.get(record.id)
          if (!next) pending.set(record.id, record)
          else if (sameContent(record, next)) {
            pending.set(record.id, record)
            floating.delete(record.id)
          }
        }
        state = { ...state, records: sortRecords([...pending.values()]), floating: state.floating.filter((item) => floating.has(item.id)), loaded: true, storageError: null }
        emit()
        persist()
      }).catch((error) => {
        state = { ...state, storageError: String(error) }
        emit()
      }).finally(() => { loading = null })
      return loading
    },
    publish: (input: NotificationInput): string => {
      const id = input.id ?? crypto.randomUUID()
      const previous = state.records.find((record) => record.id === id)
      const now = Date.now()
      if (previous && input.updatedAt !== undefined && input.updatedAt < previous.updatedAt) return id
      const record: AppNotification = { ...input, id, createdAt: previous?.createdAt ?? input.createdAt ?? now, updatedAt: input.updatedAt ?? now, read: false }
      if (previous && sameContent(previous, record)) return id
      state = {
        ...state,
        records: sortRecords([record, ...state.records.filter((item) => item.id !== id)]),
        floating: [...state.floating.filter((item) => item.id !== id), { id, expiresAt: now + (input.level === 'info' ? 5000 : 10000) }],
      }
      emit()
      persist()
      return id
    },
    dismiss: (id: string) => {
      state = { ...state, floating: state.floating.filter((item) => item.id !== id) }
      emit()
    },
    expire: () => {
      const floating = state.floating.filter((item) => item.expiresAt > Date.now())
      if (floating.length === state.floating.length) return
      state = { ...state, floating }
      emit()
    },
    markRead: (id?: string) => {
      state = { ...state, records: state.records.map((record) => !id || record.id === id ? { ...record, read: true } : record) }
      emit()
      persist()
    },
    retryStorage: async () => {
      if (!state.loaded) await store.initialize()
      else persist()
      await writes
    },
    flushed: () => writes,
  }
  return store
}

function sortRecords(records: AppNotification[]) {
  return records.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
}
function sameContent(a: AppNotification, b: AppNotification) {
  return a.id === b.id && a.level === b.level && a.source === b.source && a.title === b.title
    && a.message === b.message && a.details === b.details && a.state === b.state
    && a.threadId === b.threadId && a.workspaceRoot === b.workspaceRoot
    && JSON.stringify(a.actions) === JSON.stringify(b.actions)
}
export type NotificationStore = ReturnType<typeof createNotificationStore>
export function errorDetails(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error)
}
