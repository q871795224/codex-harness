import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { runtime } from '../../core/runtime/bridge'
import { mergeSuperbotMessages, remoteSuperbotId, superbotId, superbotThread, type SuperbotCursor, type SuperbotModel, type SuperbotRunConfig, type SuperbotSession, type SuperbotSnapshot } from '../../core/superbot/types'

export function useSuperbotHarness(archived: boolean) {
  const [sessions, setSessions] = useState<SuperbotSession[]>([])
  const [snapshots, setSnapshots] = useState<Record<string, SuperbotSnapshot>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [models, setModels] = useState<SuperbotModel[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const writeInFlight = useRef(false)
  const generation = useRef(0)
  const requestEpoch = useRef<Record<string, number>>({})
  const snapshotRef = useRef(snapshots)
  snapshotRef.current = snapshots
  const refresh = useCallback(async () => {
    const version = ++generation.current
    const next = await runtime.superbotRequest<SuperbotSession[]>({ type: 'list', archived })
    if (version === generation.current) setSessions(next)
    return next
  }, [archived])
  useEffect(() => {
    setSessions([])
    void refresh().catch(e => setError(String(e))).finally(() => setLoaded(true))
    return () => { generation.current++ }
  }, [refresh])
  const read = useCallback(async (id: string, before?: SuperbotCursor) => {
    const epoch = requestEpoch.current[id] ?? 0
    const result = await runtime.superbotRequest<SuperbotSnapshot>({ type: 'read', id: remoteSuperbotId(id),
      ...(before ? { before_created_at: before.created_at, before_id: before.id } : {}) })
    if (epoch !== (requestEpoch.current[id] ?? 0)) return result
    setSnapshots(current => {
      const previous = current[id]
      return { ...current, [id]: { ...result, page: {
        ...result.page,
        messages: mergeSuperbotMessages(previous?.page.messages ?? [], result.page.messages),
        // Refreshing the newest page must retain the older-page cursor already reached.
        ...(!before && previous ? { has_more: previous.page.has_more, next_cursor: previous.page.next_cursor } : {}),
      } } }
    })
    setSessions(current => current.map(s => s.id === result.session.id ? result.session : s))
    return result
  }, [])
  useEffect(() => {
    // Refresh the catalog and observed background runs; execution lives in the cloud.
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        await refresh()
        await Promise.all(Object.entries(snapshotRef.current).filter(([id, s]) => id !== selectedId && s.pending.task_id).map(([id]) => read(id)))
      } catch { /* Opening a session exposes actionable errors. */ }
      if (!stopped) timer = setTimeout(poll, Object.values(snapshotRef.current).some(s => s.pending.task_id) ? 5000 : 30_000)
    }
    timer = setTimeout(poll, Object.values(snapshotRef.current).some(s => s.pending.task_id) ? 5000 : 30_000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [refresh, read, selectedId])
  useEffect(() => {
    if (!selectedId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      let active = false
      try {
        const result = await read(selectedId)
        active = Boolean(result.pending.task_id)
        if (!stopped) setError(null)
      } catch (e) { if (!stopped) setError(String(e)) }
      if (!stopped) timer = setTimeout(poll, active ? 2500 : 15_000)
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [read, selectedId])
  const catalog = useCallback(async () => {
    const result = await runtime.superbotRequest<{ models: SuperbotModel[] }>({ type: 'catalog' })
    setModels(result.models)
  }, [])
  const action = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (writeInFlight.current) throw new Error('Superbot 操作正在提交，请稍候')
    writeInFlight.current = true
    setBusy(true); setError(null)
    try { return await fn() } catch (e) { setError(String(e)); throw e } finally { writeInFlight.current = false; setBusy(false) }
  }, [])
  const create = useCallback(() => action(async () => {
    const session = await runtime.superbotRequest<SuperbotSession>({ type: 'create' })
    generation.current++
    setSessions(current => [session, ...current.filter(s => s.id !== session.id)])
    return superbotId(session.id)
  }), [action])
  const send = useCallback((id: string, content: string, run_config: SuperbotRunConfig) => action(async () => {
    requestEpoch.current[id] = (requestEpoch.current[id] ?? 0) + 1
    const result = await runtime.superbotRequest<{ task_id: string }>({ type: 'send', id: remoteSuperbotId(id), content, run_config })
    requestEpoch.current[id] = (requestEpoch.current[id] ?? 0) + 1
    // The send has been accepted. A failed refresh must never cause a duplicate send.
    setSnapshots(current => current[id] ? { ...current, [id]: { ...current[id], pending: { task_id: result.task_id, status: 'pending' } } } : current)
    void read(id).catch(e => setError(String(e)))
  }), [action, read])
  const stop = useCallback((id: string) => action(async () => {
    const task = snapshotRef.current[id]?.pending.task_id
    if (!task) return
    await runtime.superbotRequest({ type: 'stop', id: remoteSuperbotId(id), task_id: task })
    await read(id)
  }), [action, read])
  const rename = useCallback((id: string, title: string) => action(async () => {
    requestEpoch.current[id] = (requestEpoch.current[id] ?? 0) + 1
    await runtime.superbotRequest({ type: 'rename', id: remoteSuperbotId(id), title })
    requestEpoch.current[id] = (requestEpoch.current[id] ?? 0) + 1
    await refresh()
  }), [action, refresh])
  const archive = useCallback((id: string, value: boolean) => action(async () => {
    requestEpoch.current[id] = (requestEpoch.current[id] ?? 0) + 1
    await runtime.superbotRequest({ type: 'archive', id: remoteSuperbotId(id), archived: value })
    requestEpoch.current[id] = (requestEpoch.current[id] ?? 0) + 1
    await refresh()
  }), [action, refresh])
  const threads = useMemo(() => sessions.map(s => superbotThread(s, snapshots[superbotId(s.id)]?.pending.task_id)), [sessions, snapshots])
  const activeTurnIds = useMemo(() => Object.fromEntries(Object.entries(snapshots).flatMap(([id, s]) => s.pending.task_id ? [[id, s.pending.task_id]] : [])), [snapshots])
  return { loaded, sessions, threads, snapshots, models, busy, error, activeTurnIds, refresh, read, catalog, create, send, stop, rename, archive, select: setSelectedId }
}
