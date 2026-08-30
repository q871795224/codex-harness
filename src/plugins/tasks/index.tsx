import { useEffect, useState, type FormEvent } from 'react'
import { ListTodo, Plus, Trash2 } from 'lucide-react'
import type { ConversationTabProps, HarnessPlugin, PluginInstanceRecord, PluginStorage, PluginViewContext } from '../../extensions/types'

export type TodoScope = 'global' | 'workspace' | 'thread'
export type TodoFilter = 'context' | 'workspaces' | 'threads'
export const DEFAULT_TODO_SCOPE: TodoScope = 'global'

export interface TodoItem {
  id: string
  content: string
  completed: boolean
  dueAt: number | null
  scope: TodoScope
  workspaceRoot: string | null
  threadId: string | null
  createdAt: number
  updatedAt: number
}

const TODO_STORAGE_KEY = 'items'

export const tasksPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.tasks',
    name: '待办',
    description: '管理全局、工作区和会话级待办。',
  version: '1.0.3',
    engine: { codexHarness: '^0.1.0' },
    supportedScopes: ['global'],
  },
  activate(ctx) {
    ctx.slots.conversationTabs.register({
      id: 'tasks',
      label: '待办',
      order: 10,
      icon: ListTodo,
      render: (props) => <TasksTab storage={ctx.storage} context={props} />,
    })
  },
}

export const tasksDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.tasks:default',
  pluginId: tasksPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

export function visibleTodos(items: TodoItem[], context: PluginViewContext, filter: TodoFilter = 'context'): TodoItem[] {
  return items
    .filter((item) => filter === 'workspaces'
      ? item.scope === 'global' || item.scope === 'workspace'
      : filter === 'threads'
        ? true
        : item.scope === 'global'
          || (item.scope === 'workspace' && item.workspaceRoot === context.workspaceRoot)
          || (item.scope === 'thread' && item.threadId === context.threadId))
    .sort((left, right) => Number(left.completed) - Number(right.completed)
      || (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt - right.createdAt)
}

export function todoWorkspaceLabel(item: TodoItem, workspaces: ConversationTabProps['workspaces']): string {
  if (item.scope === 'global') return '全局'
  if (item.workspaceRoot) {
    return workspaces.find((workspace) => workspace.root === item.workspaceRoot)?.name
      ?? item.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)
      ?? item.workspaceRoot
  }
  return '未知工作区'
}

export function todoThreadLabel(item: TodoItem, threads: ConversationTabProps['threads']): string {
  if (item.threadId) {
    const thread = threads.find((candidate) => candidate.id === item.threadId)
    return thread?.name?.trim() || thread?.preview?.trim() || item.threadId
  }
  return '未知会话'
}

export function todoScopePatch(scope: TodoScope, context: PluginViewContext): Pick<TodoItem, 'scope' | 'workspaceRoot' | 'threadId'> | null {
  if (scope === 'workspace') {
    return context.workspaceRoot
      ? { scope, workspaceRoot: context.workspaceRoot, threadId: null }
      : null
  }
  if (scope === 'thread') {
    return context.threadId
      ? { scope, workspaceRoot: null, threadId: context.threadId }
      : null
  }
  return { scope, workspaceRoot: null, threadId: null }
}

