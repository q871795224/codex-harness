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
it('prefers a shared workspace name over several common phrases when choosing corrections', async () => {
  vi.mocked(runtime.routerCorrections).mockResolvedValue([
    { threadId: `rank-common-${id}`, sourceTurnId: 'first', sourceMessageId: 'message', wrong: null, correct: '/dns-agent' },
    { threadId: `rank-project-${id}`, sourceTurnId: 'first', sourceMessageId: 'message', wrong: null, correct: '/dns-api' },
  ])
  vi.mocked(appServer.listTurns).mockImplementation(async params => ({ data: [{ id: 'first', items: [{
    type: 'userMessage', clientId: 'message', content: [textInput(String(params.threadId).startsWith('rank-common') ? '有个问题，现在已经需要排查发布版本。' : 'dns-api 的流水线停住了。')],
  }] }], nextCursor: null }) as never)
  expect(await routingExamples([textInput('dns-api 发布版本后有个问题，现在已经需要处理。')], candidates, { feedbackCount: 1, feedbackRule: 'relevant' })).toEqual([
    { request: 'dns-api 的流水线停住了。', wrong: null, correct: '/dns-api' },
  ])
})
it('ignores common phrases for relevance without changing the source text or the recent rule', async () => {
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [{ id: 'first', items: [{
    type: 'userMessage', clientId: 'message', content: [textInput('现在有个问题，已经需要排查。')],
  }] }] } as never)
  expect(await routingExamples([textInput('现在有个问题，已经需要处理。')], candidates)).toEqual([])
  expect(await routingExamples([textInput('现在有个问题，已经需要处理。')], candidates, { feedbackCount: 3, feedbackRule: 'recent' })).toEqual([
    { request: '现在有个问题，已经需要排查。', wrong: '/dns-agent', correct: '/dns-api' },
  ])
})
it('uses only shared-project examples when available while keeping recent mode unchanged', async () => {
  vi.mocked(runtime.routerCorrections).mockResolvedValue([
    { threadId: `scope-skills-${id}`, sourceTurnId: 'first', sourceMessageId: 'message', wrong: null, correct: '/dns-agent' },
    { threadId: `scope-dns-${id}`, sourceTurnId: 'first', sourceMessageId: 'message', wrong: null, correct: '/dns-api' },
  ])
  vi.mocked(appServer.listTurns).mockImplementation(async params => ({ data: [{ id: 'first', items: [{
    type: 'userMessage', clientId: 'message', content: [textInput(String(params.threadId).startsWith('scope-skills') ? 'skill 升级' : 'dns-api 流水线排查')],
  }] }], nextCursor: null }) as never)
  const input = [textInput('dns-api 发布收尾，顺带检查 skill 升级')]
  expect(await routingExamples(input, candidates)).toEqual([
    { request: 'dns-api 流水线排查', wrong: null, correct: '/dns-api' },
  ])
  expect(await routingExamples([textInput('skill 升级')], candidates)).toEqual([
    { request: 'skill 升级', wrong: null, correct: '/dns-agent' },
  ])
  expect(await routingExamples(input, candidates, { feedbackCount: 3, feedbackRule: 'recent' })).toEqual([
    { request: 'skill 升级', wrong: null, correct: '/dns-agent' },
    { request: 'dns-api 流水线排查', wrong: null, correct: '/dns-api' },
  ])
})
it('uses correction text when the saved message also contains an automatically loaded skill', async () => {
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [{ id: 'first', items: [{
    type: 'userMessage', clientId: 'message', content: [
      textInput('检查 DNS API 内存'),
      { type: 'skill', name: 'harness-runtime', path: '/skills/harness-runtime/SKILL.md' },
    ],
  }] }] } as never)
  expect(await routingExamples([textInput('DNS API 内存')], candidates)).toEqual([
    { request: '检查 DNS API 内存', wrong: '/dns-agent', correct: '/dns-api' },
  ])
})
it('does not substitute the wrong user message when the source cannot be resolved', async () => {
  vi.mocked(appServer.listTurns).mockResolvedValue({ data: [{ id: 'first', items: [{ type: 'userMessage', clientId: 'different', content: [textInput('DNS API')] }] }] } as never)
  expect(await routingExamples([textInput('DNS API')], candidates)).toEqual([])
})
it('skips image-dependent examples and tolerates missing provider history', async () => {
  vi.mocked(appServer.listTurns).mockResolvedValueOnce({ data: [{ id: 'first', items: [{ type: 'userMessage', clientId: 'message', content: [textInput('DNS API'), { type: 'skill', name: 'harness-runtime', path: '/skills/runtime/SKILL.md' }, { type: 'localImage', path: '/image.png' }] }] }] } as never)
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
it.each([3, 5, 10])('honors a configured count of %i and preserves recent-first ordering', async (limit) => {
  vi.mocked(runtime.routerCorrections).mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ threadId: `count-${id}-${i}`, sourceTurnId: 'first', sourceMessageId: 'message', wrong: '/dns-agent', correct: '/dns-api' })))
  vi.mocked(appServer.listTurns).mockImplementation(async params => ({ data: [{ id: 'first', items: [{ type: 'userMessage', clientId: 'message', content: [textInput(`DNS API case ${String(params.threadId).split('-').at(-1)}`)] }] }], nextCursor: null }) as never)
  const examples = await routingExamples([textInput('DNS API')], candidates, { feedbackCount: limit, feedbackRule: 'recent' })
  expect(examples.map(e => e.request)).toEqual(Array.from({ length: limit }, (_, i) => `DNS API case ${i}`))
})
