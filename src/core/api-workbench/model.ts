import type {
  ApiCollectionDefinition,
  ApiCollectionItem,
  ApiEnvironmentDefinition,
  ApiFolderDefinition,
  ApiKeyValue,
  ApiRequestDefinition,
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
  const environment = createEnvironment('本地环境')
  collection.items.push(request)
  return {
    schemaVersion: 1,
    collections: [collection],
    environments: [environment],
    globals: [],
    selectedEnvironmentId: environment.id,
    selectedRequestId: request.id,
    updatedAt: Date.now(),
  }
}

export function createCollection(name: string): ApiCollectionDefinition {
  return { id: createId('collection'), name, preScript: '', postScript: '', variables: [], items: [] }
}

export function createFolder(name: string): ApiFolderDefinition {
  return { kind: 'folder', id: createId('folder'), name, preScript: '', postScript: '', items: [] }
}

export function createRequest(name: string): ApiRequestDefinition {
  return {
    kind: 'request', id: createId('request'), name, method: 'GET', url: '', query: [createKeyValue()],
    headers: [createKeyValue()], body: { mode: 'none', raw: '', rows: [createKeyValue()], contentType: 'application/json' },
    preScript: '', postScript: '',
  }
}

export function createEnvironment(name: string): ApiEnvironmentDefinition {
  return { id: createId('environment'), name, values: [createVariable()] }
}

export function createKeyValue(key = '', value = ''): ApiKeyValue {
  return { id: createId('pair'), key, value, enabled: true }
}

export function createVariable(key = '', value = '', secret = false): ApiVariable {
  return { id: createId('variable'), key, value, enabled: true, secret }
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

export function appendRequest(state: ApiWorkbenchState, collectionId?: string): ApiWorkbenchState {
  const request = createRequest('新建请求')
  const targetId = collectionId ?? state.collections[0]?.id
  const collections = state.collections.length > 0
    ? state.collections.map((collection) => collection.id === targetId ? { ...collection, items: [...collection.items, request] } : collection)
    : [{ ...createCollection('我的 API'), items: [request] }]
  return { ...state, collections, selectedRequestId: request.id, updatedAt: Date.now() }
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
