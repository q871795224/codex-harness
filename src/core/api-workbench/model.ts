import type {
  ApiCollectionDefinition,
  ApiCollectionItem,
  ApiEnvironmentDefinition,
  ApiFolderDefinition,
  ApiKeyValue,
  ApiRequestDefinition,
  ApiRequestExample,
  ApiVariable,
  ApiWorkbenchState,
} from './types'

export interface ApiRequestContext {
  collection: ApiCollectionDefinition
  folders: ApiFolderDefinition[]
  request: ApiRequestDefinition
}

export interface ApiVariableScope {
  label: string
  values: ApiVariable[]
}

export interface ApiVariableReference {
  key: string
  variable: ApiVariable | null
  scope: string | null
}

export function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function emptyWorkbenchState(): ApiWorkbenchState {
  const collection = createCollection('我的 API')
  const request = createRequest('新建请求')
  const environment = createEnvironment('local')
  collection.items.push(request)
  return {
    schemaVersion: 2,
    collections: [collection],
    environments: [environment],
    globals: [],
    selectedEnvironmentId: environment.id,
    selectedRequestId: request.id,
    updatedAt: Date.now(),
  }
}

const environmentOrder = ['live', 'test', 'local', 'liveish', 'mock', 'staging', 'test-blue', 'test-green'] as const
type CanonicalEnvironmentName = typeof environmentOrder[number]

export function createCollection(name: string): ApiCollectionDefinition {
  return { id: createId('collection'), name, favorite: false, preScript: '', postScript: '', variables: [], items: [] }
}

export function createFolder(name: string): ApiFolderDefinition {
  return { kind: 'folder', id: createId('folder'), name, favorite: false, preScript: '', postScript: '', items: [] }
}

export function createRequest(name: string): ApiRequestDefinition {
  return {
    kind: 'request', id: createId('request'), name, method: 'GET', url: '', query: [createKeyValue()],
    headers: [createKeyValue()], body: { mode: 'none', raw: '', rows: [createKeyValue()], contentType: 'application/json' },
    authorization: { type: 'none', token: '' }, description: '', examples: [], favorite: false,
    preScript: '', postScript: '',
  }
}

export function createEnvironment(name: string): ApiEnvironmentDefinition {
  return { id: createId('environment'), name, values: [createVariable()] }
}

export function createKeyValue(key = '', value = ''): ApiKeyValue {
  return { id: createId('pair'), key, value, enabled: true }
}

export function createVariable(key = '', value = ''): ApiVariable {
  return { id: createId('variable'), key, value, enabled: true }
}

export function removeLegacySecretVariables(state: ApiWorkbenchState): ApiWorkbenchState {
  let changed = false
  const clean = (values: ApiVariable[]) => values.flatMap((variable) => {
    const legacy = variable as ApiVariable & { secret?: boolean }
    if (legacy.secret === true) { changed = true; return [] }
    if (!Object.hasOwn(legacy, 'secret')) return [variable]
    changed = true
    const { secret: _secret, ...cleaned } = legacy
    return [cleaned]
  })
  const globals = clean(state.globals)
  const environments = state.environments.map((environment) => ({ ...environment, values: clean(environment.values) }))
  const collections = state.collections.map((collection) => ({ ...collection, variables: clean(collection.variables) }))
  return changed ? { ...state, globals, environments, collections, updatedAt: Date.now() } : state
}

