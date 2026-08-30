import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import {
  Bookmark, Braces, CheckCircle2, ChevronDown, ChevronRight, ChevronsUpDown, CircleDot, Clock3,
  Code2, Copy, FileText, FlaskConical, Folder, FolderOpen, Globe2, Import, Layers3,
  LoaderCircle, Plus, Save, Send, Trash2, XCircle,
} from 'lucide-react'
import type {
  ApiCollectionItem, ApiExecutionResult, ApiFolderDefinition, ApiKeyValue, ApiRequestDefinition,
  ApiVariable, ApiWorkbenchService, ApiWorkbenchState,
} from '../../core/api-workbench/types'
import {
  activeEnvironment, appendFolder, appendRequest, applyRequestExample, createEnvironment, createRequestExample,
  createVariable, emptyWorkbenchState, ensureTrailingRow, findRequestContext, migrateLegacyEnvironments, removeCollection, removeEnvironment,
  removeItem, removeLegacySecretVariables, replaceRequest, requestToCurl, variableMap, variableReferences, type ApiVariableReference, type ApiVariableScope,
} from '../../core/api-workbench/model'
import { importPostmanJson } from '../../core/api-workbench/import'
import type { HarnessPlugin, PluginInstanceRecord } from '../../extensions/types'

export const apiWorkbenchPlugin: HarnessPlugin = {
  manifest: {
    schemaVersion: 1,
    id: 'builtin.api-workbench',
    name: 'API 工作台',
    description: '全局 HTTP 请求工作台，支持 Postman Collection 和前后置脚本。',
    version: '1.3.0',
    engine: { codexHarness: '^0.4.24' },
    supportedScopes: ['global'],
    permissions: ['network:http', 'filesystem:import'],
  },
  activate(ctx) {
    const service = ctx.services.get<ApiWorkbenchService>('harness.apiWorkbench')
    ctx.slots.conversationTabs.register({ id: 'api-workbench', label: 'API', order: 35, icon: FlaskConical, render: () => <ApiWorkbenchTab service={service} /> })
  },
}

export const apiWorkbenchDefaultInstance: PluginInstanceRecord = {
  instanceId: 'builtin.api-workbench:default', pluginId: apiWorkbenchPlugin.manifest.id,
  scope: { kind: 'global' }, enabled: true, config: {}, createdAt: 0, updatedAt: 0,
}

type Selection = { kind: 'collection' | 'folder' | 'request'; id: string }
type LibraryMode = 'collections' | 'environments'
type RequestSection = 'params' | 'authorization' | 'headers' | 'body' | 'pre'
type ResponseSection = 'body' | 'headers' | 'tests' | 'console'
type PendingDelete = { kind: 'collection' | 'folder' | 'request' | 'environment'; id: string; name: string }

