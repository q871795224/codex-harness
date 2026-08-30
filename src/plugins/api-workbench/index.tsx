import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import {
  Braces, CheckCircle2, ChevronDown, ChevronRight, CircleDot, Clock3, Code2,
  FlaskConical, Folder, FolderOpen, Globe2, Import, KeyRound, LoaderCircle, Plus, Save, Send,
  Settings2, Trash2, X, XCircle,
} from 'lucide-react'
import type { ApiWorkbenchService, ApiCollectionItem, ApiExecutionResult, ApiFolderDefinition, ApiKeyValue, ApiRequestDefinition, ApiVariable, ApiWorkbenchState } from '../../core/api-workbench/types'
import {
  activeEnvironment, appendRequest, createCollection, createEnvironment, createKeyValue, createVariable,
  emptyWorkbenchState, ensureTrailingRow, findRequestContext, removeCollection, removeEnvironment,
  removeRequest, replaceRequest, variableReferences, type ApiVariableReference, type ApiVariableScope,
} from '../../core/api-workbench/model'
import { importPostmanJson } from '../../core/api-workbench/import'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'

export const apiWorkbenchPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.api-workbench',
    name: 'API 工作台',
    description: '全局 HTTP 请求工作台，支持 Postman Collection 和前后置脚本。',
    version: '1.1.0',
    engine: { codexHarness: '^0.4.22' },
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
type PendingDelete = { kind: 'collection' | 'request' | 'environment'; id: string; name: string }

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
  const [notice, setNotice] = useState<string | null>(null)
  const [environmentManagerOpen, setEnvironmentManagerOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
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
    setNotice(null)
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

  const importFiles = async () => {
    if (!state) return
    try {
      const paths = await service.chooseImportFiles()
      if (!paths.length) return
      let next = state
      for (const path of paths) next = importPostmanJson(await service.readImportFile(path), next)
      revision.current += 1
      setState(next)
      setSelection(next.selectedRequestId ? { kind: 'request', id: next.selectedRequestId } : null)
      setExpanded(new Set(next.collections.map((collection) => collection.id)))
      setDirty(true)
      setError(null)
      setNotice(`已导入 ${paths.length} 个 Postman 文件。`)
    } catch (nextError) { setError(messageOf(nextError)) }
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    update((current) => {
      if (pendingDelete.kind === 'collection') {
        const next = removeCollection(current, pendingDelete.id)
        setSelection(next.selectedRequestId ? { kind: 'request', id: next.selectedRequestId } : null)
        return next
      }
      if (pendingDelete.kind === 'request') {
        const next = removeRequest(current, pendingDelete.id)
        setSelection(next.selectedRequestId ? { kind: 'request', id: next.selectedRequestId } : null)
        return next
      }
      return removeEnvironment(current, pendingDelete.id)
    })
    setPendingDelete(null)
  }

  if (loading) return <div className="api-workbench-loading"><LoaderCircle className="spin" size={18} />正在加载全局 API 数据…</div>
  if (!state) return <div className="plugin-error">API 工作台初始化失败：{error}</div>

  const variableScopes = selectedRequest ? requestVariableScopes(state, selectedRequest.id) : []

  return (
    <div className="api-workbench">
      <header className="api-workbench-header">
        <div className="api-workbench-brand"><span><CircleDot size={13} /></span><div><strong>API 工作台</strong><small>全局请求库</small></div></div>
        <div className="api-workbench-global-tools">
          <label><span>环境</span><select value={state.selectedEnvironmentId ?? ''} onChange={(event) => update((current) => ({ ...current, selectedEnvironmentId: event.target.value || null }))}>
            <option value="">不使用环境</option>
            {state.environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <button type="button" title="统一管理环境与全局变量" onClick={() => setEnvironmentManagerOpen(true)}><Settings2 size={14} />环境管理</button>
          <button type="button" title="导入 Postman Collection、Environment 或 Globals JSON" onClick={() => void importFiles()}><Import size={14} />导入</button>
          <span className={`api-save-state ${dirty ? 'dirty' : ''}`}><Save size={12} />{saving ? '保存中' : dirty ? '未保存' : '已保存'}</span>
        </div>
      </header>

      <div className="api-workbench-grid">
        <aside className="api-library">
          <div className="api-pane-heading"><div><span>请求库</span><strong>Collections</strong></div><div>
            <button title="新建 Collection" onClick={() => update((current) => ({ ...current, collections: [...current.collections, createCollection('新建 Collection')] }))}><Folder size={14} /></button>
            <button title="新建请求" onClick={() => update((current) => {
              const next = appendRequest(current)
              if (next.selectedRequestId) setSelection({ kind: 'request', id: next.selectedRequestId })
              return next
            })}><Plus size={15} /></button>
          </div></div>
          <div className="api-tree">
            {state.collections.map((collection) => <CollectionTree key={collection.id} collection={collection} selection={selection} expanded={expanded} onExpanded={setExpanded} onSelect={(nextSelection) => {
              setSelection(nextSelection)
              if (nextSelection.kind === 'request') update((current) => ({ ...current, selectedRequestId: nextSelection.id }))
            }} onDelete={(collection) => setPendingDelete({ kind: 'collection', id: collection.id, name: collection.name })} />)}
          </div>
          <div className="api-library-foot"><span>{state.collections.length} 个 Collections</span><span>全局</span></div>
        </aside>

        <main className="api-request-pane">
          {selectedRequest ? (
            <RequestEditor
              request={selectedRequest}
              section={requestSection}
              sending={sending}
              result={result}
              responseSection={responseSection}
              variableScopes={variableScopes}
              onSection={setRequestSection}
              onResponseSection={setResponseSection}
              onChange={(request) => update((current) => replaceRequest(current, request))}
              onSend={() => void run()}
              onDelete={() => setPendingDelete({ kind: 'request', id: selectedRequest.id, name: selectedRequest.name })}
            />
          ) : selection ? (
            <ScopeScriptEditor state={state} selection={selection} onChange={update} />
          ) : (
            <div className="api-empty"><FlaskConical size={30} /><strong>请选择一个请求</strong><p>从全局请求库中选择 API，或者导入 Postman Collection。</p></div>
          )}
          {error && <div className="api-error"><XCircle size={14} />{error}<button onClick={() => setError(null)}>×</button></div>}
          {notice && <div className="api-notice"><CheckCircle2 size={14} />{notice}<button onClick={() => setNotice(null)}>×</button></div>}
        </main>

        <aside className="api-environment-pane">
          <div className="api-pane-heading"><div><span>环境变量</span><strong>{environment?.name ?? '未选择环境'}</strong></div><button title="管理环境与全局变量" onClick={() => setEnvironmentManagerOpen(true)}><Settings2 size={14} /></button></div>
          {environment ? <VariableEditor values={environment.values} onChange={(values) => update((current) => ({
            ...current,
            environments: current.environments.map((item) => item.id === environment.id ? { ...item, values } : item),
          }))} /> : <div className="api-env-empty">选择环境后即可解析 <code>{'{{变量}}'}</code>。</div>}
          <div className="api-environment-actions">
            <button onClick={() => setEnvironmentManagerOpen(true)}><Settings2 size={13} />统一管理环境</button>
          </div>
        </aside>
      </div>
      {environmentManagerOpen && <EnvironmentManagerDialog
        state={state}
        onChange={update}
        onDelete={(environment) => setPendingDelete({ kind: 'environment', id: environment.id, name: environment.name })}
        onClose={() => setEnvironmentManagerOpen(false)}
      />}
      {pendingDelete && <ApiConfirmDialog pending={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={confirmDelete} />}
    </div>
  )
}

function CollectionTree({ collection, selection, expanded, onExpanded, onSelect, onDelete }: {
  collection: ApiWorkbenchState['collections'][number]
  selection: Selection | null
  expanded: Set<string>
  onExpanded(value: Set<string>): void
  onSelect(value: Selection): void
  onDelete(value: ApiWorkbenchState['collections'][number]): void
}) {
  const open = expanded.has(collection.id)
  return <div className="api-tree-group">
    <div className={`api-tree-row collection ${selection?.id === collection.id ? 'selected' : ''}`}>
      <button className="api-tree-toggle" onClick={() => onExpanded(toggleSet(expanded, collection.id))}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
      <button className="api-tree-label" onClick={() => onSelect({ kind: 'collection', id: collection.id })}>{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span>{collection.name}</span></button>
      <button className="api-tree-delete" title={`删除 ${collection.name}`} onClick={() => onDelete(collection)}><Trash2 size={12} /></button>
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

function RequestEditor({ request, section, sending, result, responseSection, variableScopes, onSection, onResponseSection, onChange, onSend, onDelete }: {
  request: ApiRequestDefinition; section: RequestSection; sending: boolean; result: ApiExecutionResult | null; responseSection: ResponseSection
  variableScopes: ApiVariableScope[]
  onSection(value: RequestSection): void; onResponseSection(value: ResponseSection): void; onChange(value: ApiRequestDefinition): void; onSend(): void; onDelete(): void
}) {
  return <div className="api-request-editor">
    <div className="api-request-title"><input value={request.name} onChange={(event) => onChange({ ...request, name: event.target.value })} /><button title="删除请求" onClick={onDelete}><Trash2 size={14} /></button></div>
    <div className="api-address-bar">
      <select className={`method-${request.method.toLowerCase()}`} value={request.method} onChange={(event) => onChange({ ...request, method: event.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((method) => <option key={method}>{method}</option>)}</select>
      <VariableAwareInput value={request.url} scopes={variableScopes} placeholder="https://api.example.com/v1/resource" onChange={(url) => onChange({ ...request, url })} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSend() }} />
      <button className="api-send" disabled={sending || !request.url.trim()} onClick={onSend}>{sending ? <LoaderCircle className="spin" size={16} /> : <Send size={15} />}{sending ? '发送中' : '发送'}</button>
    </div>
    <nav className="api-editor-tabs">
      {(['params', 'headers', 'body', 'pre', 'post'] as RequestSection[]).map((value) => <button className={section === value ? 'active' : ''} key={value} onClick={() => onSection(value)}>{sectionLabel(value)}{scriptBadge(value, request)}</button>)}
    </nav>
    <section className="api-editor-section">
      {section === 'params' && <KeyValueEditor rows={request.query} keyPlaceholder="查询参数" scopes={variableScopes} onChange={(query) => onChange({ ...request, query })} />}
      {section === 'headers' && <KeyValueEditor rows={request.headers} keyPlaceholder="请求头" scopes={variableScopes} onChange={(headers) => onChange({ ...request, headers })} />}
      {section === 'body' && <BodyEditor request={request} scopes={variableScopes} onChange={onChange} />}
      {section === 'pre' && <ScriptEditor value={request.preScript} phase="前置脚本" onChange={(preScript) => onChange({ ...request, preScript })} />}
      {section === 'post' && <ScriptEditor value={request.postScript} phase="后置脚本" onChange={(postScript) => onChange({ ...request, postScript })} />}
    </section>
    <ResponsePanel result={result} section={responseSection} onSection={onResponseSection} />
  </div>
}

function BodyEditor({ request, scopes, onChange }: { request: ApiRequestDefinition; scopes: ApiVariableScope[]; onChange(value: ApiRequestDefinition): void }) {
  const references = variableReferences(request.body.raw, scopes)
  return <div className="api-body-editor">
    <div className="api-body-mode">{(['none', 'raw', 'urlencoded'] as const).map((mode) => <button className={request.body.mode === mode ? 'active' : ''} onClick={() => onChange({ ...request, body: { ...request.body, mode } })} key={mode}>{bodyModeLabel(mode)}</button>)}</div>
    {request.body.mode === 'raw' && <><select value={request.body.contentType} onChange={(event) => onChange({ ...request, body: { ...request.body, contentType: event.target.value } })}><option>application/json</option><option>text/plain</option><option>application/xml</option></select>{references.length > 0 && <VariableReferenceStrip references={references} />}<textarea className={references.length ? 'has-variable-strip' : ''} spellCheck={false} value={request.body.raw} placeholder={'{\n  "key": "value"\n}'} onChange={(event) => onChange({ ...request, body: { ...request.body, raw: event.target.value } })} /></>}
    {request.body.mode === 'urlencoded' && <KeyValueEditor rows={request.body.rows} keyPlaceholder="表单字段" scopes={scopes} onChange={(rows) => onChange({ ...request, body: { ...request.body, rows } })} />}
    {request.body.mode === 'none' && <div className="api-no-body">此请求不包含 Body。</div>}
  </div>
}

function KeyValueEditor({ rows, keyPlaceholder, scopes, onChange }: { rows: ApiKeyValue[]; keyPlaceholder: string; scopes: ApiVariableScope[]; onChange(rows: ApiKeyValue[]): void }) {
  const update = (id: string, patch: Partial<ApiKeyValue>) => onChange(ensureTrailingRow(rows.map((row) => row.id === id ? { ...row, ...patch } : row)))
  return <div className="api-kv-table"><div className="api-kv-head"><span>启用</span><span>{keyPlaceholder}</span><span>值</span><span /></div>{ensureTrailingRow(rows).map((row) => <div className="api-kv-row" key={row.id}>
    <input type="checkbox" checked={row.enabled} onChange={(event) => update(row.id, { enabled: event.target.checked })} />
    <VariableAwareInput value={row.key} scopes={scopes} placeholder={keyPlaceholder} onChange={(key) => update(row.id, { key })} />
    <VariableAwareInput value={row.value} scopes={scopes} placeholder="值" onChange={(value) => update(row.id, { value })} />
    <button title="删除此行" onClick={() => onChange(ensureTrailingRow(rows.filter((candidate) => candidate.id !== row.id)))}><Trash2 size={12} /></button>
  </div>)}</div>
}

function VariableEditor({ values, onChange }: { values: ApiVariable[]; onChange(values: ApiVariable[]): void }) {
  const rows = values.length === 0 || values.at(-1)?.key || values.at(-1)?.value ? [...values, createVariable()] : values
  const update = (id: string, patch: Partial<ApiVariable>) => {
    const next = rows.map((row) => row.id === id ? { ...row, ...patch } : row)
    onChange(next.filter((row, index) => row.key || row.value || index === next.length - 1))
  }
  return <div className="api-variable-list">{rows.map((row) => <div className="api-variable" key={row.id}>
    <div><input type="checkbox" checked={row.enabled} onChange={(event) => update(row.id, { enabled: event.target.checked })} /><input value={row.key} placeholder="变量名" onChange={(event) => update(row.id, { key: event.target.value })} /><button title="删除变量" onClick={() => onChange(rows.filter((candidate) => candidate.id !== row.id))}><Trash2 size={12} /></button></div>
    <div><input type={row.secret ? 'password' : 'text'} value={row.value} placeholder="变量值" onChange={(event) => update(row.id, { value: event.target.value })} /><button className={row.secret ? 'active' : ''} title={row.secret ? 'Secret 已存入 macOS Keychain' : '标记为 Secret 并存入 macOS Keychain'} onClick={() => update(row.id, { secret: !row.secret })}><KeyRound size={12} /></button></div>
  </div>)}</div>
}

function ScriptEditor({ value, phase, onChange }: { value: string; phase: string; onChange(value: string): void }) {
  return <div className="api-script-editor"><header><div><Code2 size={14} /><strong>{phase}</strong></div><span>POSTMAN SANDBOX · 10 秒超时</span></header><textarea spellCheck={false} value={value} placeholder={'// 示例\npm.environment.set("token", "...");'} onChange={(event) => onChange(event.target.value)} /></div>
}

function ScopeScriptEditor({ state, selection, onChange }: { state: ApiWorkbenchState; selection: Selection; onChange(recipe: (current: ApiWorkbenchState) => ApiWorkbenchState): void }) {
  const scope = findScope(state, selection)
  const [phase, setPhase] = useState<'pre' | 'post'>('pre')
  if (!scope) return <div className="api-empty">找不到所选作用域。</div>
  const update = (script: string) => onChange((current) => updateScope(current, selection, phase === 'pre' ? { preScript: script } : { postScript: script }))
  const scopeLabel = selection.kind === 'collection' ? 'COLLECTION' : '文件夹'
  return <div className="api-scope-editor"><header><span>{scopeLabel} 脚本</span><input value={scope.name} onChange={(event) => onChange((current) => updateScope(current, selection, { name: event.target.value }))} /></header><nav><button className={phase === 'pre' ? 'active' : ''} onClick={() => setPhase('pre')}>前置脚本</button><button className={phase === 'post' ? 'active' : ''} onClick={() => setPhase('post')}>后置脚本</button></nav><ScriptEditor phase={`${scopeLabel} · ${phase === 'pre' ? '前置脚本' : '后置脚本'}`} value={phase === 'pre' ? scope.preScript : scope.postScript} onChange={update} /></div>
}

function ResponsePanel({ result, section, onSection }: { result: ApiExecutionResult | null; section: ResponseSection; onSection(value: ResponseSection): void }) {
  const formattedBody = useMemo(() => prettyBody(result?.response.body ?? ''), [result?.response.body])
  return <section className="api-response-panel"><header><nav>{(['body', 'headers', 'tests', 'console'] as ResponseSection[]).map((value) => <button className={section === value ? 'active' : ''} onClick={() => onSection(value)} key={value}>{responseSectionLabel(value)}{value === 'tests' && result ? ` ${result.assertions.length}` : ''}{value === 'console' && result ? ` ${result.logs.length}` : ''}</button>)}</nav>{result && <div className="api-response-metrics"><span className={result.response.status < 400 ? 'success' : 'failure'}>{result.response.status} {result.response.statusText}</span><span><Clock3 size={11} />{result.response.elapsedMs} ms</span><span>{formatBytes(result.response.sizeBytes)}</span></div>}</header><div className="api-response-content">
    {!result ? <div className="api-response-empty"><Send size={22} /><span>发送请求后可在这里查看响应。</span></div> : section === 'body' ? <pre>{formattedBody}{result.response.truncated ? '\n\n… 响应超过 8 MB，已截断显示' : ''}</pre> : section === 'headers' ? <div className="api-response-headers">{result.response.headers.map((header, index) => <div key={`${header.key}-${index}`}><strong>{header.key}</strong><span>{header.value}</span></div>)}</div> : section === 'tests' ? <div className="api-tests">{result.assertions.length ? result.assertions.map((assertion, index) => <div key={`${assertion.name}-${index}`} className={assertion.passed ? 'passed' : 'failed'}>{assertion.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<span>{assertion.name}</span>{assertion.error && <small>{assertion.error}</small>}</div>) : <div className="api-response-empty">脚本没有注册断言。</div>}</div> : <div className="api-console">{result.logs.length ? result.logs.map((log, index) => <div key={index} className={log.level}><span>{log.source === 'pre' ? '前置' : '后置'}</span><strong>{log.level}</strong><code>{log.message}</code></div>) : <div className="api-response-empty">脚本没有输出日志。</div>}</div>}
  </div></section>
}

function VariableAwareInput({ value, scopes, placeholder, onChange, onKeyDown }: {
  value: string
  scopes: ApiVariableScope[]
  placeholder: string
  onChange(value: string): void
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const references = variableReferences(value, scopes)
  const referenceMap = new Map(references.map((reference) => [reference.key, reference]))
  const parts = value.split(/(\{\{\s*[^{}]+?\s*\}\})/g)
  const overlaid = !focused && references.length > 0
  return <div className={`api-variable-aware ${overlaid ? 'overlaid' : ''}`}>
    <input ref={inputRef} value={value} placeholder={placeholder} spellCheck={false} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} />
    {overlaid && <div className="api-variable-overlay" onMouseDown={() => inputRef.current?.focus()}>{parts.map((part, index) => {
      const match = part.match(/^\{\{\s*([^{}]+?)\s*\}\}$/)
      if (!match) return <span key={index}>{part}</span>
      const reference = referenceMap.get(match[1].trim())
      return reference ? <VariableReferenceBadge key={index} reference={reference} text={part} /> : <span key={index}>{part}</span>
    })}</div>}
  </div>
}

function VariableReferenceStrip({ references }: { references: ApiVariableReference[] }) {
  return <div className="api-body-variable-strip"><Braces size={12} /><span>变量</span>{references.map((reference) => <VariableReferenceBadge key={reference.key} reference={reference} text={`{{${reference.key}}}`} />)}</div>
}

function VariableReferenceBadge({ reference, text }: { reference: ApiVariableReference; text: string }) {
  const value = reference.variable ? reference.variable.secret ? '••••••••' : reference.variable.value || '（空值）' : '未找到变量'
  return <span className={`api-variable-token ${reference.variable ? '' : 'unresolved'}`} title={`${reference.key} · ${reference.scope ?? '未解析'}\n${value}`}>{text}<span className="api-variable-tooltip"><strong>{reference.key}</strong><small>{reference.scope ?? '未解析'}</small><code>{value}</code></span></span>
}

function EnvironmentManagerDialog({ state, onChange, onDelete, onClose }: {
  state: ApiWorkbenchState
  onChange(recipe: (current: ApiWorkbenchState) => ApiWorkbenchState): void
  onDelete(environment: ApiWorkbenchState['environments'][number]): void
  onClose(): void
}) {
  const [scopeKey, setScopeKey] = useState(state.selectedEnvironmentId ?? 'globals')
  const environment = state.environments.find((item) => item.id === scopeKey) ?? null
  const globalsSelected = scopeKey === 'globals' || !environment

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const updateVariables = (values: ApiVariable[]) => onChange((current) => globalsSelected
    ? { ...current, globals: values, updatedAt: Date.now() }
    : { ...current, environments: current.environments.map((item) => item.id === environment?.id ? { ...item, values } : item), updatedAt: Date.now() })

  const createNewEnvironment = () => {
    const next = createEnvironment(`环境 ${state.environments.length + 1}`)
    setScopeKey(next.id)
    onChange((current) => ({ ...current, environments: [...current.environments, next], selectedEnvironmentId: next.id, updatedAt: Date.now() }))
  }

  return <div className="api-dialog-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="api-environment-dialog" role="dialog" aria-modal="true" aria-labelledby="api-environment-title" onMouseDown={(event) => event.stopPropagation()}>
      <aside>
        <header><span>API 工作台</span><h2 id="api-environment-title">环境管理</h2></header>
        <nav>
          <button className={globalsSelected ? 'selected' : ''} onClick={() => setScopeKey('globals')}><Globe2 size={15} /><span><strong>全局变量</strong><small>{state.globals.filter((item) => item.key).length} 个变量</small></span></button>
          {state.environments.map((item) => <button key={item.id} className={environment?.id === item.id ? 'selected' : ''} onClick={() => setScopeKey(item.id)}><Braces size={15} /><span><strong>{item.name}</strong><small>{item.values.filter((value) => value.key).length} 个变量{state.selectedEnvironmentId === item.id ? ' · 当前' : ''}</small></span></button>)}
        </nav>
        <button className="api-add-environment" onClick={createNewEnvironment}><Plus size={14} />新建环境</button>
      </aside>
      <div className="api-environment-dialog-main">
        <header>
          <div><span>{globalsSelected ? 'GLOBAL VARIABLES' : 'ENVIRONMENT'}</span>{globalsSelected ? <h3>全局变量</h3> : <input aria-label="环境名称" value={environment?.name ?? ''} onChange={(event) => onChange((current) => ({ ...current, environments: current.environments.map((item) => item.id === environment?.id ? { ...item, name: event.target.value } : item), updatedAt: Date.now() }))} />}</div>
          <button className="api-dialog-close" aria-label="关闭环境管理" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="api-environment-dialog-actions">
          <p>{globalsSelected ? '所有 Collection 都可以访问这些变量。' : '选择此环境后，请求和脚本将优先使用这里的变量。'}</p>
          {!globalsSelected && environment && <div><button className="primary" disabled={state.selectedEnvironmentId === environment.id} onClick={() => onChange((current) => ({ ...current, selectedEnvironmentId: environment.id, updatedAt: Date.now() }))}>{state.selectedEnvironmentId === environment.id ? '当前环境' : '设为当前环境'}</button><button className="danger" onClick={() => onDelete(environment)}><Trash2 size={13} />删除环境</button></div>}
        </div>
        <div className="api-environment-variable-table"><VariableEditor values={globalsSelected ? state.globals : environment?.values ?? []} onChange={updateVariables} /></div>
      </div>
    </section>
  </div>
}

function ApiConfirmDialog({ pending, onCancel, onConfirm }: { pending: PendingDelete; onCancel(): void; onConfirm(): void }) {
  const typeLabel = pending.kind === 'collection' ? 'Collection' : pending.kind === 'environment' ? '环境' : '请求'
  return <div className="api-dialog-backdrop api-confirm-backdrop" role="presentation" onMouseDown={onCancel}>
    <section className="api-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="api-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="api-confirm-icon"><Trash2 size={18} /></div>
      <div><h3 id="api-confirm-title">删除{typeLabel}？</h3><p>“{pending.name}”将从全局 API 数据中删除，此操作无法在应用内撤销。</p></div>
      <footer><button onClick={onCancel}>取消</button><button className="danger" onClick={onConfirm}>确认删除</button></footer>
    </section>
  </div>
}

function MethodMark({ method }: { method: string }) { return <em className={`api-method method-${method.toLowerCase()}`}>{method.slice(0, 3)}</em> }
function sectionLabel(value: RequestSection) { return { params: '参数', headers: '请求头', body: 'Body', pre: '前置脚本', post: '后置脚本' }[value] }
function responseSectionLabel(value: ResponseSection) { return { body: '响应体', headers: '响应头', tests: '测试', console: '控制台' }[value] }
function bodyModeLabel(value: ApiRequestDefinition['body']['mode']) { return { none: '无', raw: '原始数据', urlencoded: '表单编码' }[value] }
function scriptBadge(value: RequestSection, request: ApiRequestDefinition) {
  const hasScript = value === 'pre' ? Boolean(request.preScript.trim()) : value === 'post' ? Boolean(request.postScript.trim()) : false
  return hasScript ? <i /> : null
}
function toggleSet(current: Set<string>, id: string) { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next }
function prettyBody(value: string) { try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value } }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error) }

function requestVariableScopes(state: ApiWorkbenchState, requestId: string): ApiVariableScope[] {
  const context = findRequestContext(state, requestId)
  const environment = activeEnvironment(state)
  return [
    { label: '全局变量', values: state.globals },
    ...(context ? [{ label: `Collection · ${context.collection.name}`, values: context.collection.variables }] : []),
    ...(environment ? [{ label: `环境 · ${environment.name}`, values: environment.values }] : []),
  ]
}

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
