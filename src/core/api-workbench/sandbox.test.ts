import { describe, expect, it } from 'vitest'
import { emptyWorkbenchState, findRequestContext } from './model'
import { executeWorkbenchRequest } from './sandbox'
import type { ApiSendInput, ApiSendResponse, ApiWorkbenchService } from './types'

describe('API Workbench Postman sandbox', () => {
  it('adds Bearer authorization after resolving environment variables', async () => {
    const state = emptyWorkbenchState()
    const context = findRequestContext(state, state.selectedRequestId)
    if (!context) throw new Error('missing default request')
    context.request.url = 'https://api.test/profile'
    context.request.authorization = { type: 'bearer', token: '{{token}}' }
    state.environments[0].values = [{ id: 'token', key: 'token', value: 'secret-token', enabled: true }]
    const sent: ApiSendInput[] = []
    const service = {
      send: async (input: ApiSendInput): Promise<ApiSendResponse> => { sent.push(input); return response(200, '{}') },
    } as ApiWorkbenchService

    await executeWorkbenchRequest(state, context.request.id, service)

    expect(sent[0].url).toBe('https://api.test/profile')
    expect(sent[0].headers).toContainEqual({ key: 'Authorization', value: 'Bearer secret-token', enabled: true })
  })

  it('uses pm.sendRequest in pre-script to authenticate and validates the response in post-script', async () => {
    const state = emptyWorkbenchState()
    const context = findRequestContext(state, state.selectedRequestId)
    if (!context) throw new Error('missing default request')
    context.request.method = 'POST'
    context.request.url = 'https://api.test/profile'
    context.request.body = { mode: 'raw', raw: '{}', rows: [], contentType: 'application/json' }
    context.request.preScript = `
pm.sendRequest('https://auth.test/token', function (error, response) {
  if (error) { throw error; }
  const token = response.json().token;
  pm.environment.set('token', token);
  pm.request.headers.add({ key: 'Authorization', value: 'Bearer ' + token });
});`
    context.request.postScript = `
pm.test('response is successful', function () {
  pm.expect(pm.response.code).to.eql(200);
  pm.expect(pm.response.json().ok).to.eql(true);
});`

    const sent: ApiSendInput[] = []
    const service = {
      send: async (input: ApiSendInput): Promise<ApiSendResponse> => {
        sent.push(input)
        return input.url.includes('auth.test')
          ? response(200, '{"token":"secret-token"}')
          : response(200, '{"ok":true}')
      },
    } as ApiWorkbenchService

    const execution = await executeWorkbenchRequest(state, context.request.id, service)

    expect(sent).toHaveLength(2)
    expect(sent[1].headers).toContainEqual({ key: 'Authorization', value: 'Bearer secret-token', enabled: true })
    expect(sent[1].headers).toContainEqual({ key: 'Content-Type', value: 'application/json', enabled: true })
    expect(execution.state.environments[0].values).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'token', value: 'secret-token' }),
    ]))
    expect(execution.result.assertions).toContainEqual(expect.objectContaining({ name: 'response is successful', passed: true }))
  })

  it('interrupts a script that stops responding without blocking the test process', async () => {
    const state = emptyWorkbenchState()
    const context = findRequestContext(state, state.selectedRequestId)
    if (!context) throw new Error('missing default request')
    context.request.preScript = 'while (true) {}'
    const service = { send: async () => response(200, '{}') } as unknown as ApiWorkbenchService

    await expect(executeWorkbenchRequest(state, context.request.id, service, { scriptTimeoutMs: 25 }))
      .rejects.toThrow('sandbox not responding')
  }, 2_000)

  it('limits pm.sendRequest calls across one request execution', async () => {
    const state = emptyWorkbenchState()
    const context = findRequestContext(state, state.selectedRequestId)
    if (!context) throw new Error('missing default request')
    context.request.url = 'https://api.test/main'
    context.request.preScript = `
for (let index = 0; index < 4; index += 1) {
  pm.sendRequest('https://api.test/nested/' + index, function () {});
}`
    const sent: ApiSendInput[] = []
    const service = {
      send: async (input: ApiSendInput): Promise<ApiSendResponse> => {
        sent.push(input)
        return response(200, '{}')
      },
    } as ApiWorkbenchService

    const execution = await executeWorkbenchRequest(state, context.request.id, service, { maxSubrequests: 2 })

    expect(sent.map((input) => input.url)).toEqual([
      'https://api.test/nested/0',
      'https://api.test/nested/1',
      'https://api.test/main',
    ])
    expect(execution.result.logs).toContainEqual(expect.objectContaining({
      level: 'error',
      message: '脚本子请求超过单次运行上限（2）。',
    }))
  })
})

function response(status: number, body: string): ApiSendResponse {
  return {
    status,
    statusText: status === 200 ? 'OK' : '',
    headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
    body,
    elapsedMs: 3,
    sizeBytes: body.length,
    truncated: false,
  }
}