export function migrateLegacyEnvironments(state: ApiWorkbenchState): ApiWorkbenchState {
  if (state.schemaVersion >= 2) return state

  const environments = new Map<CanonicalEnvironmentName, ApiEnvironmentDefinition>()
  const selectedTargets = new Map<string, CanonicalEnvironmentName>()
  const legacyScopes = new Map<string, Set<string>>()
  let selectedTarget: CanonicalEnvironmentName | null = null

  for (const environment of state.environments) {
    const canonicalName = canonicalEnvironmentName(environment.name)
    if (canonicalName) {
      selectedTargets.set(environment.id, canonicalName)
      environments.set(canonicalName, mergeEnvironment(environments.get(canonicalName), environment, canonicalName))
      continue
    }

    const target = legacyEnvironmentTarget(environment.name)
    if (!target) continue
    selectedTargets.set(environment.id, target.environment)
    const scope = legacyScopes.get(target.service) ?? new Set<string>()
    const values = environment.values.filter((variable) => variable.key).map((variable) => {
      scope.add(variable.key)
      return { ...variable, key: `${target.service}.${variable.key}` }
    })
    legacyScopes.set(target.service, scope)
    environments.set(target.environment, mergeEnvironmentValues(environments.get(target.environment), target.environment, values))
  }

  if (state.selectedEnvironmentId) selectedTarget = selectedTargets.get(state.selectedEnvironmentId) ?? null
  const orderedEnvironments = environmentOrder.flatMap((name) => environments.has(name) ? [environments.get(name)!] : [])
  const selectedEnvironmentId = selectedTarget
    ? environments.get(selectedTarget)?.id ?? null
    : orderedEnvironments.find((environment) => environment.name === 'live')?.id ?? orderedEnvironments[0]?.id ?? null

  return {
    ...state,
    schemaVersion: 2,
    collections: state.collections.map((collection) => migrateLegacyCollection(collection, legacyScopes)),
    environments: orderedEnvironments,
    selectedEnvironmentId,
    updatedAt: Date.now(),
  }
}

function canonicalEnvironmentName(name: string): CanonicalEnvironmentName | null {
  const normalized = name.trim().toLowerCase()
  return environmentOrder.find((candidate) => candidate === normalized) ?? null
}

function legacyEnvironmentTarget(name: string): { environment: CanonicalEnvironmentName; service: string } | null {
  const normalized = name.trim().toLowerCase().replaceAll('_', '-').replace(/\s+/g, '-')
  const suffixes: Array<[string, CanonicalEnvironmentName]> = [
    ['-test-green', 'test-green'], ['-green-test', 'test-green'], ['-test-blue', 'test-blue'], ['-blue-test', 'test-blue'],
    ['-liveish-test', 'liveish'], ['-localhost', 'local'], ['-liveish', 'liveish'], ['-staging', 'staging'],
    ['-local', 'local'], ['-mock', 'mock'], ['-live', 'live'], ['-test', 'test'], ['-benchmark', 'test'],
  ]
  for (const [suffix, environment] of suffixes) {
    if (!normalized.endsWith(suffix)) continue
    const service = normalized.slice(0, -suffix.length).replace(/^-+|-+$/g, '')
    return service ? { environment, service } : null
  }
  return null
}

function mergeEnvironment(current: ApiEnvironmentDefinition | undefined, incoming: ApiEnvironmentDefinition, name: CanonicalEnvironmentName): ApiEnvironmentDefinition {
  if (!current) return { ...incoming, name }
  return { ...current, values: mergeVariables(current.values, incoming.values) }
}

function mergeEnvironmentValues(current: ApiEnvironmentDefinition | undefined, name: CanonicalEnvironmentName, values: ApiVariable[]): ApiEnvironmentDefinition {
  return current
    ? { ...current, values: mergeVariables(current.values, values) }
    : { id: createId('environment'), name, values }
}

function mergeVariables(current: ApiVariable[], incoming: ApiVariable[]): ApiVariable[] {
  const merged = current.filter((variable) => variable.key)
  for (const variable of incoming.filter((candidate) => candidate.key)) {
    const index = merged.findIndex((candidate) => candidate.key === variable.key)
    if (index >= 0) merged[index] = variable
    else merged.push(variable)
  }
  return merged
}

