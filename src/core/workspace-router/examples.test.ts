import { beforeEach, expect, it, vi } from 'vitest'
import { textInput } from '../domain/codex'
import { runtime } from '../runtime/bridge'
import { appServer } from '../runtime/appServerClient'
import { routingExamples } from './examples'
vi.mock('../runtime/bridge', () => ({ runtime: { routerCorrections: vi.fn() } }))
vi.mock('../runtime/appServerClient', () => ({ appServer: { listTurns: vi.fn() } }))
const candidates = ['/dns-api', '/dns-agent'].map(root => ({ root, checkoutRoot: root, name: root.slice(1), description: '' }))
let id = 0
beforeEach(() => {
  vi.resetAllMocks(); id++
  vi.mocked(runtime.routerCorrections).mockResolvedValue([{ threadId: `source-${id}`, sourceTurnId: 'first', sourceMessageId: 'message', wrong: '/dns-agent', correct: '/dns-api' }])
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [{ id: 'first', items: [{ type: 'userMessage', clientId: 'message', content: [textInput('检查 DNS API 内存')] }] }] } as never)
})
it('uses a relevant explicit correction, resolving the exact source message through the provider', async () => {
  expect(await routingExamples([textInput('DNS API 的内存情况')], candidates)).toEqual([{ request: '检查 DNS API 内存', wrong: '/dns-agent', correct: '/dns-api' }])
  expect(appServer.listTurns).toHaveBeenCalledWith({ threadId: `source-${id}`, sortDirection: 'asc', limit: 1, itemsView: 'full' })
})
it('does not include unavailable workspaces or unrelated examples', async () => {
  expect(await routingExamples([textInput('写一个网页游戏')], candidates)).toEqual([])
  expect(await routingExamples([textInput('DNS API')], candidates.slice(1))).toEqual([])
})
it('does not substitute the wrong user message when the source cannot be resolved', async () => {
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [{ id: 'first', items: [{ type: 'userMessage', clientId: 'different', content: [textInput('DNS API')] }] }] } as never)
  expect(await routingExamples([textInput('DNS API')], candidates)).toEqual([])
})
it('skips image-dependent examples and tolerates missing provider history', async () => {
  vi.mocked(appServer.listTurns).mockResolvedValueOnce({ data: [{ id: 'first', items: [{ type: 'userMessage', clientId: 'message', content: [textInput('DNS API'), { type: 'localImage', path: '/image.png' }] }] }] } as never)
  expect(await routingExamples([textInput('DNS API')], candidates)).toEqual([])
  vi.mocked(appServer.listTurns).mockRejectedValueOnce(new Error('missing'))
  expect(await routingExamples([textInput('DNS API')], candidates)).toEqual([])
})
it('supports recent corrections even without keyword overlap and can disable examples entirely', async () => {
  expect(await routingExamples([textInput('写一个网页游戏')], candidates, { feedbackCount: 1, feedbackRule: 'recent' })).toEqual([{ request: '检查 DNS API 内存', wrong: '/dns-agent', correct: '/dns-api' }])
  vi.mocked(runtime.routerCorrections).mockClear()
  expect(await routingExamples([textInput('DNS API')], candidates, { feedbackCount: 0, feedbackRule: 'recent' })).toEqual([])
  expect(runtime.routerCorrections).not.toHaveBeenCalled()
})
it('honors a configured count above three and preserves recent-first ordering', async () => {
  vi.mocked(runtime.routerCorrections).mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({ threadId: `count-${id}-${i}`, sourceTurnId: 'first', sourceMessageId: 'message', wrong: '/dns-agent', correct: '/dns-api' })))
  vi.mocked(appServer.listTurns).mockImplementation(async params => ({ data: [{ id: 'first', items: [{ type: 'userMessage', clientId: 'message', content: [textInput(`DNS API case ${String(params.threadId).split('-').at(-1)}`)] }] }], nextCursor: null }) as never)
  const examples = await routingExamples([textInput('DNS API')], candidates, { feedbackCount: 5, feedbackRule: 'recent' })
  expect(examples.map(e => e.request)).toEqual(['DNS API case 0', 'DNS API case 1', 'DNS API case 2', 'DNS API case 3', 'DNS API case 4'])
})
