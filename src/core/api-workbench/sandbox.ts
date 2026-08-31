import { Buffer } from 'buffer'
import Sandbox from 'postman-sandbox'
import { Event as PostmanEvent, Request as PostmanRequest } from 'postman-collection'
import { activeEnvironment, createId, findRequestContext, replaceVariables } from './model'
import type {
  ApiAssertion,
  ApiExecutionResult,
  ApiKeyValue,
  ApiScriptLog,
  ApiSendInput,
  ApiSendResponse,
  ApiVariable,
  ApiWorkbenchService,
  ApiWorkbenchState,
} from './types'

interface SandboxScopeValue { key: string; value: unknown; disabled?: boolean; type?: string }
interface SandboxExecution {
  environment?: { values?: SandboxScopeValue[] }
  collectionVariables?: { values?: SandboxScopeValue[] }
  globals?: { values?: SandboxScopeValue[] }
  _variables?: { values?: SandboxScopeValue[] }
  request?: unknown
}

interface ScriptRunState {
  environment: SandboxScopeValue[]
  collectionVariables: SandboxScopeValue[]
  globals: SandboxScopeValue[]
  local: SandboxScopeValue[]
  request: unknown
}

export interface SandboxExecutionOptions {
  scriptTimeoutMs?: number
  maxSubrequests?: number
}

interface ScriptBudget {
  subrequests: number
  maxSubrequests: number
  limitReported: boolean
}

const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_SUBREQUESTS = 20

export async function executeWorkbenchRequest(
  state: ApiWorkbenchState,
  requestId: string,
  service: ApiWorkbenchService,
  options: SandboxExecutionOptions = {},
): Promise<{ state: ApiWorkbenchState; result: ApiExecutionResult }> {
  const context = findRequestContext(state, requestId)
  if (!context) throw new Error('找不到所选请求。')
  const environment = activeEnvironment(state)
  const logs: ApiScriptLog[] = []
  const assertions: ApiAssertion[] = []
  const scriptTimeoutMs = positiveLimit(options.scriptTimeoutMs, DEFAULT_SCRIPT_TIMEOUT_MS)
  const budget: ScriptBudget = {
    subrequests: 0,
    maxSubrequests: positiveLimit(options.maxSubrequests, DEFAULT_MAX_SUBREQUESTS),
    limitReported: false,
  }
  const sandbox = await createSandbox(scriptTimeoutMs)
  let scriptError: string | null = null
  let runState: ScriptRunState = {
    globals: scopeValues(state.globals),
    collectionVariables: scopeValues(context.collection.variables),
    environment: scopeValues(environment?.values ?? []),
    local: [],
    request: toPostmanRequest(context.request),
  }

  try {
    for (const script of [context.collection.preScript, ...context.folders.map((folder) => folder.preScript), context.request.preScript]) {
      if (!script.trim()) continue
      runState = await executeScript(sandbox, 'prerequest', script, runState, 'pre', service, logs, assertions, budget, scriptTimeoutMs)
    }
    const prepared = postmanRequestToSendInput(runState.request, runState)
    const response = await service.send(prepared)
    for (const script of [context.collection.postScript, ...context.folders.map((folder) => folder.postScript), context.request.postScript]) {
      if (!script.trim()) continue
      runState = await executeScript(sandbox, 'test', script, runState, 'post', service, logs, assertions, budget, scriptTimeoutMs, response)
    }
    const nextState = applyScopes(state, context.collection.id, environment?.id ?? null, runState)
    return { state: nextState, result: { request: prepared, response, logs, assertions, scriptError } }
  } catch (error) {
    scriptError = messageOf(error)
    throw Object.assign(new Error(scriptError), { logs, assertions })
  } finally {
    sandbox.dispose()
  }
}

async function createSandbox(timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    Sandbox.createContext({ timeout: timeoutMs, disableLegacyAPIs: false }, (error, context) => error ? reject(error) : resolve(context))
  })
}