function migrateLegacyCollection(collection: ApiCollectionDefinition, scopes: Map<string, Set<string>>): ApiCollectionDefinition {
  const service = [...scopes.keys()].find((candidate) => comparableServiceName(candidate) === comparableServiceName(collection.name))
  if (!service || !collectionUsesVariable(collection.items, 'api')) return collection
  const keys = scopes.get(service)!
  const migrate = (value: string) => value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key: string) => keys.has(key.trim()) ? `{{${service}.${key.trim()}}}` : match)
  const migrateRows = (rows: ApiKeyValue[]) => rows.map((row) => ({ ...row, key: migrate(row.key), value: migrate(row.value) }))
  const migrateBody = (body: ApiRequestDefinition['body']) => ({ ...body, raw: migrate(body.raw), rows: migrateRows(body.rows) })
  const migrateItems = (items: ApiCollectionItem[]): ApiCollectionItem[] => items.map((item) => item.kind === 'folder'
    ? { ...item, preScript: migrate(item.preScript), postScript: migrate(item.postScript), items: migrateItems(item.items) }
    : {
      ...item,
      url: migrate(item.url),
      query: migrateRows(item.query),
      headers: migrateRows(item.headers),
      body: migrateBody(item.body),
      authorization: item.authorization ? { ...item.authorization, token: migrate(item.authorization.token) } : undefined,
      examples: item.examples?.map((example) => ({ ...example, query: migrateRows(example.query), headers: migrateRows(example.headers), body: migrateBody(example.body) })),
      preScript: migrate(item.preScript),
      postScript: migrate(item.postScript),
    })
  return { ...collection, items: migrateItems(collection.items) }
}

function comparableServiceName(name: string): string {
  return name.toLowerCase().replace(/\bapi\b/g, '').replace(/[^a-z0-9]/g, '')
}

