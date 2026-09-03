import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { NotebookPen, Pencil, Plus, Trash2 } from 'lucide-react'
import type {
  ComposerCompletionItem,
  ConversationTabProps,
  HarnessPlugin,
  PluginInstanceRecord,
  PluginStorage,
  PluginViewContext,
} from '../../extensions/types'

export type PromptScope = 'global' | 'workspace'

export interface PromptItem {
  id: string
  title: string
  body: string
  scope: PromptScope
  workspaceRoot: string | null
  createdAt: number
  updatedAt: number
}

const PROMPTS_STORAGE_KEY = 'prompts.v1'
const PROMPT_COLLAPSE_MIN_CHARS = 300
const PROMPT_COLLAPSE_MIN_LINES = 3
const GROUP_GLOBAL = '全局'
const GROUP_WORKSPACE = '本工作区'

export function shouldCollapsePrompt(body: string): boolean {
  return Array.from(body).length >= PROMPT_COLLAPSE_MIN_CHARS || body.split('\n').length >= PROMPT_COLLAPSE_MIN_LINES
}

export function firstLineOf(body: string): string {
  const line = body.split('\n', 1)[0]?.trim() ?? ''
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

export interface PromptStore {
  getSnapshot(): PromptItem[]
  subscribe(listener: () => void): () => void
  ensureLoaded(): Promise<PromptItem[]>
  commit(next: PromptItem[]): Promise<void>
}

export function createPromptStore(storage: PluginStorage): PromptStore {
  let items: PromptItem[] = []
  let loading: Promise<PromptItem[]> | null = null
  let writeQueue: Promise<void> = Promise.resolve()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of [...listeners]) listener()
  }
  return {
    getSnapshot: () => items,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    ensureLoaded: () => {
      loading ??= storage.get<unknown>(PROMPTS_STORAGE_KEY)
        .then((saved) => {
          items = normalizePromptItems(saved)
          notify()
          return items
        })
        .catch((error: unknown) => {
          loading = null
          throw error
        })
      return loading
    },
    commit: (next) => {
      items = next
      notify()
      writeQueue = writeQueue.catch(() => undefined).then(() => storage.set(PROMPTS_STORAGE_KEY, next))
      return writeQueue
    },
  }
}

export function normalizePromptItems(raw: unknown): PromptItem[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is PromptItem => {
    if (typeof value !== 'object' || value === null) return false
    const candidate = value as Partial<PromptItem>
    return typeof candidate.id === 'string'
      && typeof candidate.title === 'string'
      && typeof candidate.body === 'string'
      && (candidate.scope === 'global' || candidate.scope === 'workspace')
  })
}

const byRecentlyUpdated = (left: PromptItem, right: PromptItem) => right.updatedAt - left.updatedAt

export async function loadPromptItems(store: PromptStore, query: string, context: PluginViewContext): Promise<ComposerCompletionItem[]> {
  const items = await store.ensureLoaded()
  const normalized = query.trim().toLocaleLowerCase()
  const matches = (item: PromptItem) => !normalized
    || item.title.toLocaleLowerCase().includes(normalized)
    || item.body.toLocaleLowerCase().includes(normalized)
  const toCompletion = (group: string) => (item: PromptItem): ComposerCompletionItem => ({
    id: item.id,
    title: item.title,
    subtitle: firstLineOf(item.body),
    group,
    insertText: item.body,
    collapseAsPaste: shouldCollapsePrompt(item.body),
  })
  const workspaceItems = context.workspaceRoot
    ? items
      .filter((item) => item.scope === 'workspace' && item.workspaceRoot === context.workspaceRoot && matches(item))
      .sort(byRecentlyUpdated)
      .slice(0, 8)
      .map(toCompletion(GROUP_WORKSPACE))
    : []
  const globalItems = items
    .filter((item) => item.scope === 'global' && matches(item))
    .sort(byRecentlyUpdated)
    .slice(0, 8)
    .map(toCompletion(GROUP_GLOBAL))
  return [...workspaceItems, ...globalItems]
}

export const promptsPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.prompts',
    name: '提示词',
    description: '管理全局与工作区提示词片段，在输入框键入 # 搜索并插入。',
    version: '1.0.0',
    engine: { codexHarness: '^0.3.0' },
    supportedScopes: ['global'],
  },
  activate(ctx) {
    const store = createPromptStore(ctx.storage)
    ctx.slots.composerCompletions.register({
      id: 'prompts',
      trigger: '#',
      order: 10,
      loadItems: (query, viewContext) => loadPromptItems(store, query, viewContext),
    })
    ctx.slots.conversationTabs.register({
      id: 'prompts',
      label: '提示词',
      order: 15,
      icon: NotebookPen,
      render: (props) => <PromptsTab store={store} context={props} />,
    })
  },
}

export const promptsDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.prompts:default',
  pluginId: promptsPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

type EditorTarget = { mode: 'new'; scope: PromptScope } | { mode: 'edit'; id: string }

