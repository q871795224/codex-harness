import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Bell, Check, CheckCheck, CircleAlert, Copy, LoaderCircle, TriangleAlert, Clock3, X } from 'lucide-react'
import { attentionGroups, notificationAttention, type AppNotification, type NotificationAction, type NotificationLevel, type NotificationStore } from '../../core/notifications/store'
import './notifications.css'

const labels = { info: '通知', warning: '警告', error: '错误' }
function LevelIcon({ level, state }: { level: NotificationLevel; state: AppNotification['state'] }) {
  if (state === 'running') return <LoaderCircle size={16} className="notification-spinner" aria-label="进行中" />
  const Icon = level === 'error' ? CircleAlert : level === 'warning' ? TriangleAlert : Check
  return <Icon size={16} aria-label={labels[level]} />
}

interface ReminderThread { id: string; title: string; cwd?: string }
export function NotificationViewport({ store, onOpen, open: controlledOpen, onToggle, onAction, currentThread, focusedThreadId }: {
  store: NotificationStore
  onOpen: (id?: string) => void
  open?: boolean
  onToggle?: (open: boolean) => void
  onAction?: (action: NotificationAction) => Promise<void>
  currentThread?: ReminderThread | null
  focusedThreadId?: string | null
}) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  const [localOpen, setLocalOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = controlledOpen ?? localOpen
  const root = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const toggle = (next: boolean) => { setLocalOpen(next); onToggle?.(next) }
  const toggleRef = useRef(toggle); toggleRef.current = toggle
  useEffect(() => {
    const deadlines = [...state.floating.flatMap((item) => item.expiresAt === null ? [] : [item.expiresAt]), ...state.records.flatMap((record) => record.remindAt && !record.resolved ? [record.remindAt] : [])]
    if (!deadlines.length) return
    const timeout = window.setTimeout(store.tick, Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - Date.now())))
    return () => window.clearTimeout(timeout)
  }, [state.floating, state.records, store])
  useEffect(() => {
    const focus = () => { store.setFocusedThread(document.visibilityState === 'visible' && document.hasFocus() ? focusedThreadId ?? null : null); store.tick() }
    const blur = () => store.setFocusedThread(null)
    focus(); window.addEventListener('focus', focus); window.addEventListener('blur', blur); document.addEventListener('visibilitychange', focus)
    return () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', focus); store.setFocusedThread(null) }
  }, [store, focusedThreadId])
  useEffect(() => {
    if (!open) return
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root.current?.querySelector<HTMLButtonElement>('.reminder-rail > header button')?.focus()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); toggleRef.current(false); if (previousFocus.current?.isConnected) previousFocus.current.focus() } }
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && !root.current?.contains(target) && !target.closest('[data-notification-toggle]')) toggleRef.current(false)
    }
    window.addEventListener('keydown', key, true); document.addEventListener('pointerdown', outside)
    return () => { window.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', outside) }
  }, [open])
  const groups = attentionGroups(state.records)
  const floatingIds = new Set(state.floating.map((item) => item.id))
  const floatingGroups = groups.filter((group) => group.records.some((record) => floatingIds.has(record.id))).slice(0, 3)
  const scheduled = state.records.filter((record) => !record.resolved && record.remindAt && record.remindAt > Date.now())
  const watching = state.records.filter((record) => record.watchThread)
  const openGroup = async (group: typeof groups[number]) => {
    setError(null)
    try {
      const record = group.record
      const action = record.threadId ? { kind: 'thread' as const, target: record.threadId, label: '打开会话' } : record.actions?.[0]
      if (action && onAction) await onAction(action)
      else onOpen(record.id)
      group.records.forEach((item) => store.markRead(item.id))
      toggle(false)
    } catch { setError('暂时无法打开，请稍后重试，或在通知历史查看详情。') }
  }
  const snooze = (group: typeof groups[number], minutes: number) => store.snooze(group.records.map((record) => record.id), Date.now() + minutes * 60_000)
  const card = (group: typeof groups[number], floating: boolean) => {
    const record = group.record
    return <article key={group.key} className={`notification-toast ${record.level}`} role={floating ? record.level === 'error' ? 'alert' : 'status' : undefined}>
      <LevelIcon level={record.level} state={record.state} />
      <div className="notification-copy">
        <small>{record.source}{record.workspaceRoot ? ` · ${record.workspaceRoot.split('/').filter(Boolean).at(-1)}` : ''}</small>
        <strong>{record.title}</strong>{record.message && <p>{record.message}</p>}
        {group.records.length > 1 && <small>这个会话还有 {group.records.length - 1} 条提醒</small>}
        <div className="reminder-card-actions">
          <button type="button" onClick={() => void openGroup(group)}>{record.threadId ? '打开会话' : record.actions?.[0]?.label ?? '查看详情'}</button>
          <button type="button" onClick={() => snooze(group, 30)}>30 分钟后</button>
          {notificationAttention(record) === 'action' && record.state !== 'pending' && <button type="button" onClick={() => store.resolve(record.id)}>已处理</button>}
        </div>
      </div>
      {floating && <button className="notification-close" type="button" aria-label={`关闭通知：${record.title}`} onClick={() => group.records.forEach((item) => store.dismiss(item.id))}><X size={14} /></button>}
    </article>
  }
  return <div ref={root} className="notification-viewport" aria-label="通知提醒">
    {!open && error && <p className="notification-toast error" role="alert">{error}</p>}
    {!open && floatingGroups.map((group) => card(group, true))}
    {!open && groups.length > 0 && <button type="button" className="reminder-bubble" aria-label={`展开提醒，${groups.length} 个会话或事项待关注`} onClick={() => toggle(true)}><Bell size={16} />提醒 <b>{groups.length}</b></button>}
    {open && <aside className="reminder-rail" aria-label="通知提醒栏">
      <header><div><h2>提醒</h2><small>{groups.length ? `${groups.length} 个会话或事项待关注` : '当前没有需要关注的提醒'}</small></div><button type="button" aria-label="收起提醒" onClick={() => toggle(false)}><X size={17} /></button></header>
      <div className="reminder-rail-body">
        {state.storageError && <p role="alert">提醒暂时无法保存或读取。<button type="button" onClick={() => void store.retryStorage()}>重试</button></p>}
        {error && <p role="alert">{error}</p>}
        {(['action', 'result', 'follow-up'] as const).map((kind) => {
          const items = groups.filter((group) => notificationAttention(group.record) === kind)
          return items.length > 0 && <section key={kind} aria-label={kind === 'action' ? '需要回应' : kind === 'result' ? '有新结果' : '到点跟进'}>
            <h3>{kind === 'action' ? '需要回应' : kind === 'result' ? '有新结果' : '到点跟进'}</h3>{items.map((group) => card(group, false))}
          </section>
        })}
        {currentThread && <ThreadReminderForm key={currentThread.id} store={store} thread={currentThread} loaded={state.loaded} watching={watching.some((record) => record.threadId === currentThread.id)} />}
        {(scheduled.length > 0 || watching.length > 0) && <details className="reminder-scheduled"><summary>稍后与关注中 · {scheduled.length + watching.length}</summary>
          {scheduled.map((record) => <div key={record.id}><span>{record.title}<small>{new Date(record.remindAt!).toLocaleString()} 再提醒</small></span><button type="button" onClick={() => store.snooze([record.id], Date.now() + 1)}>现在提醒</button>{record.attention === 'follow-up' && <button type="button" onClick={() => store.resolve(record.id)}>取消</button>}</div>)}
          {watching.map((record) => <div key={record.id}><span>{record.title}<small>有新一轮结果时提醒</small></span><button type="button" onClick={() => store.watchThread({ id: record.threadId!, title: record.title }, false)}>取消关注</button></div>)}
        </details>}
        {!currentThread && groups.length === 0 && <p className="reminder-empty">有事情需要关注时会在这里出现。</p>}
      </div>
      <footer><button type="button" onClick={() => { toggle(false); onOpen() }}>查看全部通知历史</button></footer>
    </aside>}
  </div>
}
function localDateTime(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
function ThreadReminderForm({ store, thread, watching, loaded }: { store: NotificationStore; thread: ReminderThread; watching: boolean; loaded: boolean }) {
  const [time, setTime] = useState(localDateTime(new Date(Date.now() + 30 * 60_000)))
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const schedule = (at: number) => {
    setError('')
    try { store.remindThread(thread, at); setStatus(`已设置：${new Date(at).toLocaleString()}`) }
    catch (next) { setError(next instanceof Error ? next.message : String(next)) }
  }
  return <details className="thread-reminder-form"><summary><Clock3 size={14} />提醒当前会话</summary>
    <p>{thread.title}</p>
    <div><button type="button" disabled={!loaded} onClick={() => schedule(Date.now() + 30 * 60_000)}>30 分钟后</button><button type="button" disabled={!loaded} onClick={() => { const date = new Date(); date.setDate(date.getDate() + 1); date.setHours(9, 0, 0, 0); schedule(date.getTime()) }}>明天 9 点</button></div>
    <form onSubmit={(event) => { event.preventDefault(); schedule(new Date(time).getTime()) }}><label>指定时间<input type="datetime-local" aria-label="提醒时间" value={time} onChange={(event) => setTime(event.target.value)} disabled={!loaded} /></label><button type="submit" disabled={!loaded}>设置提醒</button></form>
    <label className="reminder-watch"><input type="checkbox" checked={watching} disabled={!loaded} onChange={(event) => store.watchThread(thread, event.target.checked)} />有新一轮结果时提醒</label>
    <small>关闭应用期间不弹出，重新打开后补提醒。</small>
    {status && <p role="status">{status}</p>}{error && <p role="alert">{error}</p>}
  </details>
}

export function NotificationCenter({ store, currentThreadId, selectedId, onBack, onAction }: {
  store: NotificationStore
  currentThreadId: string | null
  selectedId?: string
  onBack: () => void
  onAction: (action: NotificationAction) => Promise<void>
}) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  const [level, setLevel] = useState<NotificationLevel | 'all'>('all')
  const [scope, setScope] = useState('all')
  const [limit, setLimit] = useState(50)
  const records = state.records.filter((record) => (level === 'all' || level === record.level) && (scope === 'all' || record.threadId === currentThreadId))
  useEffect(() => {
    if (selectedId) document.getElementById(`notification-${selectedId}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [selectedId])
  const selected = selectedId ? state.records.find((record) => record.id === selectedId) : undefined
  return (
    <section className="notification-center" aria-label="通知中心">
      <header className="notification-page-header">
        <button type="button" onClick={onBack}><ArrowLeft size={16} />返回会话</button>
        <button type="button" onClick={() => store.markRead()} disabled={!state.records.some((record) => !record.read)}><CheckCheck size={16} />全部已读</button>
      </header>
      <div className="notification-page-body">
        <div className="notification-heading"><Bell size={22} /><div><h1>通知中心</h1><p>按最新时间排列 · {state.records.filter((record) => !record.read).length} 条未读</p></div></div>
        {state.storageError && <div className="notification-storage-error" role="alert">通知历史暂时无法{state.loaded ? '保存' : '读取'}，本次提醒仍可查看。<button onClick={() => void store.retryStorage()}>重试</button><details><summary>错误详情</summary><pre>{state.storageError}</pre></details></div>}
        <div className="notification-filters">
          <div role="group" aria-label="通知类型">
            {(['all', 'info', 'warning', 'error'] as const).map((value) => <button key={value} type="button" aria-pressed={level === value} onClick={() => { setLevel(value); setLimit(50) }}>{value === 'all' ? '全部' : labels[value]}</button>)}
          </div>
          <select aria-label="通知范围" value={scope} onChange={(event) => { setScope(event.target.value); setLimit(50) }}><option value="all">所有会话与工作区</option><option value="thread" disabled={!currentThreadId}>当前会话</option></select>
        </div>
        {selected && !records.slice(0, limit).some((record) => record.id === selected.id) && <NotificationRow key={`selected-${selected.id}`} record={selected} store={store} expanded onAction={onAction} />}
        {!state.loaded && !state.storageError && <p className="notification-empty">正在读取通知历史…</p>}
        {state.loaded && records.length === 0 && <div className="notification-empty"><Bell size={28} /><p>{state.records.length ? '没有符合筛选条件的通知' : '暂无通知'}</p></div>}
        <div className="notification-list">
          {records.slice(0, limit).map((record) => <NotificationRow key={record.id} record={record} store={store} expanded={selectedId === record.id} onAction={onAction} />)}
        </div>
        {records.length > limit && <button className="notification-more" type="button" onClick={() => setLimit((value) => value + 50)}>显示更早的通知（剩余 {records.length - limit} 条）</button>}
      </div>
    </section>
  )
}

function NotificationRow({ record, expanded, store, onAction }: {
  record: AppNotification
  expanded: boolean
  store: NotificationStore
  onAction: (action: NotificationAction) => Promise<void>
}) {
  const [open, setOpen] = useState(expanded)
  const [copyState, setCopyState] = useState('复制详情')
  useEffect(() => { if (expanded) setOpen(true) }, [expanded])
  return (
    <article id={`notification-${record.id}`} className={`notification-row ${record.level}${record.state === 'running' ? ' running' : ''}${record.read ? '' : ' unread'}`}>
      <button type="button" className="notification-row-toggle" aria-expanded={open} onClick={() => { setOpen(!open); store.markRead(record.id) }}>
        <LevelIcon level={record.level} state={record.state} />
        <div className="notification-copy"><span className="notification-meta">{record.source} · {record.state === 'running' ? '进行中' : labels[record.level]}{!record.read && <i aria-label="未读" />}</span><strong>{record.title}</strong>{record.message && <p>{record.message}</p>}</div>
        <time dateTime={new Date(record.updatedAt).toISOString()}>{new Date(record.updatedAt).toLocaleString()}</time>
      </button>
      {open && <div className="notification-details">
        <dl><dt>首次通知</dt><dd>{new Date(record.createdAt).toLocaleString()}</dd>{record.threadId && <><dt>会话</dt><dd>{record.threadId}</dd></>}{record.workspaceRoot && <><dt>工作区</dt><dd>{record.workspaceRoot}</dd></>}</dl>
        {record.details && <pre>{record.details}</pre>}
        <div className="notification-detail-actions">
          <button type="button" onClick={() => {
            void navigator.clipboard.writeText([record.title, record.message, record.details, record.threadId, record.workspaceRoot].filter(Boolean).join('\n')).then(() => setCopyState('已复制')).catch(() => setCopyState('复制失败，请手动选择详情'))
          }}><Copy size={13} />{copyState}</button>
          {record.actions?.map((action) => <button type="button" key={`${action.kind}:${action.target}`} onClick={() => { void onAction(action).catch((error) => store.publish({ level: 'error', source: '通知中心', title: '无法打开通知关联内容', message: '请稍后重试，或复制详情后手动查找。', details: String(error) })) }}>{action.label}</button>)}
          {record.threadId && !record.actions?.some((action) => action.kind === 'thread') && <button type="button" onClick={() => { void onAction({ kind: 'thread', label: '打开会话', target: record.threadId! }).catch((error) => store.publish({ level: 'error', source: '通知中心', title: '无法打开关联会话', details: String(error) })) }}>打开会话</button>}
        </div>
      </div>}
    </article>
  )
}