async function executeScript(
  sandbox: any,
  listen: 'prerequest' | 'test',
  script: string,
  state: ScriptRunState,
  source: ApiScriptLog['source'],
  service: ApiWorkbenchService,
  logs: ApiScriptLog[],
  assertions: ApiAssertion[],
  budget: ScriptBudget,
  timeoutMs: number,
  response?: ApiSendResponse,
): Promise<ScriptRunState> {
  const id = createId('execution')
  const requestBeforeScript = new PostmanRequest(state.request).toJSON()
  const requestEvent = `execution.request.${id}`
  const errorEvent = `execution.error.${id}`
  const consoleHandler = (_cursor: unknown, level: string, ...args: unknown[]) => {
    logs.push({ level, message: args.map(formatLogValue).join(' '), source })
  }
  const assertionHandler = (_cursor: unknown, values: unknown) => {
    if (!Array.isArray(values)) return
    for (const value of values) {
      const assertion = value as Record<string, unknown>
      assertions.push({
        name: String(assertion.name ?? 'Assertion'),
        passed: assertion.passed === true,
        skipped: assertion.skipped === true,
        error: assertion.error ? formatLogValue(assertion.error) : null,
      })
    }
  }
  const errorHandler = (_cursor: unknown, error: unknown) => logs.push({ level: 'error', message: messageOf(error), source })
  const requestHandler = async (_cursor: unknown, _executionId: string, eventId: number, request: unknown) => {
    try {
      if (budget.subrequests >= budget.maxSubrequests) {
        const message = `脚本子请求超过单次运行上限（${budget.maxSubrequests}）。`
        if (!budget.limitReported) logs.push({ level: 'error', message, source })
        budget.limitReported = true
        throw new Error(message)
      }
      budget.subrequests += 1
      const input = postmanRequestToSendInput(request, state)
      const result = await service.send(input)
      sandbox.dispatch(`execution.response.${id}`, eventId, null, toPostmanResponse(result), {})
    } catch (error) {
      sandbox.dispatch(`execution.response.${id}`, eventId, { message: messageOf(error) }, null, {})
    }
  }
  sandbox.on('console', consoleHandler)
  sandbox.on('execution.assertion', assertionHandler)
  sandbox.on(errorEvent, errorHandler)
  sandbox.on(requestEvent, requestHandler)
  try {
    const result = await new Promise<SandboxExecution>((resolve, reject) => {
      sandbox.execute(
        new PostmanEvent({ listen, script: { type: 'text/javascript', exec: script.split('\n') } }),
        {
          id,
          timeout: timeoutMs,
          context: {
            environment: state.environment,
            collectionVariables: state.collectionVariables,
            globals: state.globals,
            _variables: state.local,
            request: state.request,
            ...(response ? { response: toPostmanResponse(response) } : {}),
          },
        },
        (error: Error | null, execution: SandboxExecution) => error ? reject(error) : resolve(execution),
      )
    })
    return {
      environment: result.environment?.values ?? state.environment,
      collectionVariables: result.collectionVariables?.values ?? state.collectionVariables,
      globals: result.globals?.values ?? state.globals,
      local: result._variables?.values ?? state.local,
      request: usableResultRequest(result.request, requestBeforeScript),
    }
  } finally {
    sandbox.off('console', consoleHandler)
    sandbox.off('execution.assertion', assertionHandler)
    sandbox.off(errorEvent, errorHandler)
    sandbox.off(requestEvent, requestHandler)
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback
}

function usableResultRequest(candidate: unknown, fallback: unknown): unknown {
  if (candidate === undefined || candidate === null) return fallback
  const next = new PostmanRequest(candidate)
  const previous = new PostmanRequest(fallback)
  return next.url.toString() || !previous.url.toString() ? next.toJSON() : fallback
}

function toPostmanRequest(request: { method: string; url: string; query: ApiKeyValue[]; headers: ApiKeyValue[]; authorization?: { type: 'none' | 'bearer'; token: string }; body: { mode: string; raw: string; rows: ApiKeyValue[]; contentType: string } }) {
  const query = request.query.filter((row) => row.enabled && row.key).map((row) => ({ key: row.key, value: row.value }))
  const header = request.headers.filter((row) => row.enabled && row.key).map((row) => ({ key: row.key, value: row.value }))
  if (request.authorization?.type === 'bearer' && request.authorization.token && !header.some((row) => row.key.toLowerCase() === 'authorization')) {
    header.push({ key: 'Authorization', value: `Bearer ${request.authorization.token}` })
  }
  if (request.body.mode === 'raw' && request.body.contentType && !header.some((row) => row.key.toLowerCase() === 'content-type')) {
    header.push({ key: 'Content-Type', value: request.body.contentType })
  }
  const result = new PostmanRequest({
    method: request.method,
    url: request.url,
    header,
    body: request.body.mode === 'raw'
      ? { mode: 'raw', raw: request.body.raw }
      : request.body.mode === 'urlencoded'
        ? { mode: 'urlencoded', urlencoded: request.body.rows.filter((row) => row.enabled && row.key).map((row) => ({ key: row.key, value: row.value })) }
        : undefined,
  })
  result.url.addQueryParams(query)
  return result.toJSON()
}

function postmanRequestToSendInput(value: unknown, scopes: ScriptRunState): ApiSendInput {
  const request = new PostmanRequest(value)
  const variables = Object.fromEntries([...scopes.globals, ...scopes.collectionVariables, ...scopes.environment, ...scopes.local]
    .filter((entry) => entry.disabled !== true && entry.key).map((entry) => [entry.key, String(entry.value ?? '')]))
  const headers = request.headers.toJSON().filter((header) => !header.disabled).map((header) => ({
    key: header.key, value: replaceVariables(header.value ?? '', variables), enabled: true,
  }))
  let body: string | null = null
  if (request.body?.mode === 'raw') body = replaceVariables(request.body.raw ?? '', variables)
  if (request.body?.mode === 'urlencoded') {
    body = new URLSearchParams(request.body.urlencoded?.toJSON().filter((row) => !row.disabled).map((row) => [
      replaceVariables(row.key, variables), replaceVariables(row.value ?? '', variables),
    ]) ?? []).toString()
    if (!headers.some((header) => header.key.toLowerCase() === 'content-type')) {
      headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true })
    }
  }
  return { method: request.method || 'GET', url: replaceVariables(request.url.toString(), variables), headers, body, timeoutMs: 30_000 }
}

