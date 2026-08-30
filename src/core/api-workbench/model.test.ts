import { describe, expect, it, vi } from 'vitest'
import {
  appendFolder, appendRequest, applyRequestExample, createRequestExample, emptyWorkbenchState,
  findRequestContext, removeCollection, removeEnvironment, removeItem, removeLegacySecretVariables, replaceVariables, requestToCurl,
  variableMap, variableReferences,
} from './model'
import { importPostmanJson } from './import'

vi.stubGlobal('crypto', { randomUUID: () => `id-${Math.random()}` })

describe('API Workbench model', () => {
  it('resolves variables from later scopes first', () => {
    expect(variableMap(
      [{ id: 'g', key: 'host', value: 'global', enabled: true }],
      [{ id: 'e', key: 'host', value: 'environment', enabled: true }],
    )).toEqual({ host: 'environment' })
    expect(replaceVariables('https://{{host}}/{{missing}}', { host: 'api.test' }))
      .toBe('https://api.test/{{missing}}')
  })

  it('describes referenced variables using the narrowest enabled scope', () => {
    const globals = [{ id: 'g', key: 'host', value: 'global.test', enabled: true }]
    const environment = [
      { id: 'e', key: 'host', value: 'environment.test', enabled: true },
      { id: 's', key: 'token', value: 'token-value', enabled: true },
    ]
    expect(variableReferences('https://{{host}}/{{ token }}/{{missing}}/{{host}}', [
      { label: '全局变量', values: globals },
      { label: '测试环境', values: environment },
    ])).toEqual([
      { key: 'host', variable: environment[0], scope: '测试环境' },
      { key: 'token', variable: environment[1], scope: '测试环境' },
      { key: 'missing', variable: null, scope: null },
    ])
  })

  it('removes collections and environments while keeping valid selections', () => {
    const state = emptyWorkbenchState()
    const selectedRequestId = state.selectedRequestId
    const selectedEnvironmentId = state.selectedEnvironmentId
    const withoutCollection = removeCollection(state, state.collections[0].id)
    expect(withoutCollection.collections).toEqual([])
    expect(withoutCollection.selectedRequestId).toBeNull()
    expect(selectedRequestId).not.toBeNull()

    const withoutEnvironment = removeEnvironment(state, state.environments[0].id)
    expect(withoutEnvironment.environments).toEqual([])
    expect(withoutEnvironment.selectedEnvironmentId).toBeNull()
    expect(selectedEnvironmentId).not.toBeNull()
  })

  it('removes legacy Secret variables and strips the old field', () => {
    const state = emptyWorkbenchState()
    state.environments[0].values = [
      { id: 'plain', key: 'host', value: 'api.test', enabled: true, secret: false },
      { id: 'legacy-secret', key: 'password', value: '', enabled: true, secret: true },
    ] as unknown as typeof state.environments[0]['values']

    expect(removeLegacySecretVariables(state).environments[0].values).toEqual([
      { id: 'plain', key: 'host', value: 'api.test', enabled: true },
    ])
  })

  it('creates nested folders and requests and removes an entire folder', () => {
    const initial = emptyWorkbenchState()
    const collection = initial.collections[0]
    const created = appendFolder(initial, { kind: 'collection', id: collection.id })
    const withRequest = appendRequest(created.state, { kind: 'folder', id: created.folder.id })
    const context = findRequestContext(withRequest, withRequest.selectedRequestId)

    expect(context?.folders.map((folder) => folder.id)).toEqual([created.folder.id])
    expect(removeItem(withRequest, created.folder.id).collections[0].items).not.toContainEqual(
      expect.objectContaining({ id: created.folder.id }),
    )
  })

  it('stores request examples as snapshots and generates Bearer cURL', () => {
    const state = emptyWorkbenchState()
    const request = findRequestContext(state, state.selectedRequestId)?.request
    if (!request) throw new Error('missing default request')
    request.method = 'POST'
    request.url = 'https://api.test/items'
    request.query = [{ id: 'query', key: 'limit', value: '10', enabled: true }]
    request.authorization = { type: 'bearer', token: '{{token}}' }
    request.body = { mode: 'raw', raw: '{"name":"one"}', rows: [], contentType: 'application/json' }
    const example = createRequestExample(request, 'Create one')
    request.query[0].value = '20'

    expect(applyRequestExample(request, example).query[0].value).toBe('10')
    expect(requestToCurl(request)).toContain("--header 'Authorization: Bearer {{token}}'")
    expect(requestToCurl(request)).toContain("--data-raw '{\"name\":\"one\"}'")
  })

  it('imports collection hierarchy and scripts', () => {
    const state = emptyWorkbenchState()
    const imported = importPostmanJson(JSON.stringify({
      info: { name: 'Auth APIs', _postman_id: 'collection-auth' },
      event: [{ listen: 'prerequest', script: { exec: ['pm.globals.set("x", "1")'] } }],
      variable: [{ key: 'base', value: 'https://api.test' }],
      item: [{
        id: 'folder-auth', name: 'Authentication',
        event: [{ listen: 'test', script: { exec: ['pm.test("folder", () => true)'] } }],
        item: [{
          id: 'request-login', name: 'Login',
          request: { method: 'POST', url: { raw: '{{base}}/login', query: [] }, header: [], body: { mode: 'raw', raw: '{}' } },
          event: [{ listen: 'test', script: { exec: ['pm.environment.set("token", pm.response.json().token)'] } }],
        }],
      }],
    }), state)
    const context = findRequestContext(imported, 'request-login')
    expect(context?.collection.preScript).toContain('pm.globals.set')
    expect(context?.folders[0].postScript).toContain('pm.test')
    expect(context?.request.postScript).toContain('pm.environment.set')
    expect(context?.request.url).toBe('{{base}}/login')
  })

  it('imports exported Postman globals into the global variable scope', () => {
    const state = emptyWorkbenchState()
    const imported = importPostmanJson(JSON.stringify({
      name: 'Globals',
      _postman_variable_scope: 'globals',
      values: [{ key: 'tenant', value: 'sg', enabled: true }],
    }), state)

    expect(imported.globals).toEqual([
      expect.objectContaining({ key: 'tenant', value: 'sg', enabled: true }),
    ])
    expect(imported.environments).toHaveLength(state.environments.length)
  })
})
