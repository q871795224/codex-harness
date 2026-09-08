import { useEffect, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, Bell, Check, CheckCheck, CircleAlert, Copy, TriangleAlert, X } from 'lucide-react'
import type { AppNotification, NotificationAction, NotificationLevel, NotificationStore } from '../../core/notifications/store'
import './notifications.css'

const labels = { info: '通知', warning: '警告', error: '错误' }
function LevelIcon({ level }: { level: NotificationLevel }) {
  const Icon = level === 'error' ? CircleAlert : level === 'warning' ? TriangleAlert : Check
  return <Icon size={16} aria-label={labels[level]} />
}

export function NotificationViewport({ store, onOpen }: { store: NotificationStore; onOpen: (id?: string) => void }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot)
  useEffect(() => {
    if (!state.floating.length) return
    const timeout = window.setTimeout(store.expire, Math.max(0, Math.min(...state.floating.map((item) => item.expiresAt)) - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [state.floating, store])
  const records = state.floating.slice(-3).reverse().flatMap(({ id }) => {
    const record = state.records.find((item) => item.id === id)
    return record ? [record] : []
  })
  return (
    <div className="notification-viewport" aria-label="通知提醒">
      {records.map((record) => (
        <article key={`${record.id}:${record.updatedAt}`} className={`notification-toast ${record.level}`} role={record.level === 'error' ? 'alert' : 'status'}>
          <LevelIcon level={record.level} />
          <div className="notification-copy">
            <small>{record.source}</small>
            <strong>{record.title}</strong>
            {record.message && <p>{record.message}</p>}
            <button type="button" onClick={() => { store.markRead(record.id); store.dismiss(record.id); onOpen(record.id) }}>查看详情</button>
          </div>
          <button className="notification-close" type="button" aria-label={`关闭通知：${record.title}`} onClick={() => store.dismiss(record.id)}><X size={14} /></button>
        </article>
      ))}
    </div>
  )
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
    <article id={`notification-${record.id}`} className={`notification-row ${record.level}${record.read ? '' : ' unread'}`}>
      <button type="button" className="notification-row-toggle" aria-expanded={open} onClick={() => { setOpen(!open); store.markRead(record.id) }}>
        <LevelIcon level={record.level} />
        <div className="notification-copy"><span className="notification-meta">{record.source} · {labels[record.level]}{!record.read && <i aria-label="未读" />}</span><strong>{record.title}</strong>{record.message && <p>{record.message}</p>}</div>
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