function collectionUsesVariable(items: ApiCollectionItem[], key: string): boolean {
  const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`)
  return items.some((item) => item.kind === 'folder'
    ? collectionUsesVariable(item.items, key)
    : [item.url, item.authorization?.token ?? '', item.body.raw, ...item.query.flatMap((row) => [row.key, row.value]), ...item.headers.flatMap((row) => [row.key, row.value])].some((value) => pattern.test(value)))
}

export function findRequestContext(state: ApiWorkbenchState, requestId: string | null): ApiRequestContext | null {
  if (!requestId) return null
  for (const collection of state.collections) {
    const result = findInItems(collection.items, requestId, [])
    if (result) return { collection, ...result }
  }
  return null
}

function findInItems(items: ApiCollectionItem[], requestId: string, folders: ApiFolderDefinition[]): Pick<ApiRequestContext, 'folders' | 'request'> | null {
  for (const item of items) {
    if (item.kind === 'request' && item.id === requestId) return { request: item, folders }
    if (item.kind === 'folder') {
      const result = findInItems(item.items, requestId, [...folders, item])
      if (result) return result
    }
  }
  return null
}

export function allRequests(state: ApiWorkbenchState): ApiRequestDefinition[] {
  return state.collections.flatMap((collection) => flattenRequests(collection.items))
}

function flattenRequests(items: ApiCollectionItem[]): ApiRequestDefinition[] {
  return items.flatMap((item) => item.kind === 'request' ? [item] : flattenRequests(item.items))
}

export function replaceRequest(state: ApiWorkbenchState, request: ApiRequestDefinition): ApiWorkbenchState {
  return {
    ...state,
    collections: state.collections.map((collection) => ({ ...collection, items: replaceInItems(collection.items, request) })),
    updatedAt: Date.now(),
  }
}

function replaceInItems(items: ApiCollectionItem[], request: ApiRequestDefinition): ApiCollectionItem[] {
  return items.map((item) => item.kind === 'request'
    ? item.id === request.id ? request : item
    : { ...item, items: replaceInItems(item.items, request) })
}

export function removeRequest(state: ApiWorkbenchState, requestId: string): ApiWorkbenchState {
  const collections = state.collections.map((collection) => ({ ...collection, items: removeFromItems(collection.items, requestId) }))
  const remaining = collections.flatMap((collection) => flattenRequests(collection.items))
  return { ...state, collections, selectedRequestId: remaining[0]?.id ?? null, updatedAt: Date.now() }
}

export function removeItem(state: ApiWorkbenchState, itemId: string): ApiWorkbenchState {
  return removeRequest(state, itemId)
}

export function removeCollection(state: ApiWorkbenchState, collectionId: string): ApiWorkbenchState {
  const collections = state.collections.filter((collection) => collection.id !== collectionId)
  const selectedStillExists = collections.some((collection) => flattenRequests(collection.items).some((request) => request.id === state.selectedRequestId))
  const selectedRequestId = selectedStillExists ? state.selectedRequestId : collections.flatMap((collection) => flattenRequests(collection.items))[0]?.id ?? null
  return { ...state, collections, selectedRequestId, updatedAt: Date.now() }
}

export function removeEnvironment(state: ApiWorkbenchState, environmentId: string): ApiWorkbenchState {
  const environments = state.environments.filter((environment) => environment.id !== environmentId)
  const selectedEnvironmentId = state.selectedEnvironmentId === environmentId
    ? environments[0]?.id ?? null
    : state.selectedEnvironmentId
  return { ...state, environments, selectedEnvironmentId, updatedAt: Date.now() }
}

function removeFromItems(items: ApiCollectionItem[], requestId: string): ApiCollectionItem[] {
  return items.filter((item) => item.id !== requestId).map((item) => item.kind === 'folder'
    ? { ...item, items: removeFromItems(item.items, requestId) }
    : item)
}

export function appendRequest(state: ApiWorkbenchState, parent?: { kind: 'collection' | 'folder'; id: string }): ApiWorkbenchState {
  const request = createRequest('新建请求')
  const target = parent ?? (state.collections[0] ? { kind: 'collection' as const, id: state.collections[0].id } : null)
  const collections = state.collections.length > 0
    ? state.collections.map((collection) => target?.kind === 'collection' && collection.id === target.id
      ? { ...collection, items: [...collection.items, request] }
      : { ...collection, items: target?.kind === 'folder' ? appendToFolder(collection.items, target.id, request) : collection.items })
    : [{ ...createCollection('我的 API'), items: [request] }]
  return { ...state, collections, selectedRequestId: request.id, updatedAt: Date.now() }
}

export function appendFolder(state: ApiWorkbenchState, parent?: { kind: 'collection' | 'folder'; id: string }): { state: ApiWorkbenchState; folder: ApiFolderDefinition } {
  const folder = createFolder('新建文件夹')
  const target = parent ?? (state.collections[0] ? { kind: 'collection' as const, id: state.collections[0].id } : null)
  const collections = state.collections.length > 0
    ? state.collections.map((collection) => target?.kind === 'collection' && collection.id === target.id
      ? { ...collection, items: [...collection.items, folder] }
      : { ...collection, items: target?.kind === 'folder' ? appendToFolder(collection.items, target.id, folder) : collection.items })
    : [{ ...createCollection('我的 API'), items: [folder] }]
  return { state: { ...state, collections, updatedAt: Date.now() }, folder }
}

function appendToFolder(items: ApiCollectionItem[], folderId: string, child: ApiCollectionItem): ApiCollectionItem[] {
  return items.map((item) => item.kind === 'folder'
    ? item.id === folderId ? { ...item, items: [...item.items, child] } : { ...item, items: appendToFolder(item.items, folderId, child) }
    : item)
}

export function createRequestExample(request: ApiRequestDefinition, name: string): ApiRequestExample {
  return {
    id: createId('example'), name,
    query: clonePairs(request.query), headers: clonePairs(request.headers), body: cloneBody(request.body),
  }
}

export function applyRequestExample(request: ApiRequestDefinition, example: ApiRequestExample): ApiRequestDefinition {
  return { ...request, query: clonePairs(example.query), headers: clonePairs(example.headers), body: cloneBody(example.body) }
}

export function requestToCurl(request: ApiRequestDefinition, variables: Record<string, string> = {}): string {
  const resolve = (value: string) => resolveVariables(value, variables)
  const query = request.query.filter((row) => row.enabled && row.key)
    .map((row) => `${encodeURIComponent(resolve(row.key))}=${encodeURIComponent(resolve(row.value))}`).join('&')
  const requestUrl = resolve(request.url)
  const url = query ? `${requestUrl}${requestUrl.includes('?') ? '&' : '?'}${query}` : requestUrl
  const headers = request.headers.filter((row) => row.enabled && row.key).map((row) => [resolve(row.key), resolve(row.value)] as const)
  if (request.authorization?.type === 'bearer' && request.authorization.token && !headers.some(([key]) => key.toLowerCase() === 'authorization')) {
    headers.push(['Authorization', `Bearer ${resolve(request.authorization.token)}`])
  }
  if (request.body.mode === 'raw' && request.body.contentType && !headers.some(([key]) => key.toLowerCase() === 'content-type')) {
    headers.push(['Content-Type', request.body.contentType])
  }
  const lines = [`curl --request ${request.method || 'GET'} ${shellQuote(url || 'https://api.example.com')}`]
  for (const [key, value] of headers) lines.push(`  --header ${shellQuote(`${key}: ${value}`)}`)
  if (request.body.mode === 'raw') lines.push(`  --data-raw ${shellQuote(resolve(request.body.raw))}`)
  if (request.body.mode === 'urlencoded') {
    for (const row of request.body.rows.filter((item) => item.enabled && item.key)) lines.push(`  --data-urlencode ${shellQuote(`${resolve(row.key)}=${resolve(row.value)}`)}`)
  }
  return lines.join(' \\\n')
}

function resolveVariables(value: string, variables: Record<string, string>): string {
  let current = value
  for (let depth = 0; depth < 10; depth += 1) {
    const next = replaceVariables(current, variables)
    if (next === current) return current
    current = next
  }
  return current
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function clonePairs(rows: ApiKeyValue[]): ApiKeyValue[] {
  return rows.map((row) => ({ ...row, id: createId('pair') }))
}

function cloneBody(body: ApiRequestDefinition['body']): ApiRequestDefinition['body'] {
  return { ...body, rows: clonePairs(body.rows) }
}

export function variableMap(...scopes: ApiVariable[][]): Record<string, string> {
  const output: Record<string, string> = {}
  for (const scope of scopes) {
    for (const variable of scope) if (variable.enabled && variable.key) output[variable.key] = variable.value
  }
  return output
}

export function replaceVariables(value: string, variables: Record<string, string>): string {
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, key: string) => Object.hasOwn(variables, key) ? variables[key] : match)
}

export function variableReferences(value: string, scopes: ApiVariableScope[]): ApiVariableReference[] {
  const keys = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((match) => match[1].trim())
  return [...new Set(keys)].map((key) => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const variable = scopes[index].values.find((candidate) => candidate.enabled && candidate.key === key)
      if (variable) return { key, variable, scope: scopes[index].label }
    }
    return { key, variable: null, scope: null }
  })
}

export function activeEnvironment(state: ApiWorkbenchState): ApiEnvironmentDefinition | null {
  return state.environments.find((environment) => environment.id === state.selectedEnvironmentId) ?? null
}

export function ensureTrailingRow(rows: ApiKeyValue[]): ApiKeyValue[] {
  const compact = rows.filter((row, index) => row.key || row.value || index === rows.length - 1)
  return compact.length === 0 || compact.at(-1)?.key || compact.at(-1)?.value ? [...compact, createKeyValue()] : compact
}