function toPostmanResponse(response: ApiSendResponse) {
  return {
    code: response.status,
    status: response.statusText,
    header: response.headers.map((header) => ({ key: header.key, value: header.value })),
    stream: Buffer.from(response.body),
    responseTime: response.elapsedMs,
  }
}

function applyScopes(state: ApiWorkbenchState, collectionId: string, environmentId: string | null, scopes: ScriptRunState): ApiWorkbenchState {
  return {
    ...state,
    globals: mergeScope(state.globals, scopes.globals),
    collections: state.collections.map((collection) => collection.id === collectionId
      ? { ...collection, variables: mergeScope(collection.variables, scopes.collectionVariables) }
      : collection),
    environments: state.environments.map((environment) => environment.id === environmentId
      ? { ...environment, values: mergeScope(environment.values, scopes.environment) }
      : environment),
    updatedAt: Date.now(),
  }
}

function scopeValues(values: ApiVariable[]): SandboxScopeValue[] {
  return values.map((variable) => ({ key: variable.key, value: variable.value, disabled: !variable.enabled, type: 'any' }))
}

function mergeScope(existing: ApiVariable[], values: SandboxScopeValue[]): ApiVariable[] {
  return values.map((value) => {
    const current = existing.find((candidate) => candidate.key === value.key)
    return {
      id: current?.id ?? createId('variable'),
      key: value.key,
      value: String(value.value ?? ''),
      enabled: value.disabled !== true,
    }
  })
}

function formatLogValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try { return JSON.stringify(value) } catch { return String(value) }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}