function ApiWorkbenchTab({ service }: { service: ApiWorkbenchService }) {
  const [state, setState] = useState<ApiWorkbenchState | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [libraryMode, setLibraryMode] = useState<LibraryMode>('collections')
  const [environmentScope, setEnvironmentScope] = useState('globals')
  const [requestSection, setRequestSection] = useState<RequestSection>('params')
  const [responseSection, setResponseSection] = useState<ResponseSection>('body')
  const [result, setResult] = useState<ApiExecutionResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const saveTimer = useRef<number | null>(null)
  const revision = useRef(0)

  useEffect(() => {
    let disposed = false
    void service.load().then((saved) => {
      if (disposed) return
      const next = saved ? migrateLegacyEnvironments(removeLegacySecretVariables(saved)) : emptyWorkbenchState()
      setState(next)
      setSelection(next.selectedRequestId ? { kind: 'request', id: next.selectedRequestId } : null)
      setEnvironmentScope(next.selectedEnvironmentId ?? 'globals')
      setExpanded(new Set(next.collections.map((collection) => collection.id)))
      if (!saved || next !== saved) return service.save(next)
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

  const selectedContext = state && selection?.kind === 'request' ? findRequestContext(state, selection.id) : null
  const selectedRequest = selectedContext?.request ?? null
  const selectedEnvironment = state?.environments.find((item) => item.id === environmentScope) ?? null

  const update = (recipe: (current: ApiWorkbenchState) => ApiWorkbenchState) => {
    revision.current += 1
    setState((current) => current ? recipe(current) : current)
    setDirty(true); setError(null); setNotice(null)
  }

  const run = async () => {
    if (!state || !selectedRequest) return
    setSending(true); setError(null); setResult(null)
    try {
      const { executeWorkbenchRequest } = await import('../../core/api-workbench/sandbox')
      const execution = await executeWorkbenchRequest(state, selectedRequest.id, service)
      revision.current += 1
      setState(execution.state); setResult(execution.result); setDirty(true)
      setResponseSection(execution.result.assertions.length ? 'tests' : 'body')
    } catch (nextError) {
      const detail = nextError as { logs?: ApiExecutionResult['logs']; assertions?: ApiExecutionResult['assertions'] }
      setError(messageOf(nextError))
      if (detail.logs?.length || detail.assertions?.length) setResponseSection('console')
    } finally { setSending(false) }
  }

  const importFiles = async () => {
    if (!state) return
    try {
      const paths = await service.chooseImportFiles()
      if (!paths.length) return
      let next = state
      for (const path of paths) next = importPostmanJson(await service.readImportFile(path), next)
      revision.current += 1
      setState(next); setSelection(next.selectedRequestId ? { kind: 'request', id: next.selectedRequestId } : null)
      setExpanded(new Set(next.collections.map((collection) => collection.id)))
      setDirty(true); setError(null); setNotice(`已导入 ${paths.length} 个 Postman 文件。`)
    } catch (nextError) { setError(messageOf(nextError)) }
  }

  const selectTreeItem = (next: Selection) => {
    setSelection(next)
    if (next.kind === 'request') update((current) => ({ ...current, selectedRequestId: next.id }))
  }

  const createParent = state ? parentForSelection(state, selection) : null
  const createItem = (kind: 'folder' | 'request') => {
    setCreateMenuOpen(false)
    if (kind === 'request') {
      update((current) => {
        const next = appendRequest(current, createParent ?? undefined)
        if (next.selectedRequestId) setSelection({ kind: 'request', id: next.selectedRequestId })
        return next
      })
      return
    }
    update((current) => {
      const created = appendFolder(current, createParent ?? undefined)
      setSelection({ kind: 'folder', id: created.folder.id })
      setExpanded((currentExpanded) => new Set([...currentExpanded, ...(createParent ? [createParent.id] : []), created.folder.id]))
      return created.state
    })
  }

  const confirmDelete = () => {
    if (!pendingDelete) return
    update((current) => {
      if (pendingDelete.kind === 'collection') return resetSelectionAfterDelete(removeCollection(current, pendingDelete.id), setSelection)
      if (pendingDelete.kind === 'request' || pendingDelete.kind === 'folder') return resetSelectionAfterDelete(removeItem(current, pendingDelete.id), setSelection)
      const next = removeEnvironment(current, pendingDelete.id)
      setEnvironmentScope(next.selectedEnvironmentId ?? 'globals')
      return next
    })
    setPendingDelete(null)
  }

  if (loading) return <div className="api-workbench-loading"><LoaderCircle className="spin" size={18} />正在加载全局 API 数据…</div>
  if (!state) return <div className="plugin-error">API 工作台初始化失败：{error}</div>

  const variableScopes = selectedRequest ? requestVariableScopes(state, selectedRequest.id) : []
  const expandableIds = allExpandableIds(state)
  const allExpanded = expandableIds.length > 0 && expandableIds.every((id) => expanded.has(id))

  return <div className="api-workbench">
    <header className="api-workbench-header">
      <div className="api-workbench-brand"><span><CircleDot size={13} /></span><strong>API 工作台</strong></div>
      <div className="api-workbench-global-tools">
        <label><span>环境</span><select value={state.selectedEnvironmentId ?? ''} onChange={(event) => update((current) => ({ ...current, selectedEnvironmentId: event.target.value || null }))}>
          <option value="">不使用环境</option>{state.environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <button type="button" title="导入 Postman Collection、Environment 或 Globals JSON" onClick={() => void importFiles()}><Import size={14} />导入</button>
        <span className={`api-save-state ${dirty ? 'dirty' : ''}`}><Save size={12} />{saving ? '保存中' : dirty ? '未保存' : '已保存'}</span>
      </div>
    </header>

    <div className={`api-workbench-grid ${libraryMode === 'environments' ? 'environment-mode' : ''}`}>
      <aside className="api-library">
        <div className="api-pane-heading api-library-heading">
          <button className="api-library-mode-switch" title={`切换到 ${libraryMode === 'collections' ? 'Environments' : 'Collections'}`} onClick={() => setLibraryMode((mode) => mode === 'collections' ? 'environments' : 'collections')}>{libraryMode === 'collections' ? 'Collections' : 'Environments'}<ChevronsUpDown size={13} /></button>
          <div>{libraryMode === 'collections' ? <>
            <button title={allExpanded ? '一键收起所有目录' : '一键展开所有目录'} onClick={() => setExpanded(allExpanded ? new Set() : new Set(expandableIds))}><ChevronsUpDown size={14} /></button>
            <div className="api-create-menu-wrap"><button title="新建" onClick={() => setCreateMenuOpen((open) => !open)}><Plus size={15} /></button>{createMenuOpen && <div className="api-create-menu"><button onClick={() => createItem('folder')}><Folder size={13} />新建文件夹</button><button onClick={() => createItem('request')}><FileText size={13} />新建请求</button></div>}</div>
          </> : <button title="新建环境" onClick={() => {
            const environment = createEnvironment(`环境 ${state.environments.length + 1}`)
            setEnvironmentScope(environment.id)
            update((current) => ({ ...current, environments: [...current.environments, environment], selectedEnvironmentId: environment.id, updatedAt: Date.now() }))
          }}><Plus size={15} /></button>}</div>
        </div>
        {libraryMode === 'collections' ? <>
          <div className="api-tree">{favoriteFirst(state.collections).map((collection) => <CollectionTree key={collection.id} collection={collection} selection={selection} expanded={expanded} onExpanded={setExpanded} onSelect={selectTreeItem} onFavorite={() => update((current) => ({ ...current, collections: current.collections.map((item) => item.id === collection.id ? { ...item, favorite: !item.favorite } : item), updatedAt: Date.now() }))} onToggleItemFavorite={(itemId) => update((current) => patchFavoriteItem(current, collection.id, itemId))} onDelete={(kind, id, name) => setPendingDelete({ kind, id, name })} />)}</div>
          <div className="api-library-foot"><span>{state.collections.length} Collections</span><span>Global</span></div>
        </> : <EnvironmentList state={state} selected={environmentScope} onSelect={setEnvironmentScope} onActivate={(id) => update((current) => ({ ...current, selectedEnvironmentId: id, updatedAt: Date.now() }))} />}
      </aside>

      <main className="api-request-pane">
        {libraryMode === 'environments' ? <EnvironmentEditor scope={selectedEnvironment ? { kind: 'environment', value: selectedEnvironment } : { kind: 'globals', value: state.globals }} onChange={update} onDelete={(environment) => setPendingDelete({ kind: 'environment', id: environment.id, name: environment.name })} /> : selectedRequest && selectedContext ? <RequestEditor request={selectedRequest} path={[selectedContext.collection.name, ...selectedContext.folders.map((folder) => folder.name), selectedRequest.name]} section={requestSection} sending={sending} result={result} responseSection={responseSection} variableScopes={variableScopes} onSection={setRequestSection} onResponseSection={setResponseSection} onChange={(request) => update((current) => replaceRequest(current, request))} onSend={() => void run()} /> : selection ? <ScopeScriptEditor state={state} selection={selection} onChange={update} /> : <div className="api-empty"><FlaskConical size={30} /><strong>请选择一个请求</strong><p>从 Collections 中选择 API，或者导入 Postman Collection。</p></div>}
        {error && <div className="api-error"><XCircle size={14} />{error}<button onClick={() => setError(null)}>×</button></div>}
        {notice && <div className="api-notice"><CheckCircle2 size={14} />{notice}<button onClick={() => setNotice(null)}>×</button></div>}
      </main>

      {libraryMode === 'collections' && <RequestInspector request={selectedRequest} variableScopes={variableScopes} onChange={(request) => update((current) => replaceRequest(current, request))} onCopied={() => setNotice('cURL 已复制。')} onError={setError} />}
    </div>
    {pendingDelete && <ApiConfirmDialog pending={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={confirmDelete} />}
  </div>
}

function CollectionTree({ collection, selection, expanded, onExpanded, onSelect, onFavorite, onToggleItemFavorite, onDelete }: {
  collection: ApiWorkbenchState['collections'][number]; selection: Selection | null; expanded: Set<string>
  onExpanded(value: Set<string>): void; onSelect(value: Selection): void; onFavorite(): void; onToggleItemFavorite(id: string): void
  onDelete(kind: 'collection' | 'folder' | 'request', id: string, name: string): void
}) {
  const open = expanded.has(collection.id)
  return <div className="api-tree-group"><div className={`api-tree-row collection ${selection?.id === collection.id ? 'selected' : ''}`}>
    <button className="api-tree-toggle" onClick={() => onExpanded(toggleSet(expanded, collection.id))}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
    <button className="api-tree-label" onClick={() => onSelect({ kind: 'collection', id: collection.id })}>{open ? <FolderOpen size={14} /> : <Folder size={14} />}<span>{collection.name}</span></button>
    <TreeActions favorite={Boolean(collection.favorite)} name={collection.name} onFavorite={onFavorite} onDelete={() => onDelete('collection', collection.id, collection.name)} />
  </div>{open && <div className="api-tree-children">{favoriteFirst(collection.items).map((item) => <TreeItem key={item.id} item={item} depth={0} selection={selection} expanded={expanded} onExpanded={onExpanded} onSelect={onSelect} onFavorite={onToggleItemFavorite} onDelete={onDelete} />)}</div>}</div>
}

function TreeItem({ item, depth, selection, expanded, onExpanded, onSelect, onFavorite, onDelete }: {
  item: ApiCollectionItem; depth: number; selection: Selection | null; expanded: Set<string>
  onExpanded(value: Set<string>): void; onSelect(value: Selection): void; onFavorite(id: string): void
  onDelete(kind: 'folder' | 'request', id: string, name: string): void
}) {
  if (item.kind === 'request') return <div style={{ '--api-depth': depth } as CSSProperties} className={`api-tree-request ${selection?.id === item.id ? 'selected' : ''}`}><button className="api-tree-request-label" onClick={() => onSelect({ kind: 'request', id: item.id })}><MethodMark method={item.method} /><span>{item.name}</span></button><TreeActions favorite={Boolean(item.favorite)} name={item.name} onFavorite={() => onFavorite(item.id)} onDelete={() => onDelete('request', item.id, item.name)} /></div>
  const open = expanded.has(item.id)
  return <div><div style={{ '--api-depth': depth } as CSSProperties} className={`api-tree-row folder ${selection?.id === item.id ? 'selected' : ''}`}><button className="api-tree-toggle" onClick={() => onExpanded(toggleSet(expanded, item.id))}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button><button className="api-tree-label" onClick={() => onSelect({ kind: 'folder', id: item.id })}><Folder size={13} /><span>{item.name}</span></button><TreeActions favorite={Boolean(item.favorite)} name={item.name} onFavorite={() => onFavorite(item.id)} onDelete={() => onDelete('folder', item.id, item.name)} /></div>{open && favoriteFirst(item.items).map((child) => <TreeItem key={child.id} item={child} depth={depth + 1} selection={selection} expanded={expanded} onExpanded={onExpanded} onSelect={onSelect} onFavorite={onFavorite} onDelete={onDelete} />)}</div>
}

function TreeActions({ favorite, name, onFavorite, onDelete }: { favorite: boolean; name: string; onFavorite(): void; onDelete(): void }) {
  return <span className="api-tree-actions"><button className={favorite ? 'favorite active' : 'favorite'} title={favorite ? `取消收藏 ${name}` : `收藏 ${name}`} onClick={onFavorite}><Bookmark size={11} fill={favorite ? 'currentColor' : 'none'} /></button><button title={`删除 ${name}`} onClick={onDelete}><Trash2 size={11} /></button></span>
}

function RequestEditor({ request, path, section, sending, result, responseSection, variableScopes, onSection, onResponseSection, onChange, onSend }: {
  request: ApiRequestDefinition; path: string[]; section: RequestSection; sending: boolean; result: ApiExecutionResult | null; responseSection: ResponseSection; variableScopes: ApiVariableScope[]
  onSection(value: RequestSection): void; onResponseSection(value: ResponseSection): void; onChange(value: ApiRequestDefinition): void; onSend(): void
}) {
  const [examplesOpen, setExamplesOpen] = useState(false)
  return <div className="api-request-editor"><div className="api-request-title"><div className="api-request-path">{path.map((part, index) => <span key={`${part}-${index}`}>{index > 0 && <i>/</i>}{index === path.length - 1 ? <input aria-label="请求名称" value={request.name} onChange={(event) => onChange({ ...request, name: event.target.value })} /> : part}</span>)}</div></div><div className="api-address-bar"><select className={`method-${request.method.toLowerCase()}`} value={request.method} onChange={(event) => onChange({ ...request, method: event.target.value })}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((method) => <option key={method}>{method}</option>)}</select><VariableAwareInput value={request.url} scopes={variableScopes} placeholder="https://api.example.com/v1/resource" onChange={(url) => onChange({ ...request, url })} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSend() }} /><button className="api-send" disabled={sending || !request.url.trim()} onClick={onSend}>{sending ? <LoaderCircle className="spin" size={16} /> : <Send size={15} />}{sending ? '发送中' : '发送'}</button></div><nav className="api-editor-tabs"><div>{(['params', 'authorization', 'headers', 'body', 'pre'] as RequestSection[]).map((value) => <button className={section === value ? 'active' : ''} key={value} onClick={() => onSection(value)}>{sectionLabel(value)}{scriptBadge(value, request)}</button>)}</div><button className={examplesOpen ? 'api-examples-button active' : 'api-examples-button'} onClick={() => setExamplesOpen((open) => !open)}><Layers3 size={12} />Examples {request.examples?.length ? request.examples.length : ''}</button></nav><section className="api-editor-section">{section === 'params' && <KeyValueEditor rows={request.query} keyPlaceholder="参数名" scopes={variableScopes} onChange={(query) => onChange({ ...request, query })} />}{section === 'authorization' && <AuthorizationEditor request={request} scopes={variableScopes} onChange={onChange} />}{section === 'headers' && <KeyValueEditor rows={request.headers} keyPlaceholder="Header" scopes={variableScopes} onChange={(headers) => onChange({ ...request, headers })} />}{section === 'body' && <BodyEditor request={request} scopes={variableScopes} onChange={onChange} />}{section === 'pre' && <div className="api-script-stack"><ScriptEditor value={request.preScript} phase="Pre Scripts" onChange={(preScript) => onChange({ ...request, preScript })} /><ScriptEditor value={request.postScript} phase="Post Scripts" onChange={(postScript) => onChange({ ...request, postScript })} /></div>}</section><ResponsePanel result={result} section={responseSection} onSection={onResponseSection} />{examplesOpen && <ExamplesDrawer request={request} onChange={onChange} onClose={() => setExamplesOpen(false)} />}</div>
}

function AuthorizationEditor({ request, scopes, onChange }: { request: ApiRequestDefinition; scopes: ApiVariableScope[]; onChange(value: ApiRequestDefinition): void }) {
  const authorization = request.authorization ?? { type: 'none' as const, token: '' }
  return <div className="api-authorization-editor"><label><span>Type</span><select value={authorization.type} onChange={(event) => onChange({ ...request, authorization: { ...authorization, type: event.target.value as 'none' | 'bearer' } })}><option value="none">None</option><option value="bearer">Bearer Token</option></select></label>{authorization.type === 'bearer' && <label><span>Token</span><VariableAwareInput value={authorization.token} scopes={scopes} placeholder="{{access_token}}" onChange={(token) => onChange({ ...request, authorization: { type: 'bearer', token } })} /></label>}</div>
}

function ExamplesDrawer({ request, onChange, onClose }: { request: ApiRequestDefinition; onChange(value: ApiRequestDefinition): void; onClose(): void }) {
  const [name, setName] = useState(''); const examples = request.examples ?? []
  const save = () => { const nextName = name.trim() || `Example ${examples.length + 1}`; onChange({ ...request, examples: [...examples, createRequestExample(request, nextName)] }); setName('') }
  return <aside className="api-examples-drawer"><header><div><span>REQUEST EXAMPLES</span><strong>Examples</strong></div><button title="关闭" onClick={onClose}>×</button></header><div className="api-example-create"><input value={name} placeholder="Example 名称" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') save() }} /><button onClick={save}><Plus size={12} />保存当前请求</button></div><div className="api-example-list">{examples.length ? examples.map((example) => <div key={example.id}><button onClick={() => onChange(applyRequestExample(request, example))}><FileText size={13} /><span><strong>{example.name}</strong><small>{example.query.filter((row) => row.key).length} Params · {example.body.mode}</small></span></button><button title={`删除 ${example.name}`} onClick={() => onChange({ ...request, examples: examples.filter((item) => item.id !== example.id) })}><Trash2 size={11} /></button></div>) : <p>还没有 Example。保存当前请求后，可在这里快速切换 Params、Headers 和 Body。</p>}</div></aside>
}

function RequestInspector({ request, variableScopes, onChange, onCopied, onError }: { request: ApiRequestDefinition | null; variableScopes: ApiVariableScope[]; onChange(value: ApiRequestDefinition): void; onCopied(): void; onError(error: string): void }) {
  const curl = request ? requestToCurl(request, variableMap(...variableScopes.map((scope) => scope.values))) : ''
  const copy = async () => {
    const unresolved = [...curl.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1].trim())
    if (unresolved.length) { onError(`无法复制：请先配置变量 ${[...new Set(unresolved)].join('、')}。`); return }
    try { await navigator.clipboard.writeText(curl); onCopied() } catch (error) { onError(`复制失败：${messageOf(error)}`) }
  }
  return <aside className="api-inspector-pane"><section><header><div><span>CODE</span><strong>cURL</strong></div><button title="复制 cURL" disabled={!request} onClick={() => void copy()}><Copy size={13} />复制</button></header>{request ? <pre>{curl}</pre> : <div className="api-inspector-empty">选择请求后生成 cURL。</div>}</section><section className="api-request-details"><header><div><span>DETAILS</span><strong>详情</strong></div></header>{request ? <textarea value={request.description ?? ''} placeholder="记录请求用途、注意事项或调用说明…" onChange={(event) => onChange({ ...request, description: event.target.value })} /> : <div className="api-inspector-empty">选择请求后编辑详情。</div>}</section></aside>
}

function EnvironmentList({ state, selected, onSelect, onActivate }: { state: ApiWorkbenchState; selected: string; onSelect(id: string): void; onActivate(id: string): void }) {
  return <div className="api-environment-list"><button className={selected === 'globals' ? 'selected' : ''} onClick={() => onSelect('globals')}><Globe2 size={14} /><span><strong>Globals</strong><small>{state.globals.filter((item) => item.key).length} 个变量</small></span></button>{state.environments.map((environment) => <div key={environment.id} className={`api-environment-row ${selected === environment.id ? 'selected' : ''}`}><input type="radio" name="api-active-environment" aria-label={`启用 ${environment.name}`} checked={state.selectedEnvironmentId === environment.id} onChange={() => { onSelect(environment.id); onActivate(environment.id) }} /><button onClick={() => onSelect(environment.id)}><span><strong>{environment.name}</strong><small>{environment.values.filter((item) => item.key).length} 个变量</small></span></button></div>)}</div>
}

function EnvironmentEditor({ scope, onChange, onDelete }: { scope: { kind: 'globals'; value: ApiVariable[] } | { kind: 'environment'; value: ApiWorkbenchState['environments'][number] }; onChange(recipe: (current: ApiWorkbenchState) => ApiWorkbenchState): void; onDelete(environment: ApiWorkbenchState['environments'][number]): void }) {
  const environment = scope.kind === 'environment' ? scope.value : null; const values = scope.kind === 'globals' ? scope.value : scope.value.values
  const updateValues = (next: ApiVariable[]) => onChange((current) => scope.kind === 'globals' ? { ...current, globals: next, updatedAt: Date.now() } : { ...current, environments: current.environments.map((item) => item.id === scope.value.id ? { ...item, values: next } : item), updatedAt: Date.now() })
  return <div className="api-environment-editor"><header><div><span>{scope.kind === 'globals' ? 'GLOBAL VARIABLES' : 'ENVIRONMENT'}</span>{environment ? <input value={environment.name} aria-label="环境名称" onChange={(event) => onChange((current) => ({ ...current, environments: current.environments.map((item) => item.id === environment.id ? { ...item, name: event.target.value } : item), updatedAt: Date.now() }))} /> : <h2>Globals</h2>}</div>{environment && <button className="danger" onClick={() => onDelete(environment)}><Trash2 size={13} />删除环境</button>}</header><div className="api-environment-table"><div className="api-environment-table-head"><span>启用</span><span>变量名</span><span>值</span><span /></div><VariableEditor values={values} onChange={updateValues} table /></div></div>
}

function BodyEditor({ request, scopes, onChange }: { request: ApiRequestDefinition; scopes: ApiVariableScope[]; onChange(value: ApiRequestDefinition): void }) {
  const references = variableReferences(request.body.raw, scopes)
  return <div className="api-body-editor"><div className="api-body-mode">{(['none', 'raw', 'urlencoded'] as const).map((mode) => <button className={request.body.mode === mode ? 'active' : ''} onClick={() => onChange({ ...request, body: { ...request.body, mode } })} key={mode}>{bodyModeLabel(mode)}</button>)}</div>{request.body.mode === 'raw' && <><select value={request.body.contentType} onChange={(event) => onChange({ ...request, body: { ...request.body, contentType: event.target.value } })}><option>application/json</option><option>text/plain</option><option>application/xml</option></select>{references.length > 0 && <VariableReferenceStrip references={references} />}<textarea className={references.length ? 'has-variable-strip' : ''} spellCheck={false} value={request.body.raw} placeholder={'{\n  "key": "value"\n}'} onChange={(event) => onChange({ ...request, body: { ...request.body, raw: event.target.value } })} /></>}{request.body.mode === 'urlencoded' && <KeyValueEditor rows={request.body.rows} keyPlaceholder="表单字段" scopes={scopes} onChange={(rows) => onChange({ ...request, body: { ...request.body, rows } })} />}{request.body.mode === 'none' && <div className="api-no-body">此请求不包含 Body。</div>}</div>
}

function KeyValueEditor({ rows, keyPlaceholder, scopes, onChange }: { rows: ApiKeyValue[]; keyPlaceholder: string; scopes: ApiVariableScope[]; onChange(rows: ApiKeyValue[]): void }) {
  const update = (id: string, patch: Partial<ApiKeyValue>) => onChange(ensureTrailingRow(rows.map((row) => row.id === id ? { ...row, ...patch } : row)))
  return <div className="api-kv-table"><div className="api-kv-head"><span>启用</span><span>{keyPlaceholder}</span><span>值</span><span /></div>{ensureTrailingRow(rows).map((row) => <div className="api-kv-row" key={row.id}><input type="checkbox" checked={row.enabled} onChange={(event) => update(row.id, { enabled: event.target.checked })} /><VariableAwareInput value={row.key} scopes={scopes} placeholder={keyPlaceholder} onChange={(key) => update(row.id, { key })} /><VariableAwareInput value={row.value} scopes={scopes} placeholder="值" onChange={(value) => update(row.id, { value })} /><button title="删除此行" onClick={() => onChange(ensureTrailingRow(rows.filter((candidate) => candidate.id !== row.id)))}><Trash2 size={12} /></button></div>)}</div>
}

function VariableEditor({ values, onChange, table = false }: { values: ApiVariable[]; onChange(values: ApiVariable[]): void; table?: boolean }) {
  const rows = values.length === 0 || values.at(-1)?.key || values.at(-1)?.value ? [...values, createVariable()] : values
  const update = (id: string, patch: Partial<ApiVariable>) => { const next = rows.map((row) => row.id === id ? { ...row, ...patch } : row); onChange(next.filter((row, index) => row.key || row.value || index === next.length - 1)) }
  if (table) return <div className="api-variable-table-body">{rows.map((row) => <div className="api-variable-table-row" key={row.id}><input type="checkbox" checked={row.enabled} onChange={(event) => update(row.id, { enabled: event.target.checked })} /><input value={row.key} placeholder="变量名" onChange={(event) => update(row.id, { key: event.target.value })} /><input value={row.value} placeholder="变量值" onChange={(event) => update(row.id, { value: event.target.value })} /><button title="删除变量" onClick={() => onChange(rows.filter((candidate) => candidate.id !== row.id))}><Trash2 size={12} /></button></div>)}</div>
  return <div className="api-variable-list">{rows.map((row) => <div className="api-variable" key={row.id}><div><input type="checkbox" checked={row.enabled} onChange={(event) => update(row.id, { enabled: event.target.checked })} /><input value={row.key} placeholder="变量名" onChange={(event) => update(row.id, { key: event.target.value })} /><button title="删除变量" onClick={() => onChange(rows.filter((candidate) => candidate.id !== row.id))}><Trash2 size={12} /></button></div><div><input value={row.value} placeholder="变量值" onChange={(event) => update(row.id, { value: event.target.value })} /></div></div>)}</div>
}

function ScriptEditor({ value, phase, onChange }: { value: string; phase: string; onChange(value: string): void }) { return <div className="api-script-editor"><header><div><Code2 size={14} /><strong>{phase}</strong></div><span>POSTMAN SANDBOX · 10 秒超时</span></header><textarea spellCheck={false} value={value} placeholder={'// 示例\npm.environment.set("token", "...");'} onChange={(event) => onChange(event.target.value)} /></div> }

function ScopeScriptEditor({ state, selection, onChange }: { state: ApiWorkbenchState; selection: Selection; onChange(recipe: (current: ApiWorkbenchState) => ApiWorkbenchState): void }) {
  const scope = findScope(state, selection); const [phase, setPhase] = useState<'pre' | 'post'>('pre')
  if (!scope) return <div className="api-empty">找不到所选作用域。</div>
  const update = (script: string) => onChange((current) => updateScope(current, selection, phase === 'pre' ? { preScript: script } : { postScript: script }))
  const scopeLabel = selection.kind === 'collection' ? 'COLLECTION' : 'FOLDER'
  return <div className="api-scope-editor"><header><span>{scopeLabel} SCRIPTS</span><input value={scope.name} onChange={(event) => onChange((current) => updateScope(current, selection, { name: event.target.value }))} /></header><nav><button className={phase === 'pre' ? 'active' : ''} onClick={() => setPhase('pre')}>Pre Scripts</button><button className={phase === 'post' ? 'active' : ''} onClick={() => setPhase('post')}>Post Scripts</button></nav><ScriptEditor phase={`${scopeLabel} · ${phase === 'pre' ? 'Pre Scripts' : 'Post Scripts'}`} value={phase === 'pre' ? scope.preScript : scope.postScript} onChange={update} /></div>
}

function ResponsePanel({ result, section, onSection }: { result: ApiExecutionResult | null; section: ResponseSection; onSection(value: ResponseSection): void }) {
  const formattedBody = useMemo(() => prettyBody(result?.response.body ?? ''), [result?.response.body])
  return <section className="api-response-panel"><header><nav>{(['body', 'headers', 'tests', 'console'] as ResponseSection[]).map((value) => <button className={section === value ? 'active' : ''} onClick={() => onSection(value)} key={value}>{responseSectionLabel(value)}{value === 'tests' && result ? ` ${result.assertions.length}` : ''}{value === 'console' && result ? ` ${result.logs.length}` : ''}</button>)}</nav>{result && <div className="api-response-metrics"><span className={result.response.status < 400 ? 'success' : 'failure'}>{result.response.status} {result.response.statusText}</span><span><Clock3 size={11} />{result.response.elapsedMs} ms</span><span>{formatBytes(result.response.sizeBytes)}</span></div>}</header><div className="api-response-content">{!result ? <div className="api-response-empty"><Send size={22} /><span>发送请求后可在这里查看响应。</span></div> : section === 'body' ? <pre>{formattedBody}{result.response.truncated ? '\n\n… 响应超过 8 MB，已截断显示' : ''}</pre> : section === 'headers' ? <div className="api-response-headers">{result.response.headers.map((header, index) => <div key={`${header.key}-${index}`}><strong>{header.key}</strong><span>{header.value}</span></div>)}</div> : section === 'tests' ? <div className="api-tests">{result.assertions.length ? result.assertions.map((assertion, index) => <div key={`${assertion.name}-${index}`} className={assertion.passed ? 'passed' : 'failed'}>{assertion.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}<span>{assertion.name}</span>{assertion.error && <small>{assertion.error}</small>}</div>) : <div className="api-response-empty">Post Script 没有通过 pm.test() 注册断言。</div>}</div> : <div className="api-console">{result.logs.length ? result.logs.map((log, index) => <div key={index} className={log.level}><span>{log.source === 'pre' ? 'Pre' : 'Post'}</span><strong>{log.level}</strong><code>{log.message}</code></div>) : <div className="api-response-empty">脚本没有输出日志。</div>}</div>}</div></section>
}

function VariableAwareInput({ value, scopes, placeholder, onChange, onKeyDown }: { value: string; scopes: ApiVariableScope[]; placeholder: string; onChange(value: string): void; onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void }) {
  const inputRef = useRef<HTMLInputElement>(null); const [focused, setFocused] = useState(false); const references = variableReferences(value, scopes); const referenceMap = new Map(references.map((reference) => [reference.key, reference])); const parts = value.split(/(\{\{\s*[^{}]+?\s*\}\})/g); const overlaid = !focused && references.length > 0
  return <div className={`api-variable-aware ${overlaid ? 'overlaid' : ''}`}><input ref={inputRef} value={value} placeholder={placeholder} spellCheck={false} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} />{overlaid && <div className="api-variable-overlay" onMouseDown={() => inputRef.current?.focus()}>{parts.map((part, index) => { const match = part.match(/^\{\{\s*([^{}]+?)\s*\}\}$/); if (!match) return <span key={index}>{part}</span>; const reference = referenceMap.get(match[1].trim()); return reference ? <VariableReferenceBadge key={index} reference={reference} text={part} /> : <span key={index}>{part}</span> })}</div>}</div>
}

function VariableReferenceStrip({ references }: { references: ApiVariableReference[] }) { return <div className="api-body-variable-strip"><Braces size={12} /><span>变量</span>{references.map((reference) => <VariableReferenceBadge key={reference.key} reference={reference} text={`{{${reference.key}}}`} />)}</div> }
function VariableReferenceBadge({ reference, text }: { reference: ApiVariableReference; text: string }) { const value = reference.variable ? reference.variable.value || '（空值）' : '未找到变量'; return <span className={`api-variable-token ${reference.variable ? '' : 'unresolved'}`} title={`${reference.key} · ${reference.scope ?? '未解析'}\n${value}`}>{text}<span className="api-variable-tooltip"><strong>{reference.key}</strong><small>{reference.scope ?? '未解析'}</small><code>{value}</code></span></span> }

function ApiConfirmDialog({ pending, onCancel, onConfirm }: { pending: PendingDelete; onCancel(): void; onConfirm(): void }) {
  const typeLabel = pending.kind === 'collection' ? 'Collection' : pending.kind === 'environment' ? '环境' : pending.kind === 'folder' ? '文件夹' : '请求'
  return <div className="api-dialog-backdrop api-confirm-backdrop" role="presentation" onMouseDown={onCancel}><section className="api-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="api-confirm-title" onMouseDown={(event) => event.stopPropagation()}><div className="api-confirm-icon"><Trash2 size={18} /></div><div><h3 id="api-confirm-title">删除{typeLabel}？</h3><p>“{pending.name}”将从全局 API 数据中删除，此操作无法在应用内撤销。</p></div><footer><button onClick={onCancel}>取消</button><button className="danger" onClick={onConfirm}>确认删除</button></footer></section></div>
}

function MethodMark({ method }: { method: string }) { return <em className={`api-method method-${method.toLowerCase()}`}>{method.slice(0, 3)}</em> }
function sectionLabel(value: RequestSection) { return { params: 'Params', authorization: 'Authorization', headers: 'Headers', body: 'Body', pre: 'Pre Scripts' }[value] }
function responseSectionLabel(value: ResponseSection) { return { body: 'Resp', headers: 'Headers', tests: 'Tests', console: 'Console' }[value] }
function bodyModeLabel(value: ApiRequestDefinition['body']['mode']) { return { none: 'None', raw: 'Raw', urlencoded: 'x-www-form-urlencoded' }[value] }
function scriptBadge(value: RequestSection, request: ApiRequestDefinition) { return value === 'pre' && (request.preScript.trim() || request.postScript.trim()) ? <i /> : null }
function toggleSet(current: Set<string>, id: string) { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next }
function prettyBody(value: string) { try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value } }
function formatBytes(value: number) { return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB` }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error) }
function favoriteFirst<T extends { favorite?: boolean }>(items: T[]): T[] { return [...items].sort((left, right) => Number(Boolean(right.favorite)) - Number(Boolean(left.favorite))) }
function resetSelectionAfterDelete(state: ApiWorkbenchState, setSelection: (value: Selection | null) => void) { setSelection(state.selectedRequestId ? { kind: 'request', id: state.selectedRequestId } : null); return state }

function requestVariableScopes(state: ApiWorkbenchState, requestId: string): ApiVariableScope[] {
  const context = findRequestContext(state, requestId); const environment = activeEnvironment(state)
  return [{ label: '全局变量', values: state.globals }, ...(context ? [{ label: `Collection · ${context.collection.name}`, values: context.collection.variables }] : []), ...(environment ? [{ label: `环境 · ${environment.name}`, values: environment.values }] : [])]
}

function parentForSelection(state: ApiWorkbenchState, selection: Selection | null): { kind: 'collection' | 'folder'; id: string } | null {
  if (selection?.kind === 'collection' || selection?.kind === 'folder') return { kind: selection.kind, id: selection.id }
  if (selection?.kind === 'request') { const context = findRequestContext(state, selection.id); if (context) { const folder = context.folders.at(-1); return folder ? { kind: 'folder', id: folder.id } : { kind: 'collection', id: context.collection.id } } }
  return state.collections[0] ? { kind: 'collection', id: state.collections[0].id } : null
}

function allExpandableIds(state: ApiWorkbenchState): string[] { const visit = (items: ApiCollectionItem[]): string[] => items.flatMap((item) => item.kind === 'folder' ? [item.id, ...visit(item.items)] : []); return state.collections.flatMap((collection) => [collection.id, ...visit(collection.items)]) }

function findScope(state: ApiWorkbenchState, selection: Selection): { name: string; favorite?: boolean; preScript: string; postScript: string } | null {
  if (selection.kind === 'collection') return state.collections.find((collection) => collection.id === selection.id) ?? null
  const visit = (items: ApiCollectionItem[]): ApiFolderDefinition | null => { for (const item of items) { if (item.kind === 'folder') { if (item.id === selection.id) return item; const nested = visit(item.items); if (nested) return nested } } return null }
  for (const collection of state.collections) { const found = visit(collection.items); if (found) return found }
  return null
}

function updateScope(state: ApiWorkbenchState, selection: Selection, patch: Partial<{ name: string; favorite: boolean; preScript: string; postScript: string }>): ApiWorkbenchState {
  if (selection.kind === 'collection') return { ...state, collections: state.collections.map((collection) => collection.id === selection.id ? { ...collection, ...patch } : collection), updatedAt: Date.now() }
  const visit = (items: ApiCollectionItem[]): ApiCollectionItem[] => items.map((item) => item.kind === 'folder' ? item.id === selection.id ? { ...item, ...patch } : { ...item, items: visit(item.items) } : item)
  return { ...state, collections: state.collections.map((collection) => ({ ...collection, items: visit(collection.items) })), updatedAt: Date.now() }
}

function patchFavoriteItem(state: ApiWorkbenchState, collectionId: string, itemId: string): ApiWorkbenchState {
  const visit = (items: ApiCollectionItem[]): ApiCollectionItem[] => items.map((item) => item.id === itemId ? { ...item, favorite: !item.favorite } : item.kind === 'folder' ? { ...item, items: visit(item.items) } : item)
  return { ...state, collections: state.collections.map((collection) => collection.id === collectionId ? { ...collection, items: visit(collection.items) } : collection), updatedAt: Date.now() }
}
