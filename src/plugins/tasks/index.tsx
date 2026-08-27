import { useEffect, useState, type FormEvent } from 'react'
import { ListTodo, Plus, Trash2 } from 'lucide-react'
import type { HarnessPlugin, PluginInstanceRecord, PluginStorage, PluginViewContext } from '../../extensions/types'

export type TodoScope = 'global' | 'workspace' | 'thread'

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
    version: '1.0.0',
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

export function visibleTodos(items: TodoItem[], context: PluginViewContext): TodoItem[] {
  return items
    .filter((item) => item.scope === 'global'
      || (item.scope === 'workspace' && item.workspaceRoot === context.workspaceRoot)
      || (item.scope === 'thread' && item.threadId === context.threadId))
    .sort((left, right) => Number(left.completed) - Number(right.completed)
      || (left.dueAt ?? Number.MAX_SAFE_INTEGER) - (right.dueAt ?? Number.MAX_SAFE_INTEGER)
      || left.createdAt - right.createdAt)
}

function TasksTab({ storage, context }: { storage: PluginStorage; context: PluginViewContext }) {
  const [items, setItems] = useState<TodoItem[]>([])
  const [content, setContent] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [scope, setScope] = useState<TodoScope>(() => defaultScope(context))
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
      setScope(defaultScope(context))
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

  const shown = visibleTodos(items, context)
  const openCount = shown.filter((item) => !item.completed).length

  return (
    <div className="tasks-scroll">
      <div className="tasks-sheet">
        <header className="tasks-heading">
          <div><h2>待办</h2><p>当前上下文 · {openCount} 项未完成</p></div>
          <span>{shown.length} items</span>
        </header>

        <form className="tasks-create" onSubmit={createTodo}>
          <button type="submit" disabled={!content.trim()} title="新增待办"><Plus size={15} /></button>
          <input value={content} onChange={(event) => setContent(event.target.value)} placeholder="添加一项待办…" aria-label="待办内容" />
          <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} aria-label="计划时间" />
          <select value={scope} onChange={(event) => setScope(event.target.value as TodoScope)} aria-label="待办级别">
            <option value="global">全局</option>
            <option value="workspace" disabled={!context.workspaceRoot}>工作区</option>
            <option value="thread" disabled={!context.threadId}>会话</option>
          </select>
        </form>

        {error && <div className="tasks-error">{error}</div>}
        {loading ? <div className="tasks-empty">正在加载待办…</div> : shown.length === 0 ? (
          <div className="tasks-empty"><ListTodo size={22} /><span>当前上下文还没有待办</span></div>
        ) : (
          <div className="tasks-list">
            {shown.map((item) => (
              <article key={item.id} className={`task-row ${item.completed ? 'completed' : ''}`}>
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
                <input
                  className="task-time"
                  type="datetime-local"
                  value={toDateTimeInput(item.dueAt)}
                  onChange={(event) => update(item.id, { dueAt: event.target.value ? new Date(event.target.value).getTime() : null })}
                  aria-label="编辑计划时间"
                />
                <span className={`task-scope ${item.scope}`}>{scopeLabel(item.scope)}</span>
                <button className="task-delete" type="button" onClick={() => commit(items.filter((candidate) => candidate.id !== item.id))} aria-label={`删除 ${item.content}`}><Trash2 size={13} /></button>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function defaultScope(context: PluginViewContext): TodoScope {
  if (context.threadId) return 'thread'
  if (context.workspaceRoot) return 'workspace'
  return 'global'
}

function scopeLabel(scope: TodoScope): string {
  if (scope === 'workspace') return '工作区'
  if (scope === 'thread') return '会话'
  return '全局'
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
