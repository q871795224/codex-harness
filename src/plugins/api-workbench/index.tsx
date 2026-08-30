import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  CheckCircle2, ChevronDown, ChevronRight, CircleDot, Clock3, Code2,
  FlaskConical, Folder, FolderOpen, Import, KeyRound, LoaderCircle, Plus, Save, Send, Trash2,
  XCircle,
} from 'lucide-react'
import type { ApiWorkbenchService, ApiCollectionItem, ApiExecutionResult, ApiFolderDefinition, ApiKeyValue, ApiRequestDefinition, ApiVariable, ApiWorkbenchState } from '../../core/api-workbench/types'
import {
  activeEnvironment, appendRequest, createCollection, createEnvironment, createKeyValue, createVariable,
  emptyWorkbenchState, ensureTrailingRow, findRequestContext, removeRequest, replaceRequest,
} from '../../core/api-workbench/model'
import { importPostmanJson } from '../../core/api-workbench/import'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'

export const apiWorkbenchPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.api-workbench',
    name: 'API Workbench',
    description: '全局 HTTP 请求工作台，支持 Postman Collection 与 Pre/Post Script。',
    version: '1.0.0',
    engine: { codexHarness: '^0.4.19' },
    supportedScopes: ['global'],
    permissions: ['network:http', 'filesystem:import', 'keychain:secrets'],
  },
  activate(ctx) {
    const service = ctx.services.get<ApiWorkbenchService>('harness.apiWorkbench')
    ctx.slots.conversationTabs.register({
      id: 'api-workbench',
      label: 'API',
      order: 35,
      icon: FlaskConical,
      hideComposer: true,
      render: () => <ApiWorkbenchTab service={service} />,
    })
  },
}

export const apiWorkbenchDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.api-workbench:default',
  pluginId: apiWorkbenchPlugin.manifest.id,
  scope: { kind: 'global' },
  enabled: true,
  config: {},
  createdAt: 0,
  updatedAt: 0,
}

type Selection = { kind: 'collection' | 'folder' | 'request'; id: string }
type RequestSection = 'params' | 'headers' | 'body' | 'pre' | 'post'
type ResponseSection = 'body' | 'headers' | 'tests' | 'console'

