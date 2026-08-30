import { describe, expect, it, vi } from 'vitest'
import { emptyWorkbenchState, findRequestContext, replaceVariables, variableMap } from './model'
import { importPostmanJson } from './import'

vi.stubGlobal('crypto', { randomUUID: () => `id-${Math.random()}` })

describe('API Workbench model', () => {
  it('resolves variables from later scopes first', () => {
    expect(variableMap(
      [{ id: 'g', key: 'host', value: 'global', enabled: true, secret: false }],
      [{ id: 'e', key: 'host', value: 'environment', enabled: true, secret: false }],
    )).toEqual({ host: 'environment' })
    expect(replaceVariables('https://{{host}}/{{missing}}', { host: 'api.test' }))
      .toBe('https://api.test/{{missing}}')
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