function TasksTab({ storage, context }: { storage: PluginStorage; context: ConversationTabProps }) {
  const [items, setItems] = useState<TodoItem[]>([])
  const [content, setContent] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [scope, setScope] = useState<TodoScope>(DEFAULT_TODO_SCOPE)
  const [filter, setFilter] = useState<TodoFilter>('context')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    void storage.get<TodoItem[]>(TODO_STORAGE_KEY)
      .then((saved) => { if (!disposed) setItems(Array.isArray(saved) ? saved : []) })
      .catch((nextError) => { if (!disposed) setError(messageOf(nextError)) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [storage])

  useEffect(() => {
    if ((scope === 'thread' && !context.threadId) || (scope === 'workspace' && !context.workspaceRoot)) {
      setScope(DEFAULT_TODO_SCOPE)
    }
  }, [context, scope])

  const commit = (next: TodoItem[]) => {
    setItems(next)
    setError(null)
    void storage.set(TODO_STORAGE_KEY, next).catch((nextError) => setError(messageOf(nextError)))
  }

  const createTodo = (event: FormEvent) => {
    event.preventDefault()
    const nextContent = content.trim()
    if (!nextContent) return
    const timestamp = Date.now()
    const item: TodoItem = {
      id: crypto.randomUUID(),
      content: nextContent,
      completed: false,
      dueAt: dueAt ? new Date(dueAt).getTime() : null,
      scope,
      workspaceRoot: scope === 'workspace' ? context.workspaceRoot : null,
      threadId: scope === 'thread' ? context.threadId : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    commit([...items, item])
    setContent('')
    setDueAt('')
  }

  const update = (id: string, patch: Partial<TodoItem>) => {
    commit(items.map((item) => item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item))
  }

  const updateScope = (id: string, nextScope: TodoScope) => {
    const patch = todoScopePatch(nextScope, context)
    if (patch) update(id, patch)
  }

  const shown = visibleTodos(items, context, filter)
  const openCount = shown.filter((item) => !item.completed).length
  const filterLabel = filter === 'workspaces' ? '所有工作区' : filter === 'threads' ? '所有会话' : '当前上下文'
  const showOwner = filter !== 'context'

  return (
    <div className="tasks-scroll">
      <div className="tasks-sheet">
        <header className="tasks-heading">
          <div><h2>待办</h2><p>{filterLabel} · {openCount} 项未完成</p></div>
          <div className="tasks-heading-tools">
            <label className="tasks-filter"><span>查看</span><select value={filter} onChange={(event) => setFilter(event.target.value as TodoFilter)} aria-label="筛选待办"><option value="context">当前上下文</option><option value="workspaces">所有工作区</option><option value="threads">所有会话</option></select></label>
            <span>{shown.length} items</span>
          </div>
        </header>

        <form className="tasks-create" onSubmit={createTodo}>
          <button type="submit" disabled={!content.trim()} title="新增待办"><Plus size={15} /></button>
          <input value={content} onChange={(event) => setContent(event.target.value)} placeholder="添加一项待办…" aria-label="待办内容" />
          <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} aria-label="计划时间" />
          <select value={scope} onChange={(event) => setScope(event.target.value as TodoScope)} aria-label="待办级别">
            <option value="global">全局</option>
            <option value="workspace" disabled={!context.workspaceRoot}>当前工作区</option>
            <option value="thread" disabled={!context.threadId}>当前会话</option>
          </select>
        </form>

        {error && <div className="tasks-error">{error}</div>}
        {loading ? <div className="tasks-empty">正在加载待办…</div> : shown.length === 0 ? (
          <div className="tasks-empty"><ListTodo size={22} /><span>{filter === 'workspaces' ? '还没有全局或工作区待办' : filter === 'threads' ? '还没有待办' : '当前上下文还没有待办'}</span></div>
        ) : (
          <div className="tasks-list">
            {shown.map((item) => (
              <article key={item.id} className={`task-row ${showOwner ? 'with-owner' : ''} ${item.completed ? 'completed' : ''}`}>
                <input type="checkbox" checked={item.completed} onChange={(event) => update(item.id, { completed: event.target.checked })} aria-label={`完成 ${item.content}`} />
                <input
                  className="task-content"
                  value={item.content}
                  onChange={(event) => setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, content: event.target.value } : candidate))}
                  onBlur={(event) => {
                    const nextContent = event.currentTarget.value.trim()
                    if (nextContent) update(item.id, { content: nextContent })
                    else setError('待办内容不能为空。')
                  }}
                  aria-label="编辑待办内容"
                />
                {showOwner && <span className={`task-owner ${item.scope}`} title={item.workspaceRoot ?? item.threadId ?? '全局'}>{item.scope === 'thread' ? todoThreadLabel(item, context.threads) : todoWorkspaceLabel(item, context.workspaces)}</span>}
                <input
                  className="task-time"
                  type="datetime-local"
                  value={toDateTimeInput(item.dueAt)}
                  onChange={(event) => update(item.id, { dueAt: event.target.value ? new Date(event.target.value).getTime() : null })}
                  aria-label="编辑计划时间"
                />
                <select
                  className={`task-scope ${item.scope}`}
                  value={item.scope}
                  onChange={(event) => updateScope(item.id, event.target.value as TodoScope)}
                  aria-label={`修改 ${item.content} 的级别`}
                >
                  <option value="global">全局</option>
                  <option value="workspace" disabled={!context.workspaceRoot}>当前工作区</option>
                  <option value="thread" disabled={!context.threadId}>当前会话</option>
                </select>
                <button className="task-delete" type="button" onClick={() => commit(items.filter((candidate) => candidate.id !== item.id))} aria-label={`删除 ${item.content}`}><Trash2 size={13} /></button>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function toDateTimeInput(value: number | null): string {
  if (value === null) return ''
  const date = new Date(value)
  const local = new Date(value - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