function ApiWorkbenchTab({ service }: { service: ApiWorkbenchService }) {
  const [state, setState] = useState<ApiWorkbenchState | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [requestSection, setRequestSection] = useState<RequestSection>('params')
  const [responseSection, setResponseSection] = useState<ResponseSection>('body')
  const [result, setResult] = useState<ApiExecutionResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const saveTimer = useRef<number | null>(null)
  const revision = useRef(0)

  useEffect(() => {
    let disposed = false
    void service.load().then((saved) => {
      if (disposed) return
      const next = saved ?? emptyWorkbenchState()
      setState(next)
      setSelection(next.selectedRequestId ? { kind: 'request', id: next.selectedRequestId } : null)
      setExpanded(new Set(next.collections.map((collection) => collection.id)))
      if (!saved) return service.save(next)
    }).catch((nextError) => { if (!disposed) setError(messageOf(nextError)) })
      .finally(() => { if (!disposed) setLoading(false) })
    return () => { disposed = true }
  }, [service])

  useEffect(() => {
    if (!state || !dirty) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    const savingRevision = revision.current
    saveTimer.current = window.setTimeout(() => {
      setSaving(true)
      void service.save(state)
        .then(() => { if (revision.current === savingRevision) setDirty(false) })
        .catch((nextError) => setError(messageOf(nextError)))
        .finally(() => setSaving(false))
    }, 450)
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current) }
  }, [dirty, service, state])

  const selectedRequest = state && selection?.kind === 'request'
    ? findRequestContext(state, selection.id)?.request ?? null
    : null
  const environment = state ? activeEnvironment(state) : null

  const update = (recipe: (current: ApiWorkbenchState) => ApiWorkbenchState) => {
    revision.current += 1
    setState((current) => current ? recipe(current) : current)
    setDirty(true)
    setError(null)
  }

  const run = async () => {
    if (!state || !selectedRequest) return
    setSending(true)
    setError(null)
    setResult(null)
    try {
      const { executeWorkbenchRequest } = await import('../../core/api-workbench/sandbox')
      const execution = await executeWorkbenchRequest(state, selectedRequest.id, service)
      revision.current += 1
      setState(execution.state)
      setResult(execution.result)
      setDirty(true)
      setResponseSection(execution.result.assertions.length ? 'tests' : 'body')
    } catch (nextError) {
      const detail = nextError as { logs?: ApiExecutionResult['logs']; assertions?: ApiExecutionResult['assertions'] }
      setError(messageOf(nextError))
      if (detail.logs?.length || detail.assertions?.length) setResponseSection('console')
    } finally {
      setSending(false)
    }
  }

  const importFile = async () => {
    if (!state) return
    try {
      const path = await service.chooseImportFile()
      if (!path) return
      const raw = await service.readImportFile(path)
      const next = importPostmanJson(raw, state)
      revision.current += 1
      setState(next)
      setSelection(next.selectedRequestId ? { kind: 'request', id: next.selectedRequestId } : null)
      setExpanded(new Set(next.collections.map((collection) => collection.id)))
      setDirty(true)
      setError(null)
    } catch (nextError) { setError(messageOf(nextError)) }
  }

  if (loading) return <div className="api-workbench-loading"><LoaderCircle className="spin" size={18} />加载全局 API 数据…</div>
  if (!state) return <div className="plugin-error">API Workbench 初始化失败：{error}</div>

  return (
    <div className="api-workbench">
      <header className="api-workbench-header">
        <div className="api-workbench-brand"><span><CircleDot size={13} /></span><div><strong>REQUEST LAB</strong><small>GLOBAL API WORKBENCH</small></div></div>
        <div className="api-workbench-global-tools">
          <label><span>ENV</span><select value={state.selectedEnvironmentId ?? ''} onChange={(event) => update((current) => ({ ...current, selectedEnvironmentId: event.target.value || null }))}>
            <option value="">No environment</option>
            {state.environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <button type="button" onClick={() => void importFile()}><Import size={14} />Import</button>
          <span className={`api-save-state ${dirty ? 'dirty' : ''}`}><Save size={12} />{saving ? 'Saving' : dirty ? 'Unsaved' : 'Saved'}</span>
        </div>
      </header>

      <div className="api-workbench-grid">
        <aside className="api-library">
          <div className="api-pane-heading"><div><span>LIBRARY</span><strong>Collections</strong></div><div>
            <button title="新建 Collection" onClick={() => update((current) => ({ ...current, collections: [...current.collections, createCollection('New collection')] }))}><Folder size={14} /></button>
            <button title="新建 Request" onClick={() => update((current) => {
              const next = appendRequest(current)
              if (next.selectedRequestId) setSelection({ kind: 'request', id: next.selectedRequestId })
              return next
            })}><Plus size={15} /></button>
          </div></div>
          <div className="api-tree">
            {state.collections.map((collection) => <CollectionTree key={collection.id} collection={collection} selection={selection} expanded={expanded} onExpanded={setExpanded} onSelect={(nextSelection) => {
              setSelection(nextSelection)
              if (nextSelection.kind === 'request') update((current) => ({ ...current, selectedRequestId: nextSelection.id }))
            }} />)}
          </div>
          <div className="api-library-foot"><span>{state.collections.length} collections</span><span>GLOBAL</span></div>
        </aside>

        <main className="api-request-pane">
          {selectedRequest ? (
            <RequestEditor
              request={selectedRequest}
              section={requestSection}
              sending={sending}
              result={result}
              responseSection={responseSection}
              onSection={setRequestSection}
              onResponseSection={setResponseSection}
              onChange={(request) => update((current) => replaceRequest(current, request))}
              onSend={() => void run()}
              onDelete={() => update((current) => {
                const next = removeRequest(current, selectedRequest.id)
                setSelection(next.selectedRequestId ? { kind: 'request', id: next.selectedRequestId } : null)
                return next
              })}
            />
          ) : selection ? (
            <ScopeScriptEditor state={state} selection={selection} onChange={update} />
          ) : (
            <div className="api-empty"><FlaskConical size={30} /><strong>Select a request</strong><p>Choose an API from the global library or import a Postman Collection.</p></div>
          )}
          {error && <div className="api-error"><XCircle size={14} />{error}<button onClick={() => setError(null)}>×</button></div>}
        </main>

        <aside className="api-environment-pane">
          <div className="api-pane-heading"><div><span>VARIABLES</span><strong>{environment?.name ?? 'No environment'}</strong></div><KeyRound size={15} /></div>
          {environment ? <VariableEditor values={environment.values} onChange={(values) => update((current) => ({
            ...current,
            environments: current.environments.map((item) => item.id === environment.id ? { ...item, values } : item),
          }))} /> : <div className="api-env-empty">Select an environment to resolve <code>{'{{variables}}'}</code>.</div>}
          <div className="api-environment-actions">
            <button onClick={() => update((current) => {
              const next = createEnvironment(`Environment ${current.environments.length + 1}`)
              return { ...current, environments: [...current.environments, next], selectedEnvironmentId: next.id }
            })}><Plus size={13} />New environment</button>
          </div>
        </aside>
      </div>
    </div>
  )
}

