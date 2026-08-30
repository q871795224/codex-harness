export interface ApiVariable {
  id: string
  key: string
  value: string
  enabled: boolean
  secret: boolean
}

export interface ApiKeyValue {
  id: string
  key: string
  value: string
  enabled: boolean
}

export interface ApiRequestBody {
  mode: 'none' | 'raw' | 'urlencoded'
  raw: string
  rows: ApiKeyValue[]
  contentType: string
}

export interface ApiRequestDefinition {
  kind: 'request'
  id: string
  name: string
  method: string
  url: string
  query: ApiKeyValue[]
  headers: ApiKeyValue[]
  body: ApiRequestBody
  preScript: string
  postScript: string
}

export interface ApiFolderDefinition {
  kind: 'folder'
  id: string
  name: string
  preScript: string
  postScript: string
  items: ApiCollectionItem[]
}

export type ApiCollectionItem = ApiRequestDefinition | ApiFolderDefinition

export interface ApiCollectionDefinition {
  id: string
  name: string
  preScript: string
  postScript: string
  variables: ApiVariable[]
  items: ApiCollectionItem[]
}

export interface ApiEnvironmentDefinition {
  id: string
  name: string
  values: ApiVariable[]
}

export interface ApiWorkbenchState {
  schemaVersion: 1
  collections: ApiCollectionDefinition[]
  environments: ApiEnvironmentDefinition[]
  globals: ApiVariable[]
  selectedEnvironmentId: string | null
  selectedRequestId: string | null
  updatedAt: number
}

export interface ApiSendInput {
  method: string
  url: string
  headers: Array<{ key: string; value: string; enabled: boolean }>
  body: string | null
  timeoutMs?: number
}

export interface ApiSendResponse {
  status: number
  statusText: string
  headers: Array<{ key: string; value: string; enabled: boolean }>
  body: string
  elapsedMs: number
  sizeBytes: number
  truncated: boolean
}

export interface ApiScriptLog {
  level: string
  message: string
  source: 'pre' | 'post'
}

export interface ApiAssertion {
  name: string
  passed: boolean
  skipped: boolean
  error: string | null
}

export interface ApiExecutionResult {
  request: ApiSendInput
  response: ApiSendResponse
  logs: ApiScriptLog[]
  assertions: ApiAssertion[]
  scriptError: string | null
}

export interface ApiWorkbenchService {
  load(): Promise<ApiWorkbenchState | null>
  save(state: ApiWorkbenchState): Promise<ApiWorkbenchState>
  send(input: ApiSendInput): Promise<ApiSendResponse>
  chooseImportFile(): Promise<string | null>
  readImportFile(path: string): Promise<string>
}