function PromptsTab({ store, context }: { store: PromptStore; context: ConversationTabProps }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const workspaceRoot = context.workspaceRoot

  useEffect(() => {
    let disposed = false
    store.ensureLoaded()
      .catch((nextError: unknown) => { if (!disposed) setError(messageOf(nextError)) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [store])

  useEffect(() => {
    if (confirmingDeleteId === null) return undefined
    const timeout = window.setTimeout(() => setConfirmingDeleteId(null), 3_000)
    return () => window.clearTimeout(timeout)
  }, [confirmingDeleteId])

  const globalItems = useMemo(() => items.filter((item) => item.scope === 'global').sort(byRecentlyUpdated), [items])
  const workspaceItems = useMemo(() => workspaceRoot
    ? items.filter((item) => item.scope === 'workspace' && item.workspaceRoot === workspaceRoot).sort(byRecentlyUpdated)
    : [], [items, workspaceRoot])

  const saveEditor = async (draft: { title: string; body: string }): Promise<boolean> => {
    const title = draft.title.trim()
    const body = draft.body.trim()
    if (!editor) return false
    if (!title || !body) {
      setError('标题和正文都不能为空。')
      return false
    }
    if (editor.mode === 'new' && editor.scope === 'workspace' && !workspaceRoot) {
      setError('当前没有工作区，无法新增工作区提示词。')
      return false
    }
    setError(null)
    const timestamp = Date.now()
    const next = editor.mode === 'edit'
      ? items.map((item) => item.id === editor.id ? { ...item, title, body, updatedAt: timestamp } : item)
      : [...items, {
        id: crypto.randomUUID(),
        title,
        body,
        scope: editor.scope,
        workspaceRoot: editor.scope === 'workspace' ? workspaceRoot : null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }]
    try {
      await store.commit(next)
      setEditor(null)
      return true
    } catch (nextError) {
      setError(messageOf(nextError))
      return false
    }
  }

  const remove = async (id: string) => {
    setError(null)
    try {
      await store.commit(items.filter((item) => item.id !== id))
    } catch (nextError) {
      setError(messageOf(nextError))
    }
    setConfirmingDeleteId(null)
    setEditor((current) => current?.mode === 'edit' && current.id === id ? null : current)
  }

  const renderSection = (title: string, scope: PromptScope, sectionItems: PromptItem[], available: boolean) => (
    <section className="prompts-section">
      <header className="prompts-section-head">
        <h3>{title}<span>{sectionItems.length} 条</span></h3>
        {available && (
          <button
            type="button"
            className="prompts-add"
            onClick={() => { setEditor({ mode: 'new', scope }); setConfirmingDeleteId(null) }}
          >
            <Plus size={13} />新增
          </button>
        )}
      </header>
      {editor?.mode === 'new' && editor.scope === scope && (
        <PromptEditor
          initialTitle=""
          initialBody=""
          onSave={saveEditor}
          onCancel={() => setEditor(null)}
        />
      )}
      {!available ? (
        <div className="prompts-section-empty">当前会话没有工作区，进入工作区会话后可管理本工作区提示词。</div>
      ) : sectionItems.length === 0 && !(editor?.mode === 'new' && editor.scope === scope) ? (
        <div className="prompts-section-empty">{scope === 'global' ? '还没有全局提示词。' : '本工作区还没有提示词。'}</div>
      ) : (
        <div className="prompts-list">
          {sectionItems.map((item) => (
            <article key={item.id} className="prompt-row">
              {editor?.mode === 'edit' && editor.id === item.id ? (
                <PromptEditor
                  initialTitle={item.title}
                  initialBody={item.body}
                  onSave={saveEditor}
                  onCancel={() => setEditor(null)}
                />
              ) : (
                <>
                  <div className="prompt-row-text">
                    <strong>{item.title}</strong>
                    <small>{firstLineOf(item.body)}</small>
                  </div>
                  <span className="prompt-row-meta">{Array.from(item.body).length} 字</span>
                  <button
                    type="button"
                    className="prompt-edit"
                    onClick={() => { setEditor({ mode: 'edit', id: item.id }); setConfirmingDeleteId(null) }}
                    aria-label={`编辑 ${item.title}`}
                    title="编辑"
                  >
                    <Pencil size={13} />
                  </button>
                  {confirmingDeleteId === item.id ? (
                    <button
                      type="button"
                      className="prompt-delete confirm"
                      onClick={() => void remove(item.id)}
                      aria-label={`确认删除 ${item.title}`}
                      title="确认删除"
                    >
                      确认
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="prompt-delete"
                      onClick={() => { setConfirmingDeleteId(item.id); setEditor(null) }}
                      aria-label={`删除 ${item.title}`}
                      title="删除"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )

  return (
    <div className="tasks-scroll">
      <div className="tasks-sheet">
        <header className="tasks-heading">
          <div><h2>提示词</h2><p>在输入框键入 # 搜索并插入提示词</p></div>
          <div className="tasks-heading-tools"><span>{items.length} 条</span></div>
        </header>
        {error && <div className="tasks-error">{error}</div>}
        {loading ? <div className="tasks-empty"><NotebookPen size={22} /><span>正在加载提示词…</span></div> : (
          <>
            {renderSection('全局', 'global', globalItems, true)}
            {renderSection('本工作区', 'workspace', workspaceItems, Boolean(workspaceRoot))}
          </>
        )}
      </div>
    </div>
  )
}

function PromptEditor({ initialTitle, initialBody, onSave, onCancel }: {
  initialTitle: string
  initialBody: string
  onSave(draft: { title: string; body: string }): Promise<boolean>
  onCancel(): void
}) {
  const [title, setTitle] = useState(initialTitle)
  const [body, setBody] = useState(initialBody)
  const [saving, setSaving] = useState(false)
  return (
    <div className="prompt-editor">
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="标题（# 搜索时匹配）"
        aria-label="提示词标题"
      />
      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="正文，选中后原样填入输入框；超过 300 字或 3 行会折叠为标题占位。"
        rows={6}
        aria-label="提示词正文"
        spellCheck={false}
      />
      <div className="prompt-editor-actions">
        <button type="button" className="prompt-editor-cancel" onClick={onCancel}>取消</button>
        <button
          type="button"
          className="prompt-editor-save"
          disabled={saving || !title.trim() || !body.trim()}
          onClick={() => {
            setSaving(true)
            void onSave({ title, body }).finally(() => setSaving(false))
          }}
        >
          保存
        </button>
      </div>
    </div>
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