function CollectionTree({ collection, selection, expanded, onExpanded, onSelect }: {
  collection: ApiWorkbenchState['collections'][number]
  selection: Selection | null
  expanded: Set<string>
  onExpanded(value: Set<string>): void
  onSelect(value: Selection): void
}) {
  const open = expanded.has(collection.id)
  return <div className="api-tree-group">
    <div className={`api-tree-row collection ${selection?.id === collection.id ? 'selected' : ''}`}>
      <button className="api-tree-toggle" onClick={() => onExpanded(toggleSet(expanded, collection.id))}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
      <button className="api-tree-label" onClick={() => onSelect({ kind: 'collection', id: collection.id })}>{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span>{collection.name}</span></button>
    </div>
    {open && <div className="api-tree-children">{collection.items.map((item) => <TreeItem key={item.id} item={item} depth={0} selection={selection} expanded={expanded} onExpanded={onExpanded} onSelect={onSelect} />)}</div>}
  </div>
}

function TreeItem({ item, depth, selection, expanded, onExpanded, onSelect }: {
  item: ApiCollectionItem; depth: number; selection: Selection | null; expanded: Set<string>
  onExpanded(value: Set<string>): void; onSelect(value: Selection): void
}) {
  if (item.kind === 'request') return <button style={{ '--api-depth': depth } as CSSProperties} className={`api-tree-request ${selection?.id === item.id ? 'selected' : ''}`} onClick={() => onSelect({ kind: 'request', id: item.id })}>
    <MethodMark method={item.method} /><span>{item.name}</span>
  </button>
  const open = expanded.has(item.id)
  return <div>
    <div style={{ '--api-depth': depth } as CSSProperties} className={`api-tree-row folder ${selection?.id === item.id ? 'selected' : ''}`}>
      <button className="api-tree-toggle" onClick={() => onExpanded(toggleSet(expanded, item.id))}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>
      <button className="api-tree-label" onClick={() => onSelect({ kind: 'folder', id: item.id })}><Folder size={13} /><span>{item.name}</span></button>
    </div>
    {open && item.items.map((child) => <TreeItem key={child.id} item={child} depth={depth + 1} selection={selection} expanded={expanded} onExpanded={onExpanded} onSelect={onSelect} />)}
  </div>
}

function RequestEditor({ request, section, sending, result, responseSection, onSection, onResponseSection, onChange, onSend, onDelete }: {
  request: ApiRequestDefinition; section: RequestSection; sending: boolean; result: ApiExecutionResult | null; responseSection: ResponseSection
  onSection(value: RequestSection): void; onResponseSection(value: ResponseSection): void; onChange(value: ApiRequestDefinition): void; onSend(): void; onDelete(): void
}) {
  return <div className="api-request-editor">
    <div className="api-request-title"><input value={request.name} onChange={(event) => onChange({ ...request, name: event.target.value })} /><button title="删除请求" onClick={onDelete}><Trash2 size={14} /></button></div>
    <div className="api-address-bar">
      <select className={`method-${request.method.toLowerCase()}`} value={request.method} onChange={(event) => onChange({ ...request, method: event.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((method) => <option key={method}>{method}</option>)}</select>
      <input value={request.url} placeholder="https://api.example.com/v1/resource" spellCheck={false} onChange={(event) => onChange({ ...request, url: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSend() }} />
      <button className="api-send" disabled={sending || !request.url.trim()} onClick={onSend}>{sending ? <LoaderCircle className="spin" size={16} /> : <Send size={15} />}{sending ? 'Sending' : 'Send'}</button>
    </div>
    <nav className="api-editor-tabs">
      {(['params', 'headers', 'body', 'pre', 'post'] as RequestSection[]).map((value) => <button className={section === value ? 'active' : ''} key={value} onClick={() => onSection(value)}>{sectionLabel(value)}{scriptBadge(value, request)}</button>)}
    </nav>
    <section className="api-editor-section">
      {section === 'params' && <KeyValueEditor rows={request.query} keyPlaceholder="Query parameter" onChange={(query) => onChange({ ...request, query })} />}
      {section === 'headers' && <KeyValueEditor rows={request.headers} keyPlaceholder="Header" onChange={(headers) => onChange({ ...request, headers })} />}
      {section === 'body' && <BodyEditor request={request} onChange={onChange} />}
      {section === 'pre' && <ScriptEditor value={request.preScript} phase="PRE-REQUEST" onChange={(preScript) => onChange({ ...request, preScript })} />}
      {section === 'post' && <ScriptEditor value={request.postScript} phase="POST-RESPONSE" onChange={(postScript) => onChange({ ...request, postScript })} />}
    </section>
    <ResponsePanel result={result} section={responseSection} onSection={onResponseSection} />
  </div>
}

function BodyEditor({ request, onChange }: { request: ApiRequestDefinition; onChange(value: ApiRequestDefinition): void }) {
  return <div className="api-body-editor">
    <div className="api-body-mode">{(['none', 'raw', 'urlencoded'] as const).map((mode) => <button className={request.body.mode === mode ? 'active' : ''} onClick={() => onChange({ ...request, body: { ...request.body, mode } })} key={mode}>{mode}</button>)}</div>
    {request.body.mode === 'raw' && <><select value={request.body.contentType} onChange={(event) => onChange({ ...request, body: { ...request.body, contentType: event.target.value } })}><option>application/json</option><option>text/plain</option><option>application/xml</option></select><textarea spellCheck={false} value={request.body.raw} placeholder={'{\n  "key": "value"\n}'} onChange={(event) => onChange({ ...request, body: { ...request.body, raw: event.target.value } })} /></>}
    {request.body.mode === 'urlencoded' && <KeyValueEditor rows={request.body.rows} keyPlaceholder="Form field" onChange={(rows) => onChange({ ...request, body: { ...request.body, rows } })} />}
    {request.body.mode === 'none' && <div className="api-no-body">This request does not include a body.</div>}
  </div>
}

function KeyValueEditor({ rows, keyPlaceholder, onChange }: { rows: ApiKeyValue[]; keyPlaceholder: string; onChange(rows: ApiKeyValue[]): void }) {
  const update = (id: string, patch: Partial<ApiKeyValue>) => onChange(ensureTrailingRow(rows.map((row) => row.id === id ? { ...row, ...patch } : row)))
  return <div className="api-kv-table"><div className="api-kv-head"><span>ON</span><span>{keyPlaceholder.toUpperCase()}</span><span>VALUE</span><span /></div>{ensureTrailingRow(rows).map((row) => <div className="api-kv-row" key={row.id}>
    <input type="checkbox" checked={row.enabled} onChange={(event) => update(row.id, { enabled: event.target.checked })} />
    <input value={row.key} placeholder={keyPlaceholder} onChange={(event) => update(row.id, { key: event.target.value })} />
    <input value={row.value} placeholder="Value" onChange={(event) => update(row.id, { value: event.target.value })} />
    <button onClick={() => onChange(ensureTrailingRow(rows.filter((candidate) => candidate.id !== row.id)))}><Trash2 size={12} /></button>
  </div>)}</div>
}

function VariableEditor({ values, onChange }: { values: ApiVariable[]; onChange(values: ApiVariable[]): void }) {
  const rows = values.length === 0 || values.at(-1)?.key || values.at(-1)?.value ? [...values, createVariable()] : values
  const update = (id: string, patch: Partial<ApiVariable>) => {
    const next = rows.map((row) => row.id === id ? { ...row, ...patch } : row)
    onChange(next.filter((row, index) => row.key || row.value || index === next.length - 1))
  }
  return <div className="api-variable-list">{rows.map((row) => <div className="api-variable" key={row.id}>
    <div><input type="checkbox" checked={row.enabled} onChange={(event) => update(row.id, { enabled: event.target.checked })} /><input value={row.key} placeholder="variable" onChange={(event) => update(row.id, { key: event.target.value })} /></div>
    <div><input type={row.secret ? 'password' : 'text'} value={row.value} placeholder="value" onChange={(event) => update(row.id, { value: event.target.value })} /><button className={row.secret ? 'active' : ''} title="存入 Keychain" onClick={() => update(row.id, { secret: !row.secret })}><KeyRound size={12} /></button></div>
  </div>)}</div>
}

function ScriptEditor({ value, phase, onChange }: { value: string; phase: string; onChange(value: string): void }) {
  return <div className="api-script-editor"><header><div><Code2 size={14} /><strong>{phase}</strong></div><span>POSTMAN SANDBOX · 10s timeout</span></header><textarea spellCheck={false} value={value} placeholder={'// Example\npm.environment.set("token", "...");'} onChange={(event) => onChange(event.target.value)} /></div>
}

function ScopeScriptEditor({ state, selection, onChange }: { state: ApiWorkbenchState; selection: Selection; onChange(recipe: (current: ApiWorkbenchState) => ApiWorkbenchState): void }) {
  const scope = findScope(state, selection)
  const [phase, setPhase] = useState<'pre' | 'post'>('pre')
  if (!scope) return <div className="api-empty">Scope not found.</div>
  const update = (script: string) => onChange((current) => updateScope(current, selection, phase === 'pre' ? { preScript: script } : { postScript: script }))
  return <div className="api-scope-editor"><header><span>{selection.kind.toUpperCase()} SCRIPTS</span><input value={scope.name} onChange={(event) => onChange((current) => updateScope(current, selection, { name: event.target.value }))} /></header><nav><button className={phase === 'pre' ? 'active' : ''} onClick={() => setPhase('pre')}>Pre-request</button><button className={phase === 'post' ? 'active' : ''} onClick={() => setPhase('post')}>Post-response</button></nav><ScriptEditor phase={`${selection.kind.toUpperCase()} · ${phase === 'pre' ? 'PRE-REQUEST' : 'POST-RESPONSE'}`} value={phase === 'pre' ? scope.preScript : scope.postScript} onChange={update} /></div>
}

function ResponsePanel({ result, section, onSection }: { result: ApiExecutionResult | null; section: ResponseSection; onSection(value: ResponseSection): void }) {
  const formattedBody = useMemo(() => prettyBody(result?.response.body ?? ''), [result?.response.body])
  return <section className="api-response-panel"><header><nav>{(['body', 'headers', 'tests', 'console'] as ResponseSection[]).map((value) => <button className={section === value ? 'active' : ''} onClick={() => onSection(value)} key={value}>{value}{value === 'tests' && result ? ` ${result.assertions.length}` : ''}{value === 'console' && result ? ` ${result.logs.length}` : ''}</button>)}</nav>{result && <div className="api-response-metrics"><span className={result.response.status < 400 ? 'success' : 'failure'}>{result.response.status} {result.response.statusText}</span><span><Clock3 size={11} />{result.response.elapsedMs} ms</span><span>{formatBytes(result.response.sizeBytes)}</span></div>}</header><div className="api-response-content">
    {!result ? <div className="api-response-empty"><Send size={22} /><span>Send a request to inspect its response.</span></div> : section === 'body' ? <pre>{formattedBody}{result.response.truncated ? '\n\n… response truncated at 8 MB' : ''}</pre> : section === 'headers' ? <div className="api-response-headers">{result.response.headers.map((header, index) => <div key={`${header.key}-${index}`}><strong>{header.key}</strong><span>{header.value}</span></div>)}</div> : section === 'tests' ? <div className="api-tests">{result.assertions.length ? result.assertions.map((assertion, index) => <div key={`${assertion.name}-${index}`} className={assertion.passed ? 'passed' : 'failed'}>{assertion.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<span>{assertion.name}</span>{assertion.error && <small>{assertion.error}</small>}</div>) : <div className="api-response-empty">No assertions were registered.</div>}</div> : <div className="api-console">{result.logs.length ? result.logs.map((log, index) => <div key={index} className={log.level}><span>{log.source}</span><strong>{log.level}</strong><code>{log.message}</code></div>) : <div className="api-response-empty">No script output.</div>}</div>}
  </div></section>
}

function MethodMark({ method }: { method: string }) { return <em className={`api-method method-${method.toLowerCase()}`}>{method.slice(0, 3)}</em> }
function sectionLabel(value: RequestSection) { return value === 'pre' ? 'Pre-script' : value === 'post' ? 'Post-script' : value[0].toUpperCase() + value.slice(1) }
function scriptBadge(value: RequestSection, request: ApiRequestDefinition) {
  const hasScript = value === 'pre' ? Boolean(request.preScript.trim()) : value === 'post' ? Boolean(request.postScript.trim()) : false
  return hasScript ? <i /> : null
}
function toggleSet(current: Set<string>, id: string) { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next }
function prettyBody(value: string) { try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value } }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error) }

function findScope(state: ApiWorkbenchState, selection: Selection): { name: string; preScript: string; postScript: string } | null {
  if (selection.kind === 'collection') return state.collections.find((collection) => collection.id === selection.id) ?? null
  const visit = (items: ApiCollectionItem[]): ApiFolderDefinition | null => { for (const item of items) { if (item.kind === 'folder') { if (item.id === selection.id) return item; const nested = visit(item.items); if (nested) return nested } } return null }
  for (const collection of state.collections) { const found = visit(collection.items); if (found) return found }
  return null
}

function updateScope(state: ApiWorkbenchState, selection: Selection, patch: Partial<{ name: string; preScript: string; postScript: string }>): ApiWorkbenchState {
  if (selection.kind === 'collection') return { ...state, collections: state.collections.map((collection) => collection.id === selection.id ? { ...collection, ...patch } : collection), updatedAt: Date.now() }
  const visit = (items: ApiCollectionItem[]): ApiCollectionItem[] => items.map((item) => item.kind === 'folder' ? item.id === selection.id ? { ...item, ...patch } : { ...item, items: visit(item.items) } : item)
  return { ...state, collections: state.collections.map((collection) => ({ ...collection, items: visit(collection.items) })), updatedAt: Date.now() }
}
