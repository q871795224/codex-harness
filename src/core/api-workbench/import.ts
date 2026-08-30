import {
  createCollection, createEnvironment, createFolder, createId, createKeyValue, createVariable,
} from './model'
import type { ApiCollectionItem, ApiRequestDefinition, ApiWorkbenchState } from './types'

type UnknownRecord = Record<string, unknown>

export function importPostmanJson(raw: string, state: ApiWorkbenchState): ApiWorkbenchState {
  let document: unknown
  try { document = JSON.parse(raw) } catch { throw new Error('The selected file is not valid JSON.') }
  if (!isRecord(document)) throw new Error('The Postman file must contain a JSON object.')
  if (isRecord(document.info) && Array.isArray(document.item)) {
    const collection = importCollection(document)
    const requests = flattenImportedRequests(collection.items)
    return {
      ...state,
      collections: [...state.collections, collection],
      selectedRequestId: requests[0]?.id ?? state.selectedRequestId,
      updatedAt: Date.now(),
    }
  }
  if (Array.isArray(document.values)) {
    if (document._postman_variable_scope === 'globals') {
      return {
        ...state,
        globals: importVariables(document.values),
        updatedAt: Date.now(),
      }
    }
    const environment = createEnvironment(text(document.name) || 'Imported environment')
    environment.values = importVariables(document.values)
    return {
      ...state,
      environments: [...state.environments, environment],
      selectedEnvironmentId: environment.id,
      updatedAt: Date.now(),
    }
  }
  throw new Error('Unsupported Postman file. Export a Collection, Environment, or Globals JSON file.')
}

function importCollection(document: UnknownRecord) {
  const info = isRecord(document.info) ? document.info : {}
  const collection = createCollection(text(info.name) || 'Imported collection')
  collection.id = text(info._postman_id) || createId('collection')
  collection.variables = importVariables(document.variable)
  collection.preScript = scriptFor(document.event, 'prerequest')
  collection.postScript = scriptFor(document.event, 'test')
  collection.items = importItems(document.item)
  return collection
}

function importItems(value: unknown): ApiCollectionItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry): ApiCollectionItem[] => {
    if (!isRecord(entry)) return []
    if (Array.isArray(entry.item)) {
      const folder = createFolder(text(entry.name) || 'Folder')
      folder.id = text(entry.id) || folder.id
      folder.preScript = scriptFor(entry.event, 'prerequest')
      folder.postScript = scriptFor(entry.event, 'test')
      folder.items = importItems(entry.item)
      return [folder]
    }
    if (!isRecord(entry.request)) return []
    const request = entry.request
    const body = isRecord(request.body) ? request.body : {}
    const mode = text(body.mode)
    const imported: ApiRequestDefinition = {
      kind: 'request',
      id: text(entry.id) || createId('request'),
      name: text(entry.name) || 'Request',
      method: text(request.method) || 'GET',
      url: requestUrl(request.url),
      query: requestQuery(request.url),
      headers: importPairs(request.header),
      body: {
        mode: mode === 'urlencoded' ? 'urlencoded' : mode === 'raw' ? 'raw' : 'none',
        raw: text(body.raw),
        rows: importPairs(body.urlencoded),
        contentType: rawContentType(body),
      },
      preScript: scriptFor(entry.event, 'prerequest'),
      postScript: scriptFor(entry.event, 'test'),
    }
    return [imported]
  })
}

function requestUrl(value: unknown): string {
  if (typeof value === 'string') return value.split('?')[0]
  if (!isRecord(value)) return ''
  if (typeof value.raw === 'string') return value.raw.split('?')[0]
  return ''
}

function requestQuery(value: unknown) {
  if (typeof value === 'string') {
    const query = value.split('?')[1]
    if (!query) return [createKeyValue()]
    return [...new URLSearchParams(query).entries()].map(([key, entryValue]) => createKeyValue(key, entryValue)).concat(createKeyValue())
  }
  if (!isRecord(value)) return [createKeyValue()]
  return importPairs(value.query)
}

function importPairs(value: unknown) {
  if (!Array.isArray(value)) return [createKeyValue()]
  const rows = value.filter(isRecord).map((row) => ({
    id: text(row.id) || createId('pair'), key: text(row.key), value: text(row.value), enabled: row.disabled !== true,
  }))
  return [...rows, createKeyValue()]
}

function importVariables(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((variable) => ({
    ...createVariable(text(variable.key), text(variable.value), variable.type === 'secret'),
    id: text(variable.id) || createId('variable'),
    enabled: variable.enabled !== false,
  }))
}

function scriptFor(events: unknown, listen: string): string {
  if (!Array.isArray(events)) return ''
  const event = events.find((candidate) => isRecord(candidate) && candidate.listen === listen)
  if (!isRecord(event) || !isRecord(event.script)) return ''
  const exec = event.script.exec
  return Array.isArray(exec) ? exec.map(text).join('\n') : text(exec)
}

function rawContentType(body: UnknownRecord): string {
  const options = isRecord(body.options) ? body.options : {}
  const raw = isRecord(options.raw) ? options.raw : {}
  const language = text(raw.language)
  return language === 'json' ? 'application/json' : language === 'xml' ? 'application/xml' : 'text/plain'
}

function flattenImportedRequests(items: ApiCollectionItem[]): ApiRequestDefinition[] {
  return items.flatMap((item) => item.kind === 'request' ? [item] : flattenImportedRequests(item.items))
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string {
  return value == null ? '' : String(value)
}
